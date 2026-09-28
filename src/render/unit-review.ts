import { basename } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ask, createExecutor } from "../pi.ts";
import { reportActivity } from "./activity.ts";
import { diffFiles, digestFiles } from "./codebase.ts";
import { confinedTools } from "./confine.ts";
import { REVIEWER_CALLS, reviewKind } from "./conformance-agents.ts";
import { recordNote } from "./notes.ts";
import { INTEGRITY_RULES } from "./prompt.ts";
import { TEST_FILE_PATTERN } from "./testing.ts";

/**
 * The unit tests' review: after they pass, do they test anything?
 *
 * A passing unit suite proves only what its tests check, and a coding agent is quick to write tests
 * that check next to nothing - that a function exists, that it returns something, that a status is
 * 200 - and pass whatever the code does. So once the unit testing script passes, a reviewer reads the
 * unit tests the work added or changed, beside the code and the spec, and says what is missing and
 * what is weak. It changes nothing. Its problems go back to the coding agent, the unit testing script
 * runs again, and the review looks again - as the conformance tests are reviewed. A problem that
 * leaves a behaviour of the spec untested is never let go; the rest, ways to make tests that already
 * test it better, are let go after REVIEW_ROUNDS reviews, and kept in the notes.
 */

/** What the review found wrong with the unit tests. */
export interface UnitReviewProblem {
  file: string;
  test?: string;
  kind: "missing" | "bad";
  what: string;
  /**
   * A behaviour the spec states is not yet tested: no test for it, or one that cannot fail - it only
   * checks that something exists, asserts nothing, mocks the unit it tests, is skipped. Never let go.
   */
  blocking?: boolean;
}

/** How many reviews may send the unit tests back before what they still suggest - nothing blocking - is let go. */
export const UNIT_REVIEW_ROUNDS = 5;
/** How many reviews at most: past them, a blocking problem still there stops the work. */
export const UNIT_REVIEW_LIMIT = 8;

/** The unit test files that differ from what they were when the work started: added or changed. */
export function changedUnitTests(buildDir: string, atStart: Map<string, string>): string[] {
  const { added, changed } = diffFiles(atStart, digestFiles(buildDir));
  return [...added, ...changed].filter((file) => TEST_FILE_PATTERN.test(basename(file)));
}

export function unitReviewPrompt(options: {
  buildDir: string;
  changed: string[];
  /** What the work built: "functionality 3", "the spec change". */
  what: string;
  /** The specification it built, as the coding agent had it - and, for a spec change, the diff. */
  specText: string;
  diff?: string;
  earlier?: UnitReviewProblem[];
}): string {
  return [
    `The unit tests of ${options.what} pass. Before that counts, review them: passing tests prove only what they`,
    "check, and a test that checks next to nothing passes whatever the code does.",
    "",
    `The code and its unit tests are in ${options.buildDir}. Read them; change nothing.`,
    "",
    "<unit tests added or changed>",
    options.changed.length > 0 ? options.changed.join("\n") : "(none - no unit test was added or changed)",
    "</unit tests added or changed>",
    "",
    "Check that every behaviour the specification states for this work is tested, and tested well:",
    "- Each behaviour, edge case, validation rule and error the specification states has a test, and the test",
    "  asserts the outcome the specification says - the exact value returned, the state stored, the error raised",
    "  and its message or code - not only that something came back.",
    "- A test fails when the behaviour it is named for breaks. Weak: it only checks that a function, a route, a",
    "  file or a field exists; that a result is not null, is truthy, has a type or a length; that a status is 200",
    "  and nothing about the body; `assert True`, an empty or skipped test, an exception caught and swallowed, an",
    "  assertion so loose any answer passes, an expected value computed the way the code computes it.",
    "- It tests the code, not a stand-in: what is outside the unit - a network service, a clock, a database the",
    "  unit does not own - may be replaced; the unit under test itself never is, and a test that asserts only",
    "  what a mock was told to return tests the mock.",
    "- Deterministic: no real network, no sleeping, no dependence on the time of day or the order tests run in.",
    ...(options.diff !== undefined
      ? [
          "This work is the spec change below: what it adds or changes is what needs testing, and the tests it changed",
          "still have to test the rest as they did. A change that adds no behaviour - a description, a renamed concept, a",
          "reworded spec - needs no new test.",
        ]
      : []),
    "Only what this work's specification asks for: a test of something it does not state, or of how the code",
    "works inside rather than what it does, is not a problem to raise.",
    "",
    ...(options.earlier !== undefined && options.earlier.length > 0
      ? [
          "The review before this one sent the tests back with these problems, and they have been worked on since:",
          "",
          ...options.earlier.map((problem) => `- ${problem.kind === "missing" ? "MISSING" : "BAD"} · ${problem.file}${problem.test ? ` · ${problem.test}` : ""}: ${problem.what.trim()}`),
          "",
          "Check each of them first: fixed, or still there. Raise a new problem only when it is one of the above - a",
          "behaviour untested, or a test that cannot fail. The review is not done again from the start.",
          "",
        ]
      : ["Find every problem now, in this one review: the tests go back once with all of them.", ""]),
    "Then call submit_review once: pass when nothing is missing and nothing is weak; otherwise every problem - the",
    'file, the test, its kind - "missing" for a test that is not there, "bad" for one that is weak or wrong - and',
    "exactly what, with what the specification says instead. Be specific: the",
    "agent that fixes them gets your list and nothing else. Mark a problem blocking when because of it a behaviour",
    "the specification states is not tested - no test for it, or one that cannot fail. Those are never let go; the",
    "rest - ways to make tests that already test it better - are let go after a few reviews.",
    "",
    ...(options.diff !== undefined ? ["<the spec change>", options.diff.trim(), "</the spec change>", ""] : []),
    "<specification>",
    options.specText.trim(),
    "</specification>",
  ].join("\n");
}

