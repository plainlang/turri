import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command, MemorySaver } from "@langchain/langgraph";
import { compileSkill, type Reporter } from "./graph.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createExecutor } from "./pi.ts";
import { describeToolCall, describeToolResult } from "./render/activity.ts";
import { createLiveReviewer, type LiveReviewer } from "./review/live.ts";
import { loadSkill, readRubric, type Skill } from "./skill.ts";
import { createAskUserTool, createRenderTools, createWriteArtifactTool, type AskUser } from "./tools.ts";
import { createSpecDiffTools } from "./spec-tools.ts";
import { createTemperTools, TEMPER_TOOLS } from "./temper-tools.ts";
import type { JobRegistry } from "./render/jobs.ts";

const WRITE_SPEC_DIFF = "write_spec_diff";
/** How much of what the agent said before a question is shown with it: its end, where the brief is. */
const SAID_MAX = 6000;
import type { WorkLoop } from "./render/loop.ts";

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
  renderQueue?: WorkLoop;
  /** What the user has already said, so the skill does not re-ask it. */
  context?: string;
  /** Pick up the run of this skill that was interrupted here, rather than start a new one. */
  resume?: boolean;
  /**
   * Tools the conversation's agent has that the skill's agent needs as well, because the person
   * talks to the skill's agent while it runs - choosing the render model, for one.
   */
  sharedTools?: ToolDefinition[];
  /** The jobs the render queue runs, for a skill that waits for its builds and reads what they recorded. */
  jobs?: JobRegistry;
}): Promise<RunSkillResult> {
  const skill = loadSkill(opts.skillDir);
  const runDir = resolve(opts.runDir);

  // A resumed run keeps its folder - the artifacts are in it - and starts where it stopped.
  let resumed: RunManifest | undefined;
  if (opts.resume === true) {
    resumed = readManifest(runDir);
    if (resumed === undefined || resumed.skill !== skill.name || resumed.status !== "running") {
      throw new Error(
        resumed === undefined || resumed.skill !== skill.name
          ? `There is no interrupted run of ${skill.name} to resume here.`
          : `The last run of ${skill.name} here ${resumed.status === "finished" ? "finished" : "was stopped"}; there is nothing to resume.`,
      );
    }
  } else {
    rmSync(runDir, { recursive: true, force: true });
  }
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

  // A skill whose unit of work is a spec change gets write_spec_diff: the change is applied
  // and its build queued in one step.
  const diffs =
    opts.renderQueue !== undefined && skill.allowedTools.includes(WRITE_SPEC_DIFF)
      ? createSpecDiffTools({ loop: opts.renderQueue, cwd: opts.cwd, liveReview: liveProxy, paced: skill.paced })
      : undefined;

  // What the agent says between its questions - a brief to confirm, a plan - reaches the person only with
  // the next question: the session it talks in is its own, and nobody reads it.
  let said = "";
  if (opts.askUser !== undefined) {
    customTools.push(
      createAskUserTool(
        opts.askUser,
        () => {
          said = "";
          diffs?.pace.answered();
        },
        () => said,
      ),
    );
  }
  if (opts.renderQueue !== undefined) {
    customTools.push(...createRenderTools(opts.renderQueue, liveProxy));
  }
  if (diffs !== undefined) customTools.push(...diffs.tools);
  // A skill that builds what the spec holds, waits for it, and reads back where the builds had to guess.
  if (opts.renderQueue !== undefined && opts.jobs !== undefined && skill.allowedTools.some((tool) => TEMPER_TOOLS.includes(tool))) {
    customTools.push(...createTemperTools({ loop: opts.renderQueue, jobs: opts.jobs, cwd: opts.cwd }));
  }
  customTools.push(...(opts.sharedTools ?? []));

  const names = customTools.map((tool) => tool.name);
  // Tools this harness provides are never pi built-ins, even when it did not provide them.
  const builtins = skill.allowedTools.filter(
    (t) => !names.includes(t) && t !== WRITE_SPEC_DIFF && !TEMPER_TOOLS.includes(t),
  );
  const executor = await createExecutor({
    cwd: opts.cwd,
    customTools,
    tools: [...builtins, ...names],
    model: opts.model,
    // A skill writes specs; the rules it is held to are in its system prompt.
    rules: true,
    resumeFrom: resumed?.sessionFile,
  });

  const manifest: RunManifest = resumed ?? {
    skill: skill.name,
    status: "running",
    artifacts: {},
    attempts: {},
    updatedAt: "",
  };
  // What the agent does, as it does it: its session is its own, so without this a long step is silence.
  executor.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      opts.report.activity?.(describeToolCall(event.toolName, event.args as Record<string, unknown> | undefined));
      return;
    }
    if (event.type === "tool_execution_end") {
      const line = describeToolResult(event.toolName, event.result, event.isError);
      if (line !== undefined) opts.report.activity?.(line);
      return;
    }
    if (event.type !== "message_update") return;
    const update = event.assistantMessageEvent;
    if (update.type === "text_start") {
      if (said.trim() !== "") said += "\n\n";
      opts.report.said?.("", true);
    } else if (update.type === "text_delta") {
      said = (said + update.delta).slice(-SAID_MAX);
      opts.report.said?.(update.delta, false);
    }
  });
  manifest.sessionFile = executor.sessionFile;
  writeManifest(runDir, manifest);

  // Built renders were lost with the process; queue what the specs hold that is not built.
  if (resumed !== undefined && opts.renderQueue !== undefined) {
    for (const file of plainFilesIn(opts.cwd)) void opts.renderQueue.bringUp(file).catch(() => undefined);
  }

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
      startAt: resumed?.step,
      // Where the run is, written as each step starts: what a resume picks up from.
      onStepStart: (step, state) => {
        manifest.step = step;
        manifest.artifacts = state.artifacts;
        manifest.attempts = state.attempts;
        writeManifest(runDir, manifest);
      },
    }).compile({
      checkpointer: new MemorySaver(),
    });
    const config = { configurable: { thread_id: `forge-${Date.now()}` }, recursionLimit: 50 };

    let result = await app.invoke(
      resumed !== undefined ? { artifacts: resumed.artifacts, attempts: resumed.attempts } : {},
      config,
    );

    // Escalation surfaces as a LangGraph interrupt: the graph is paused, not
    // finished, and nothing advances until the handler answers.
    while (result.__interrupt__?.length) {
      const approved = await opts.escalate(result.__interrupt__[0].value as EscalationRequest);
      result = await app.invoke(new Command({ resume: { approved } }), config);
    }

    const artifacts: Record<string, string> = result.artifacts ?? {};
    const lastStep = skill.steps[skill.steps.length - 1]!.name;
    manifest.status = result.decision === "abort" ? "stopped" : "finished";
    writeManifest(runDir, manifest);
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

