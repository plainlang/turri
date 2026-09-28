import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Annotation, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import { runGate, type GateOutcome } from "./judge.ts";
import { ask } from "./pi.ts";
import { describeFindings, type LiveReviewer } from "./review/live.ts";
import { readRubric, type Skill, type StepSpec } from "./skill.ts";

export type Decision = "advance" | "retry" | "escalate" | "abort";

export const ForgeState = Annotation.Root({
  artifacts: Annotation<Record<string, string>>({
    reducer: (a, b) => ({ ...a, ...b }),
    default: () => ({}),
  }),
  attempts: Annotation<Record<string, number>>({
    reducer: (a, b) => ({ ...a, ...b }),
    default: () => ({}),
  }),
  /** Judge feedback for the step currently being retried. */
  critique: Annotation<string>({ reducer: (_a, b) => b, default: () => "" }),
  decision: Annotation<Decision>({ reducer: (_a, b) => b, default: () => "advance" }),
});

export type ForgeStateType = typeof ForgeState.State;

export interface Reporter {
  step(name: string, attempt: number): void;
  artifact(path: string, body: string): void;
  gate(name: string, judges: number): void;
  /** One continuous-review pass finished while the step was still running. */
  livePass?(step: string, scope: string, findings: number): void;
  /** The continuous reviewer's closing word, read at the gate. */
  liveReview?(name: string, passes: number, findings: number): void;
  judge(index: number, model: string, verdict: string, violations: number): void;
  outcome(name: string, decision: Decision, critique: string): void;
}

const stepNode = (s: string) => `step.${s}`;
const gateNode = (s: string) => `gate.${s}`;
const escalateNode = (s: string) => `escalate.${s}`;

/** Where the executor is required to put this step's deliverable. */
const artifactPath = (step: StepSpec) => `${step.name}.md`;

/**
 * The prompt for a step picked up after the run was interrupted part-way through it. The
 * session is the one that was running, so the step's instructions and everything said so far
 * are already in it; what the agent needs is to know it stopped, and to look before it acts.
 */