/** The review: a read-only agent, on the judge model, that says pass or every problem. No verdict is no pass. */
export async function reviewUnitTests(options: {
  buildDir: string;
  changed: string[];
  what: string;
  specText: string;
  diff?: string;
  earlier?: UnitReviewProblem[];
  label: string;
  model?: string;
  onDelta?: (delta: string) => void;
}): Promise<{ pass: boolean; problems: UnitReviewProblem[] }> {
  let verdict: { pass: boolean; problems: UnitReviewProblem[] } | undefined;
  const submit = defineTool({
    name: "submit_review",
    label: "Submit the review",
    description: "Say whether the unit tests pass the review, and if not, every problem with them. Call this once, when you are done.",
    parameters: Type.Object({
      pass: Type.Boolean({ description: "True only when nothing is missing and nothing is weak" }),
      problems: Type.Array(
        Type.Object({
          file: Type.String({ description: "The test file, relative to the code folder - or the file a missing test belongs in" }),
          test: Type.Optional(Type.String({ description: "The test in it, when it is one test" })),
          kind: Type.String({
            description:
              '"missing" when a test the specification calls for is not there at all; "bad" when a test is there but weak or wrong.' +
              " Any other word is read as one of the two - one starting with \"missing\" as missing, the rest as bad",
          }),
          what: Type.String({ description: "Exactly what is missing or weak, and what the specification says instead" }),
          blocking: Type.Boolean({
            description: "True when because of it a behaviour the specification states is not tested - no test, or one that cannot fail. False for a way to make a test that already tests it better",
          }),
        }),
      ),
    }),
    async execute(_id, params) {
      // "missing_test", "weak": the verdict is what counts, not the exact word - one bad word never throws a review away.
      const given = { ...(params as { pass: boolean; problems: Array<UnitReviewProblem & { kind: string }> }) };
      given.problems = given.problems.map((problem) => ({ ...problem, kind: reviewKind(problem.kind) }));
      // A pass with problems, or a fail with none, is not a verdict.
      if (given.pass === given.problems.length > 0) {
        return {
          content: [{ type: "text" as const, text: given.pass ? "A pass lists no problems - either drop them or fail it." : "A fail has to say what is wrong: list every problem." }],
          details: {},
        };
      }
      verdict = given;
      return { content: [{ type: "text" as const, text: "Recorded." }], details: {}, terminate: true };
    },
  }) as ToolDefinition;
  const fence = confinedTools({ workdir: options.buildDir, read: [options.buildDir], write: [], noBash: true });
  const session = await createExecutor({
    cwd: options.buildDir,
    customTools: [submit, ...fence.tools],
    tools: [...fence.names, "submit_review"],
    model: options.model,
    label: `${options.label} unit test reviewer`,
    system: fence.note,
    budget: { calls: REVIEWER_CALLS, finish: ["submit_review"] },
  });
  try {
    await ask(session, unitReviewPrompt(options), options.onDelta);
    if (verdict === undefined) await ask(session, "You have not called submit_review. Call it now: pass, or every problem.", options.onDelta);
  } finally {
    session.dispose();
  }
  return (
    verdict ?? {
      pass: false,
      problems: [{ file: "(all)", kind: "bad", what: "The review gave no verdict. Check every unit test you added or changed against the rules above yourself." }],
    }
  );
}

