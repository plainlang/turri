import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { ask, BEGIN, createJudge } from "./pi.ts";
import { createVerdictTool, type Verdict } from "./tools.ts";
import type { ReviewSpec } from "./skill.ts";

export interface JudgeResult {
  index: number;
  model: string;
  verdict: Verdict | undefined;
}

export interface GateOutcome {
  passed: boolean;
  results: JudgeResult[];
  /** Feedback handed back to the executor on retry. Empty when the gate passed. */
  critique: string;
}

function judgePrompt(rubric: string, artifactPath: string, artifact: string): string {
  return [
    "You are a reviewer. You did not write the artifact below and you have no stake in it.",
    "Judge it against the rubric only. Do not infer intent, do not give credit for effort,",
    "and do not soften a violation because the rest is good.",
    "",
    "<rubric>",
    rubric,
    "</rubric>",
    "",
    `<artifact path="${artifactPath}">`,
    artifact,
    "</artifact>",
    "",
    "Call submit_verdict exactly once. Every violation must quote the offending text verbatim.",
    "Where the rubric asks about files rather than about the text above, read them yourself.",
  ].join("\n");
}

export async function runGate(opts: {
  cwd: string;
  review: ReviewSpec;
  rubric: string;
  artifactPath: string;
  artifact: string;
  executor: AgentSession;
  /** Used when the gate does not name a model - normally the conversation's. */
  defaultModel?: string;
  onJudgeStart?: (index: number, model: string) => void;
}): Promise<GateOutcome> {
  const { review } = opts;

  const results = await Promise.all(
    Array.from({ length: review.judges }, async (_, index): Promise<JudgeResult> => {
      let captured: Verdict | undefined;
      const { session, modelNote } = await createJudge({
        cwd: opts.cwd,
        verdictTool: createVerdictTool((v) => {
          captured = v;
        }),
        modelSpec: review.model ?? opts.defaultModel,
        borrowAuthFrom: opts.executor,
        extraTools: review.judgeTools,
        task: judgePrompt(opts.rubric, opts.artifactPath, opts.artifact),
      });
      opts.onJudgeStart?.(index, modelNote);
      try {
        await ask(session, BEGIN);
      } finally {
        session.dispose();
      }
      return { index, model: modelNote, verdict: captured };
    }),
  );

  // A judge that returned no verdict counts as a fail. Silence is not consent.
  const passes = results.filter((r) => r.verdict?.verdict === "pass").length;
  const passed =
    review.quorum === "all"
      ? passes === results.length
      : review.quorum === "majority"
        ? passes * 2 > results.length
        : passes > 0;

  const critique = passed
    ? ""
    : results
        .flatMap((r) => {
          if (!r.verdict) return [`- judge ${r.index + 1} returned no verdict; treat as a failure and re-check the rubric yourself`];
          return r.verdict.violations.map((v) => `- [${v.criterion}] found: ${v.evidence} -> ${v.fix}`);
        })
        .filter((line, i, all) => all.indexOf(line) === i)
        .join("\n");

  return { passed, results, critique };
}
