import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { ask, BEGIN, createJudge } from "../pi.ts";
import type { ContinuousSpec } from "../skill.ts";
import { createVerdictTool, type Verdict } from "../tools.ts";

/**
 * Review that runs beside the interview instead of after it.
 *
 * The interviewer writes a functional spec, queues it, and asks the next question. A
 * reviewer wakes on that same tick, reads what is now on disk, and either says nothing or
 * reports what is wrong with it. Findings come back through the next tool result the
 * interviewer gets, so they arrive between questions - the user is never left waiting on a
 * review, and a spec that is wrong is caught before four more are built on top of it.
 *
 * Two rules keep this honest:
 *
 * - The reviewer is read-only. It reports; the interviewer owns the file. Two agents
 *   editing the same `.plain` mid-interview would produce a file neither of them wrote.
 * - Passes are serial and coalesced. Ten specs written while one pass runs produce one
 *   further pass, not ten, and no two reviewers ever read the file at once.
 */

export interface LiveFinding {
  /** What was under review when this was found. */
  scope: string;
  criterion: string;
  evidence: string;
  fix: string;
}

/** Something the reviewer cannot settle from the files alone. */
export interface LiveQuestion {
  id: string;
  scope: string;
  question: string;
}

export interface LiveReviewer {
  /** Something was written. Schedules a pass; returns immediately. */
  notice(scope: string): void;
  /** Findings not yet handed to the interviewer. Draining marks them delivered. */
  take(): LiveFinding[];
  /** Questions the reviewer wants the user to answer, if any. */
  takeQuestions(): LiveQuestion[];
  /** Hands the user's answer back, to be carried into the next pass. */
  reply(questionId: string, answer: string): boolean;
  /** Waits for any pass in flight plus one final pass. Used by the phase gate. */
  settle(): Promise<{ clean: boolean; findings: LiveFinding[] }>;
  /** Everything found this phase, delivered or not. */
  history(): LiveFinding[];
  passes(): number;
}

interface LiveVerdict extends Verdict {
  question?: string;
}