/** The review's problems, for the coding agent. */
export function unitReviewFeedbackPrompt(problems: UnitReviewProblem[]): string {
  return [
    "The unit tests pass. A review of them found where they do not yet test what the specification says - each, exactly:",
    "",
    ...problems.map((problem) => `- ${problem.blocking === true ? "BLOCKING · " : ""}${problem.kind === "missing" ? "MISSING" : "BAD"} · ${problem.file}${problem.test ? ` · ${problem.test}` : ""}: ${problem.what.trim()}`),
    "",
    "Fix every one: write the tests that are missing, and make the weak ones assert what the specification says -",
    "the exact outcome, so they fail when it breaks. Change the code only where a stronger test shows it wrong.",
    "Then run the unit tests. Never loosen a test, delete one, or mock the unit under test to make it pass.",
    ...INTEGRITY_RULES,
  ].join("\n");
}

/**
 * Review the unit tests until they pass it: each time it finds problems, they go to the coding agent
 * and the unit tests must pass again before the next review. Past UNIT_REVIEW_ROUNDS reviews with
 * nothing blocking, what it still suggests is let go and kept in the notes; past UNIT_REVIEW_LIMIT, a
 * blocking problem still there - or unit tests that no longer pass - stops the work.
 */
export async function untilUnitTestsReviewed(options: {
  buildDir: string;
  /** The code folder's files when the work started, to see which unit tests it added or changed. */
  atStart: Map<string, string>;
  what: string;
  specText: string;
  diff?: string;
  label: string;
  model?: string;
  /** Send the coding agent a prompt. */
  send: (prompt: string) => Promise<void>;
  /** Run the unit tests with the coding agent until they pass: false when they do not. */
  untilPassing: () => Promise<boolean>;
  stage: (label: string) => void;
  onDelta?: (delta: string) => void;
}): Promise<{ passed: boolean; waived?: UnitReviewProblem[]; problems?: UnitReviewProblem[] }> {
  let earlier: UnitReviewProblem[] | undefined;
  for (let reviews = 0; reviews < UNIT_REVIEW_LIMIT; reviews += 1) {
    const changed = changedUnitTests(options.buildDir, options.atStart);
    options.stage(`reviewing the unit tests (review ${reviews + 1}): does each test what the spec says, so it fails when that breaks`);
    const review = await reviewUnitTests({ ...options, changed, ...(earlier !== undefined ? { earlier } : {}) });
    if (review.pass) {
      options.stage("the review has nothing left to improve in the unit tests");
      return { passed: true };
    }
    const blocking = review.problems.filter((problem) => problem.blocking === true);
    if (reviews + 1 >= UNIT_REVIEW_ROUNDS && blocking.length === 0) {
      options.stage(`the unit tests cannot be optimised further after ${reviews + 1} reviews - done; what the last review suggested is in the notes`);
      recordNote(
        options.buildDir,
        "pitfalls",
        `the unit tests were optimised as far as ${reviews + 1} reviews could take them; the last one still suggested: ${review.problems.map((problem) => `${problem.file}${problem.test ? ` ${problem.test}` : ""}: ${problem.what.trim()}`).join("; ").slice(0, 600)}`,
        `${options.label} unit tests`,
      );
      return { passed: true, waived: review.problems };
    }
    reportActivity(`  the review found ${review.problems.length} problem${review.problems.length === 1 ? "" : "s"}: ${review.problems[0]!.what.slice(0, 140)}`);
    options.stage(
      blocking.length > 0
        ? `the review found ${blocking.length} behaviour${blocking.length === 1 ? "" : "s"} of the spec not yet tested - the coding agent completes the unit tests`
        : `the review found ${review.problems.length} way${review.problems.length === 1 ? "" : "s"} to make the unit tests test more - the coding agent improves them`,
    );
    earlier = review.problems;
    await options.send(unitReviewFeedbackPrompt(review.problems));
    if (!(await options.untilPassing())) return { passed: false, problems: review.problems };
  }
  options.stage(`the unit tests still leave what the spec states untested after ${UNIT_REVIEW_LIMIT} reviews - stopping`);
  return { passed: false, problems: earlier };
}