function resumePrompt(step: StepSpec): string {
  return [
    `This skill run was interrupted during step '${step.name}' and has been resumed. Your session is as`,
    "it was when it stopped.",
    "",
    "Check what is already on disk before doing anything - the specs written so far, and any artifact -",
    "and continue the step from where it stopped. Do not redo what is done, and do not ask the user again",
    "for anything they have already answered.",
    step.gate ? `\nWhen the step is done, call write_artifact with path "${artifactPath(step)}" as before.` : "",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function stepPrompt(skill: Skill, step: StepSpec, critique: string, context?: string): string {
  if (critique) {
    return [
      `Your previous attempt at step '${step.name}' was rejected by review.`,
      "",
      "<violations>",
      critique,
      "</violations>",
      "",
      "Fix every violation and call write_artifact again with the same path.",
      "Do not argue with the review and do not explain yourself - rewrite the artifact.",
    ].join("\n");
  }
  return [
    `You are executing step '${step.name}' of the skill '${skill.name}'.`,
    "",
    // A skill runs in its own session and has never seen the conversation that led here.
    // Without this it re-asks what the person has already said, which reads as the skill
    // not listening.
    context
      ? `<what the user has already said>\n${context}\n</what the user has already said>\n\nTake this as given. Do not ask again for anything it already answers; confirm it in one line and move to what is still unknown.\n`
      : "",
    step.instructions,
    "",
    // What the step names by path - its references, another skill to follow - is found from here.
    `This skill's own files are in ${skill.dir}: a path its steps name, such as references/<file>.md, is there. ` +
      `A skill it says to follow is beside it, in ${dirname(skill.dir)}/<skill name>/SKILL.md - read it and follow it.`,
    "",
    // The artifact exists for the gate's judges to read. Without a gate nothing reads it,
    // and asking for one is a tool call spent on a file no one opens.
    step.gate
      ? `When you are done, call write_artifact with path "${artifactPath(step)}" holding the record the review will be checked against.`
      : "",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

export function compileSkill(opts: {
  skill: Skill;
  cwd: string;
  runDir: string;
  executor: AgentSession;
  report: Reporter;
  /** Default model for the judges, when a gate does not name one of its own. */
  model?: string;
  /** What the user has already said, carried in from the conversation that started this. */
  context?: string;
  /** Reviewers already reading along, by step name. Their findings gate the step too. */
  liveReviewers?: Map<string, LiveReviewer>;
  /** Start at this step instead of the first: a resumed run, picking up where it stopped. */
  startAt?: string;
  /** Called as each step starts, with the state it starts from - what a resumed run restores. */
  onStepStart?: (step: string, state: ForgeStateType) => void;
}) {
  const { skill, report } = opts;
  const graph = new StateGraph(ForgeState) as any;
  // The step being resumed is told it was interrupted - once. A retry after its gate is an
  // ordinary retry.
  let resuming = opts.startAt;

  skill.steps.forEach((step, index) => {
    const nextNode = index + 1 < skill.steps.length ? stepNode(skill.steps[index + 1]!.name) : END;

    graph.addNode(stepNode(step.name), async (state: ForgeStateType) => {
      opts.onStepStart?.(step.name, state);
      const attempt = (state.attempts[step.name] ?? 0) + 1;
      report.step(step.name, attempt);
      // Only the first step needs it: the executor keeps one session across every step,
      // so it is already in the history by the time the second runs.
      const context = index === 0 ? opts.context : undefined;
      const prompt =
        resuming === step.name && !state.critique ? resumePrompt(step) : stepPrompt(skill, step, state.critique, context);
      resuming = undefined;
      await ask(opts.executor, prompt);

      let artifact = "";
      try {
        artifact = readFileSync(join(opts.runDir, artifactPath(step)), "utf8").trim();
      } catch {
        // Left empty on purpose: the gate treats a missing artifact as a failure.
      }
      if (artifact) report.artifact(artifactPath(step), artifact);

      return {
        artifacts: { [step.name]: artifact },
        attempts: { [step.name]: attempt },
        critique: "",
      };
    });

    if (!step.gate) {
      graph.addEdge(stepNode(step.name), nextNode);
      return;
    }

    const review = step.gate.review;
    const rubric = readRubric(skill, review);

    graph.addNode(gateNode(step.name), async (state: ForgeStateType) => {
      const artifact = state.artifacts[step.name] ?? "";

      // A reviewer that has been reading along all phase gets the last word before the
      // judges are spent: it has seen every spec as it landed, and anything it is still
      // unhappy about is a violation the step has to fix whatever the record says.
      const live = opts.liveReviewers?.get(step.name);
      if (live !== undefined) {
        const settled = await live.settle();
        report.liveReview?.(step.name, live.passes(), settled.findings.length);
        if (!settled.clean) {
          const attempts = state.attempts[step.name] ?? 1;
          const decision: Decision =
            review.onFail === "abort"
              ? "abort"
              : review.onFail === "retry" && attempts <= review.maxRetries
                ? "retry"
                : "escalate";
          const critique = describeFindings(settled.findings);
          report.outcome(step.name, decision, critique);
          return { decision, critique };
        }
      }

      let outcome: GateOutcome;
      if (!artifact) {
        // No judges needed - the step did not produce the thing it was asked to produce.
        outcome = {
          passed: false,
          results: [],
          critique: `- You never called write_artifact with path "${artifactPath(step)}", so there is nothing to review.`,
        };
        report.gate(step.name, 0);
      } else {
        report.gate(step.name, review.judges);
        outcome = await runGate({
          cwd: opts.cwd,
          review,
          defaultModel: opts.model,
          rubric,
          artifactPath: artifactPath(step),
          artifact,
          executor: opts.executor,
          onJudgeStart: () => {},
        });
        for (const r of outcome.results) {
          report.judge(r.index, r.model, r.verdict?.verdict ?? "no verdict", r.verdict?.violations.length ?? 0);
        }
      }

      const attempts = state.attempts[step.name] ?? 1;
      const retriesLeft = attempts <= review.maxRetries;

      let decision: Decision;
      if (outcome.passed) decision = "advance";
      else if (review.onFail === "abort") decision = "abort";
      else if (review.onFail === "retry" && retriesLeft) decision = "retry";
      else decision = "escalate";

      report.outcome(step.name, decision, outcome.critique);
      // The critique is for this step's retry; the next step starts fresh.
      return { decision, critique: decision === "advance" ? "" : outcome.critique };
    });

    graph.addNode(escalateNode(step.name), async (state: ForgeStateType) => {
      const answer = interrupt({
        step: step.name,
        artifact: state.artifacts[step.name] ?? "",
        critique: state.critique,
        question: `Review gate on '${step.name}' could not be satisfied. Accept the artifact anyway?`,
      }) as { approved?: boolean } | boolean | undefined;

      const approved = typeof answer === "boolean" ? answer : Boolean(answer?.approved);
      // Accepted, the rejection stays with this step - the next one must not take it for its own.
      return approved ? { decision: "advance" as const, critique: "" } : { decision: "abort" as const };
    });

    graph.addEdge(stepNode(step.name), gateNode(step.name));

    const route = (state: ForgeStateType) => {
      if (state.decision === "advance") return nextNode;
      if (state.decision === "retry") return stepNode(step.name);
      if (state.decision === "escalate") return escalateNode(step.name);
      return END;
    };

    graph.addConditionalEdges(gateNode(step.name), route, [
      nextNode,
      stepNode(step.name),
      escalateNode(step.name),
      END,
    ]);
    graph.addConditionalEdges(
      escalateNode(step.name),
      (state: ForgeStateType) => (state.decision === "advance" ? nextNode : END),
      [nextNode, END],
    );
  });

  // Every step is a possible entry point, so none is unreachable when a resumed run starts
  // part-way through; which one is taken is decided here.
  const first = opts.startAt !== undefined && skill.steps.some((s) => s.name === opts.startAt) ? opts.startAt : skill.steps[0]!.name;
  graph.addConditionalEdges(START, () => stepNode(first), skill.steps.map((s) => stepNode(s.name)));
  return graph;
}
