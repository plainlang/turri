import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { Command, MemorySaver } from "@langchain/langgraph";
import { compileSkill, type Reporter } from "./graph.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createExecutor } from "./pi.ts";
import { createLiveReviewer, type LiveReviewer } from "./review/live.ts";
import { loadSkill, readRubric, type Skill } from "./skill.ts";
import { createAskUserTool, createRenderTools, createWriteArtifactTool, type AskUser } from "./tools.ts";
import { createFunctionalSpecTools } from "./spec-tools.ts";

const WRITE_FUNCTIONAL_SPEC = "write_functional_spec";
import type { RenderQueue } from "./render/queue.ts";

export interface EscalationRequest {
  step: string;
  artifact: string;
  critique: string;
  question: string;
}

export interface RunSkillResult {
  skill: Skill;
  ok: boolean;
  artifacts: Record<string, string>;
  /** The last step's artifact - what the caller usually wants. */
  output: string;
}

/**
 * Run one skill to completion. The only entry point: the CLI and the Pi extension
 * both go through here, so a skill behaves identically whether a human launched it
 * or a conversational agent decided to.
 */
export async function runSkill(opts: {
  skillDir: string;
  cwd: string;
  runDir: string;
  report: Reporter;
  /** Called when a gate cannot be satisfied. Return true to accept the artifact anyway. */
  escalate: (request: EscalationRequest) => Promise<boolean>;
  /** Lets a step interview the user. Omitted: the skill runs with nobody to ask. */
  askUser?: AskUser;
  /** "provider/model-id" for the executor and the judges. Omitted: pi's default. */
  model?: string;
  /** Lets steps build functionalities in the background while the interview continues. */
  renderQueue?: RenderQueue;
  /** What the user has already said, so the skill does not re-ask it. */
  context?: string;
}): Promise<RunSkillResult> {
  const skill = loadSkill(opts.skillDir);
  const runDir = resolve(opts.runDir);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });

  // The executor has to exist before a reviewer can borrow its auth, and the reviewer has
  // to exist before the tools that report its findings. So the tool list is built in two
  // passes with a box the reviewer is dropped into once there is one.
  const liveReviewers = new Map<string, LiveReviewer>();
  const liveStep = skill.steps.find((step) => step.gate?.continuous !== undefined);
  const holder: { reviewer?: LiveReviewer } = {};
  const liveProxy: LiveReviewer | undefined =
    liveStep === undefined
      ? undefined
      : {
          notice: (scope) => holder.reviewer?.notice(scope),
          take: () => holder.reviewer?.take() ?? [],
          takeQuestions: () => holder.reviewer?.takeQuestions() ?? [],
          reply: (id, answer) => holder.reviewer?.reply(id, answer) ?? false,
          settle: async () => holder.reviewer?.settle() ?? { clean: true, findings: [] },
          history: () => holder.reviewer?.history() ?? [],
          passes: () => holder.reviewer?.passes() ?? 0,
        };

  const writeArtifact = createWriteArtifactTool(runDir);
  const customTools: ToolDefinition[] = [writeArtifact];

  // A skill that lists write_functional_spec gets it, and with it write and edit tools that
  // leave the functional specs alone - so every spec is built because of how it was
  // written, not because a separate call was remembered.
  const specs =
    opts.renderQueue !== undefined && skill.allowedTools.includes(WRITE_FUNCTIONAL_SPEC)
      ? createFunctionalSpecTools({ queue: opts.renderQueue, cwd: opts.cwd, liveReview: liveProxy })
      : undefined;

  if (opts.askUser !== undefined) customTools.push(createAskUserTool(opts.askUser, () => specs?.pace.answered()));
  if (opts.renderQueue !== undefined) {
    customTools.push(...createRenderTools(opts.renderQueue, opts.cwd, liveProxy));
  }
  if (specs !== undefined) customTools.push(...specs.tools);

  const names = customTools.map((tool) => tool.name);
  // Tools this harness provides are never pi built-ins, even when it did not provide them.
  const builtins = skill.allowedTools.filter((t) => !names.includes(t) && t !== WRITE_FUNCTIONAL_SPEC);
  const executor = await createExecutor({
    cwd: opts.cwd,
    customTools,
    tools: [...builtins, ...names],
    model: opts.model,
    // A skill writes specs; the rules it is held to are in its system prompt.
    rules: true,
  });

  if (liveStep !== undefined && liveProxy !== undefined) {
    const continuous = liveStep.gate!.continuous!;
    holder.reviewer = createLiveReviewer({
      cwd: opts.cwd,
      spec: continuous,
      rubric: readRubric(skill, continuous),
      executor,
      defaultModel: opts.model,
      onPass: (pass) => opts.report.livePass?.(liveStep.name, pass.scope, pass.findings),
    });
    liveReviewers.set(liveStep.name, liveProxy);
  }

  try {
    const app = compileSkill({
      skill,
      cwd: opts.cwd,
      runDir,
      executor,
      report: opts.report,
      model: opts.model,
      context: opts.context,
      liveReviewers,
    }).compile({
      checkpointer: new MemorySaver(),
    });
    const config = { configurable: { thread_id: `forge-${Date.now()}` }, recursionLimit: 50 };

    let result = await app.invoke({}, config);

    // Escalation surfaces as a LangGraph interrupt: the graph is paused, not
    // finished, and nothing advances until the handler answers.
    while (result.__interrupt__?.length) {
      const approved = await opts.escalate(result.__interrupt__[0].value as EscalationRequest);
      result = await app.invoke(new Command({ resume: { approved } }), config);
    }

    const artifacts: Record<string, string> = result.artifacts ?? {};
    const lastStep = skill.steps[skill.steps.length - 1]!.name;
    return {
      skill,
      ok: result.decision !== "abort",
      artifacts,
      output: artifacts[lastStep] ?? "",
    };
  } finally {
    executor.dispose();
  }
}

/** Human-readable one-liner per step, for logs and tool output. */
export function describeGates(skill: Skill): string[] {
  return skill.steps.map((s) => {
    if (!s.gate) return `${s.name} -> no gate`;
    const live = s.gate.continuous
      ? ` + continuous(${s.gate.continuous.rubric}, judges=${s.gate.continuous.judges})`
      : "";
    const r = s.gate.review;
    return `${s.name} -> gate(${r.rubric}, judges=${r.judges}, quorum=${r.quorum}, on_fail=${r.onFail}, max_retries=${r.maxRetries})${live}`;
  });
}

export type { Reporter };
