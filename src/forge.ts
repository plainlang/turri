import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { Command, MemorySaver } from "@langchain/langgraph";
import { compileSkill, type Reporter } from "./graph.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createExecutor } from "./pi.ts";
import { loadSkill, type Skill } from "./skill.ts";
import { createAskUserTool, createWriteArtifactTool, type AskUser } from "./tools.ts";

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
}): Promise<RunSkillResult> {
  const skill = loadSkill(opts.skillDir);
  const runDir = resolve(opts.runDir);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });

  const writeArtifact = createWriteArtifactTool(runDir);
  const customTools: ToolDefinition[] = [writeArtifact];
  if (opts.askUser !== undefined) customTools.push(createAskUserTool(opts.askUser));

  const names = customTools.map((tool) => tool.name);
  const builtins = skill.allowedTools.filter((t) => !names.includes(t));
  const executor = await createExecutor({
    cwd: opts.cwd,
    customTools,
    tools: [...builtins, ...names],
  });

  try {
    const app = compileSkill({ skill, cwd: opts.cwd, runDir, executor, report: opts.report }).compile({
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
  return skill.steps.map((s) =>
    s.gate
      ? `${s.name} -> gate(${s.gate.review.rubric}, judges=${s.gate.review.judges}, quorum=${s.gate.review.quorum}, on_fail=${s.gate.review.onFail}, max_retries=${s.gate.review.maxRetries})`
      : `${s.name} -> no gate`,
  );
}

export type { Reporter };
