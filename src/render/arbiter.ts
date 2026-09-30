import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ask, BEGIN, createExecutor } from "../pi.ts";
import { confinedTools } from "./confine.ts";
import { REVIEWER_CALLS } from "./conformance-agents.ts";

/**
 * The arbiter: the third voice in a review. The coding agent writes the tests; the reviewer - exacting,
 * opinionated, hard to satisfy - sends them back with everything it finds; from the second review that sends
 * them back, the arbiter weighs what it found before any of it goes back. It is the distinguished engineer
 * who balances the trade-offs: the tests have to be good, and time lost chasing perfect ones is lost too. It
 * upholds a problem when the reviewer is right - a behaviour the spec states is untested, or a test cannot
 * fail - and dismisses it when it is out of scope or a nitpick. Only what it upholds goes back; when it upholds
 * nothing, the tests are approved as they are. Read-only, like the reviewer.
 */

/** From the how-manieth review that sends the tests back the arbiter weighs each one. */
export const ARBITER_AFTER = 2;
/** How many reviews at most: past them, whatever is still found is let go, and the work goes on. */
export const REVIEW_LIMIT = 3;

/** A problem a review raised: in the unit tests or the conformance tests alike. */
export interface ReviewedProblem {
  file: string;
  test?: string;
  /** "wrong" is the code's: it does not do what the spec says. The unit review raises it; the conformance review does not. */
  kind: "missing" | "bad" | "wrong";
  what: string;
  blocking?: boolean;
}

/** What the arbiter ruled: the problems it upholds, and those it lets go, each with why. */
export interface ArbiterRuling<P extends ReviewedProblem = ReviewedProblem> {
  upheld: Array<{ problem: P; why: string }>;
  dismissed: Array<{ problem: P; why: string }>;
}

export interface ArbiterOptions<P extends ReviewedProblem> {
  /** "the unit tests of functionality 3", "the conformance tests of the spec change". */
  subject: string;
  /** Where it works, and what it may read: the tests and the code. */
  workdir: string;
  read: string[];
  /** When a problem is upheld: what the tests must do for this kind of review. */
  uphold: string[];
  /** The test files the work added or changed. */
  changed: string[];
  /** The specification the work built, as the reviewer had it - shown as it is given. */
  spec: string;
  /** What the work wrote: the diff of its folder from where it started (`workDiff`). */
  code?: string;
  /** The problems the latest review raised. */
  problems: P[];
  /** What each review before sent back, oldest first. */
  history: P[][];
  label: string;
  model?: string;
  onDelta?: (delta: string) => void;
}

export function problemLine(problem: ReviewedProblem): string {
  return `${problem.blocking === true ? "BLOCKING · " : ""}${problem.kind.toUpperCase()} · ${problem.file}${problem.test ? ` · ${problem.test}` : ""}: ${problem.what.trim()}`;
}

/** The arbiter's prompt: the spec, the reviews so far, and the latest one's problems, numbered. */
export function arbiterPrompt<P extends ReviewedProblem>(options: Omit<ArbiterOptions<P>, "label" | "model" | "onDelta">): string {
  return [
    `You are the arbiter of ${options.subject}: the distinguished engineer who has the last word on their review.`,
    "The tests pass. A reviewer - exacting, opinionated, hard to satisfy - has sent the work back",
    `${options.history.length} times, and has sent it back again. Weigh what it found, as the engineer who balances`,
    "the trade-offs: the work has to be right and its tests good, and time lost chasing perfect ones is lost too.",
    "",
    `The tests and the code are in ${options.read.join(" and ")}. Read them; change nothing.`,
    "",
    "For each problem the reviewer raised this time, rule:",
    ...options.uphold,
    "- dismiss it when it is out of scope - something the specification does not state for this work, a page or a",
    "  component only a definition names, how the code works inside rather than what it does - or a nitpick: a",
    "  test that already tests the behaviour, made a little stronger, another case of one already covered, a",
    "  matter of style, code written another way than the reviewer would have that does what the specification",
    "  says. Dismissed, it is let go.",
    "When you uphold nothing, the work is approved as it is. Say in one line, for each problem, why.",
    "",
    ...(options.history.length > 0
      ? [
          "<the reviews before, oldest first - what each sent back, and the tests were worked on since>",
          ...options.history.map((problems, index) => `review ${index + 1}:\n${problems.map((problem) => `  - ${problemLine(problem)}`).join("\n")}`),
          "</the reviews before>",
          "",
        ]
      : []),
    "<the problems it raised now>",
    ...options.problems.map((problem, index) => `${index + 1}. ${problemLine(problem)}`),
    "</the problems it raised now>",
    "",
    "<tests added or changed>",
    options.changed.length > 0 ? options.changed.join("\n") : "(none)",
    "</tests added or changed>",
    "",
    options.spec.trim(),
    "",
    ...(options.code !== undefined
      ? [
          "<the code this work wrote - a diff from where the work started, new files whole>",
          options.code.trim() !== "" ? options.code.trim() : "(nothing)",
          "</the code this work wrote>",
          "",
        ]
      : []),
    "Then call submit_ruling once, with every problem by its number: upheld, or dismissed.",
  ].join("\n");
}