/**
 * Where a skill run is, kept in its run folder: enough to pick it up after the process that
 * ran it is gone - the agent's saved session, the step it was in, and the state that step
 * started from. Written as each step starts; `status` stays "running" until the run ends.
 */
interface RunManifest {
  skill: string;
  status: "running" | "finished" | "stopped";
  sessionFile?: string;
  step?: string;
  artifacts: Record<string, string>;
  attempts: Record<string, number>;
  updatedAt: string;
}

const MANIFEST = "run.json";

function readManifest(runDir: string): RunManifest | undefined {
  try {
    return JSON.parse(readFileSync(join(runDir, MANIFEST), "utf8")) as RunManifest;
  } catch {
    return undefined;
  }
}

function writeManifest(runDir: string, manifest: RunManifest): void {
  manifest.updatedAt = new Date().toISOString();
  writeFileSync(join(runDir, MANIFEST), JSON.stringify(manifest, null, 2));
}

/** The .plain files at the top of a project. */
function plainFilesIn(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".plain"))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/** Whether there is a run of this skill here that was interrupted, and could be resumed. */
export function interruptedRun(runDir: string, skillName: string): { step?: string; updatedAt: string } | undefined {
  const manifest = readManifest(resolve(runDir));
  return manifest?.skill === skillName && manifest.status === "running"
    ? { step: manifest.step, updatedAt: manifest.updatedAt }
    : undefined;
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