function livePrompt(opts: {
  rubric: string;
  scope: string;
  cleared: string[];
  replies: string[];
}): string {
  return [
    "You are a reviewer reading work that is still being written. You did not write it and",
    "you have no stake in it. Judge what is on disk against the rubric only.",
    "",
    "<rubric>",
    opts.rubric,
    "</rubric>",
    "",
    `<under review>\n${opts.scope}\n</under review>`,
    "",
    opts.cleared.length > 0
      ? `<already cleared>\n${opts.cleared.join("\n")}\n</already cleared>\n\nDo not re-report anything about work listed here unless it has since changed.\n`
      : "",
    opts.replies.length > 0
      ? `<the user has since answered>\n${opts.replies.join("\n")}\n</the user has since answered>\n`
      : "",
    "Read the files yourself with the tools you have. Nothing has been pasted in for you.",
    "",
    "The work is unfinished by design: later parts of it have not been written yet. Judge",
    "only what is claimed to be under review. Never report something as missing because it",
    "has not been reached yet, and never ask for the phase to be finished.",
    "",
    "Call submit_verdict exactly once. Every violation must quote the offending text",
    "verbatim and name one concrete fix. If a violation cannot be settled from the files -",
    "it needs a decision only the user can make - put that single question in 'question'.",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

/** One review pass. Replaceable so the loop around it can be tested without a model. */
export type JudgePass = (prompt: string) => Promise<LiveVerdict | undefined>;

function defaultJudge(opts: {
  cwd: string;
  spec: ContinuousSpec;
  executor: AgentSession;
  defaultModel?: string;
}): JudgePass {
  return async (prompt) => {
    let captured: LiveVerdict | undefined;
    const { session } = await createJudge({
      cwd: opts.cwd,
      verdictTool: createVerdictTool((v) => {
        captured = v as LiveVerdict;
      }),
      modelSpec: opts.spec.model ?? opts.defaultModel,
      borrowAuthFrom: opts.executor,
      extraTools: opts.spec.judgeTools,
      task: prompt,
    });
    try {
      await ask(session, BEGIN);
    } finally {
      session.dispose();
    }
    return captured;
  };
}

export function createLiveReviewer(opts: {
  cwd: string;
  spec: ContinuousSpec;
  rubric: string;
  /** Auth and the default model come from the session running the interview. */
  executor?: AgentSession;
  defaultModel?: string;
  /** Called when a pass finishes, for the progress display. */
  onPass?: (result: { scope: string; findings: number }) => void;
  judge?: JudgePass;
}): LiveReviewer {
  const judge =
    opts.judge ??
    defaultJudge({
      cwd: opts.cwd,
      spec: opts.spec,
      executor: opts.executor!,
      defaultModel: opts.defaultModel,
    });
  const pending: LiveFinding[] = [];
  const all: LiveFinding[] = [];
  const questions: LiveQuestion[] = [];
  /** Every question ever asked, so an answer can arrive after it was handed over. */
  const asked = new Map<string, LiveQuestion>();
  const replies: string[] = [];
  const cleared: string[] = [];

  let dirty: string | null = null;
  let running: Promise<void> | null = null;
  let passes = 0;

  async function onePass(scope: string): Promise<void> {
    passes += 1;
    const captured = await judge(
      livePrompt({ rubric: opts.rubric, scope, cleared, replies: [...replies] }),
    );

    const violations = captured?.verdict === "fail" ? captured.violations : [];
    for (const v of violations) {
      const finding = { scope, criterion: v.criterion, evidence: v.evidence, fix: v.fix };
      pending.push(finding);
      all.push(finding);
    }

    // No verdict - its turn stopped before it gave one - clears nothing: the scope is looked at again next pass.
    if (captured !== undefined && violations.length === 0) {
      cleared.push(scope);
    } else if (captured?.question) {
      const question = { id: `q${asked.size + 1}`, scope, question: captured.question };
      asked.set(question.id, question);
      questions.push(question);
    }

    opts.onPass?.({ scope, findings: violations.length });
  }

  /**
   * One pass at a time, and only one queued behind it. A pass always reads the file as it
   * is when it starts, so the newest scope supersedes anything queued before it.
   */
  function pump(): void {
    if (running !== null || dirty === null) return;
    const scope = dirty;
    dirty = null;
    running = onePass(scope)
      // A reviewer that fell over must not take the interview down with it. The phase gate
      // still runs its own judges at the end, so nothing is silently skipped.
      .catch(() => {})
      .then(() => {
        running = null;
        pump();
      });
  }

  return {
    notice(scope) {
      dirty = scope;
      pump();
    },
    take() {
      return pending.splice(0, pending.length);
    },
    takeQuestions() {
      return questions.splice(0, questions.length);
    },
    reply(questionId, answer) {
      const question = asked.get(questionId);
      if (question === undefined) return false;
      replies.push(`${question.question} -> ${answer}`);
      return true;
    },
    async settle() {
      while (running !== null || dirty !== null) {
        if (running !== null) await running;
        pump();
      }
      const findings = [...pending];
      return { clean: findings.length === 0, findings };
    },
    history() {
      return [...all];
    },
    passes() {
      return passes;
    },
  };
}

export function describeFindings(findings: LiveFinding[]): string {
  const lines = findings.map((f) => `- [${f.scope}] ${f.criterion}: ${f.evidence} -> ${f.fix}`);
  return [
    `The reviewer reading along behind you found ${findings.length === 1 ? "something" : `${findings.length} things`}:`,
    ...lines,
    "",
    "Fix the specification now, before the next question, and re-queue anything already built " +
      "from it with regenerate: true. Do not argue with the review and do not write a reply - " +
      "edit the spec.",
  ].join("\n");
}

export function describeQuestions(questions: LiveQuestion[]): string {
  const lines = questions.map((q) => `- (${q.id}) ${q.question}`);
  return [
    "The reviewer needs the user to settle something it cannot decide from the specs:",
    ...lines,
    "",
    "Ask the user this with ask_user at your next turn, say it comes from the review, then " +
      "write the answer to disk and pass it back with reply_to_review.",
  ].join("\n");
}