/** The arbiter's ruling on the latest review - or nothing, when it gave none: the review then stands. */
export async function arbitrateReview<P extends ReviewedProblem>(options: ArbiterOptions<P>): Promise<ArbiterRuling<P> | undefined> {
  let ruling: ArbiterRuling<P> | undefined;
  const submit = defineTool({
    name: "submit_ruling",
    label: "Submit the ruling",
    description: "Rule on every problem the reviewer raised, by its number: upheld, or dismissed, each with why. Call this once.",
    parameters: Type.Object({
      rulings: Type.Array(
        Type.Object({
          problem: Type.Number({ description: "The problem's number" }),
          uphold: Type.Boolean({ description: "True: the reviewer is right, the tests are fixed for it. False: dismissed, let go" }),
          why: Type.String({ description: "In one line, why" }),
        }),
      ),
    }),
    async execute(_id, params) {
      const given = (params as { rulings: Array<{ problem: number; uphold: boolean; why: string }> }).rulings;
      const numbers = new Set(given.map((entry) => entry.problem));
      const missing = options.problems.map((_, index) => index + 1).filter((number) => !numbers.has(number));
      if (missing.length > 0) {
        return { content: [{ type: "text" as const, text: `Rule on every problem: ${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} no ruling.` }], details: {} };
      }
      const ruled = given
        .filter((entry) => options.problems[entry.problem - 1] !== undefined)
        .map((entry) => ({ problem: options.problems[entry.problem - 1]!, why: entry.why, uphold: entry.uphold }));
      ruling = {
        upheld: ruled.filter((entry) => entry.uphold).map(({ problem, why }) => ({ problem, why })),
        dismissed: ruled.filter((entry) => !entry.uphold).map(({ problem, why }) => ({ problem, why })),
      };
      return { content: [{ type: "text" as const, text: "Recorded." }], details: {}, terminate: true };
    },
  }) as ToolDefinition;
  const fence = confinedTools({ workdir: options.workdir, read: options.read, write: [], noBash: true });
  const session = await createExecutor({
    cwd: options.workdir,
    customTools: [submit, ...fence.tools],
    tools: [...fence.names, "submit_ruling"],
    model: options.model,
    label: `${options.label} arbiter`,
    system: fence.note,
    task: arbiterPrompt(options),
    budget: { calls: REVIEWER_CALLS, finish: ["submit_ruling"] },
  });
  try {
    await ask(session, BEGIN, options.onDelta);
    if (ruling === undefined) await ask(session, "You have not called submit_ruling. Call it now, with every problem by its number.", options.onDelta);
  } finally {
    session.dispose();
  }
  return ruling;
}

/** What the arbiter let go, for the working notes' pitfalls. */
export function dismissedNote(ruling: ArbiterRuling, what: string): string {
  return `the arbiter let go what the ${what} review raised: ${ruling.dismissed
    .map((entry) => `${entry.problem.file}${entry.problem.test ? ` ${entry.problem.test}` : ""}: ${entry.problem.what.trim()} - ${entry.why.trim()}`)
    .join("; ")
    .slice(0, 600)}`;
}
