import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * The work, handed over for review: what the agent that did it says it did.
 *
 * A reviewer kept through a job reads the work once, then only what changed since - and a diff says what changed,
 * not why, nor which of the problems it raised a change answers, nor which ones the agent chose not to take up. So
 * the agent that did the work ends each turn that goes to review with an account: what it did, and for each problem
 * the last review raised, whether it fixed it or declined it, why, and where. The account is a claim: the reviewer
 * gets it beside the diff the harness takes itself, never instead of it, and checks the one against the other.
 */

export interface WorkAnswer {
  /** The problem's number, as the review's list gave it. */
  problem: number;
  outcome: "fixed" | "declined";
  why: string;
  files?: string[];
}

export interface WorkAccount {
  summary: string;
  answers: WorkAnswer[];
}

/** What the agent is told, at the end of its task: how it hands its work over. */
export const SUBMIT_WORK_NOTE = [
  "When you are done with a turn - the work written and its tests passing - call submit_work, last: a short summary of",
  "what you did and why, and after a review, an answer for each problem it raised - fixed, or declined and why. Its",
  "reviewer gets your account beside the diff of what you changed, and checks the one against the other: say what you",
  "did, not what you meant to.",
];

/** What the agent is told with a review's problems: how it answers them. */
export const SUBMIT_AFTER_REVIEW = [
  "Then call submit_work, last: an answer for each problem, by its number - fixed, or declined and why - and the files.",
];

/** The tool, and what was handed over through it since the harness last took it. */
export interface WorkLedger {
  tool: ToolDefinition;
  /** What was handed over since the last take, left where it is. */
  peek: () => WorkAccount[];
  /** What was handed over since the last take - and from now, nothing. */
  take: () => WorkAccount[];
}

export function createWorkLedger(): WorkLedger {
  let accounts: WorkAccount[] = [];
  const tool = defineTool({
    name: "submit_work",
    label: "Submit the work",
    description:
      "Hand your work over for review, last in a turn: a short summary of what you did, and for each problem a review " +
      "raised, by its number - fixed, or declined and why, and the files. The reviewer checks it against the diff.",
    promptSnippet: "hand the work over for review - what you did, and your answer to each problem raised",
    parameters: Type.Object({
      summary: Type.String({ description: "What you did in this turn and why, in a few sentences" }),
      answers: Type.Optional(
        Type.Array(
          Type.Object({
            problem: Type.Number({ description: "The problem's number in the review's list" }),
            outcome: Type.Union([Type.Literal("fixed"), Type.Literal("declined")]),
            why: Type.String({ description: "How you fixed it, or why you did not" }),
            files: Type.Optional(Type.Array(Type.String(), { description: "The files you changed for it" })),
          }),
          { description: "After a review: one answer for each problem it raised. Omit on a first turn." },
        ),
      ),
    }),
    async execute(_id, params) {
      accounts.push({ summary: params.summary, answers: (params.answers ?? []) as WorkAnswer[] });
      return { content: [{ type: "text" as const, text: "Handed over." }], details: {}, terminate: true };
    },
  }) as ToolDefinition;
  return {
    tool,
    peek: () => [...accounts],
    take() {
      const taken = accounts;
      accounts = [];
      return taken;
    },
  };
}

/** The problems, numbered from 1, that no account answered. */
export function unanswered(accounts: WorkAccount[], problems: number): number[] {
  const answered = new Set(accounts.flatMap((account) => account.answers.map((answer) => answer.problem)));
  return Array.from({ length: problems }, (_, index) => index + 1).filter((n) => !answered.has(n));
}

/** The prompt that sends the agent back once for the problems its account left out. */
export function unansweredPrompt(numbers: number[]): string {
  return [
    `Your account answers no problem ${numbers.join(", ")} of the review's list. For each: fix it, or say why not - then`,
    "call submit_work again, with an answer for each of them.",
  ].join("\n");
}

/** The accounts, for the reviewer: labelled as a claim, the problems they answer named. */
export function describeAccounts(accounts: WorkAccount[], problems?: Array<{ what: string }>): string {
  if (accounts.length === 0) return "(the agent that did the work gave no account - go by the diff)";
  return accounts
    .map((account) =>
      [
        account.summary.trim(),
        ...account.answers.map((answer) => {
          const problem = problems?.[answer.problem - 1];
          return `- problem ${answer.problem}${problem !== undefined ? ` (${problem.what.trim().slice(0, 160)})` : ""}: ${answer.outcome} - ${answer.why.trim()}${answer.files !== undefined && answer.files.length > 0 ? ` [${answer.files.join(", ")}]` : ""}`;
        }),
      ].join("\n"),
    )
    .join("\n\n");
}
