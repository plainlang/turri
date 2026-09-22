import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Annotation, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import { runGate, type GateOutcome } from "./judge.ts";
import { ask } from "./pi.ts";
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
  judge(index: number, model: string, verdict: string, violations: number): void;
  outcome(name: string, decision: Decision, critique: string): void;
}

const stepNode = (s: string) => `step.${s}`;
const gateNode = (s: string) => `gate.${s}`;
const escalateNode = (s: string) => `escalate.${s}`;

/** Where the executor is required to put this step's deliverable. */
const artifactPath = (step: StepSpec) => `${step.name}.md`;

function stepPrompt(skill: Skill, step: StepSpec, critique: string): string {
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
    step.instructions,
    "",
    `When you are done, call write_artifact with path "${artifactPath(step)}".`,
  ].join("\n");
}

export function compileSkill(opts: {
  skill: Skill;
  cwd: string;
  runDir: string;
  executor: AgentSession;
  report: Reporter;
  /** Default model for the judges, when a gate does not name one of its own. */
  model?: string;
}) {
  const { skill, report } = opts;
  const graph = new StateGraph(ForgeState) as any;

  skill.steps.forEach((step, index) => {
    const nextNode = index + 1 < skill.steps.length ? stepNode(skill.steps[index + 1]!.name) : END;

    graph.addNode(stepNode(step.name), async (state: ForgeStateType) => {
      const attempt = (state.attempts[step.name] ?? 0) + 1;
      report.step(step.name, attempt);
      await ask(opts.executor, stepPrompt(skill, step, state.critique));

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
      return { decision, critique: outcome.critique };
    });

    graph.addNode(escalateNode(step.name), async (state: ForgeStateType) => {
      const answer = interrupt({
        step: step.name,
        artifact: state.artifacts[step.name] ?? "",
        critique: state.critique,
        question: `Review gate on '${step.name}' could not be satisfied. Accept the artifact anyway?`,
      }) as { approved?: boolean } | boolean | undefined;

      const approved = typeof answer === "boolean" ? answer : Boolean(answer?.approved);
      return { decision: approved ? ("advance" as const) : ("abort" as const) };
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

  graph.addEdge(START, stepNode(skill.steps[0]!.name));
  return graph;
}
