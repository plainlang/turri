import { basename } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ask, createExecutor } from "../pi.ts";
import { reportActivity } from "./activity.ts";
import { diffFiles, digestFiles } from "./codebase.ts";
import { confinedTools } from "./confine.ts";
import { REVIEWER_CALLS, reviewKind } from "./conformance-agents.ts";
import { readNotes, recordNote, reflectOnReview, REVIEW_LESSON } from "./notes.ts";
import { diffSinceSnapshot, workDiff, workSnapshot } from "./lineage.ts";
import { REVIEWER_COMPACTION } from "./compaction.ts";
import { describeAccounts, SUBMIT_AFTER_REVIEW, unanswered, unansweredPrompt, type WorkLedger } from "./submit-work.ts";
import { ARBITER_AFTER, arbitrateReview, dismissedNote, problemLine, REVIEW_LIMIT } from "./arbiter.ts";
import { codeReviewCasesBlock } from "./cases.ts";
import type { JobCases } from "./drift.ts";
import { TEST_FILE_PATTERN } from "./testing.ts";
import { createCanItFailTool } from "./self-check.ts";

/** How many times the reviewer runs can_it_fail in a review session: each is a run of the unit testing script. */
export const REVIEWER_CAN_IT_FAIL_RUNS = 3;

/**
 * The review of the work: once its unit tests pass, does the code do what the spec says, and do the tests test it?
 *
 * A passing unit suite proves only what its tests check, and a coding agent is quick to write tests
 * that check next to nothing - that a function exists, that it returns something, that a status is
 * 200 - and pass whatever the code does, or none at all. So once the unit testing script passes, a
 * reviewer reads what the work wrote - the code and the unit tests, as a diff - beside the spec, and says
 * where the code does not do what the spec says, and which tests are missing or weak. It changes nothing. Its problems go back to the coding agent, the unit testing script
 * runs again, and the review looks again. It optimises the tests, it is not a gate: a problem that
 * leaves a behaviour of the spec untested is worked on first, the rest - ways to make tests that
 * already test it better - are let go after UNIT_REVIEW_ROUNDS reviews, and after UNIT_REVIEW_LIMIT
 * whatever is left is let go too, kept in the notes, and the work goes on.
 */

/** What the review found wrong with the code or its unit tests. */
export interface UnitReviewProblem {
  file: string;
  test?: string;
  /** "wrong": the code does not do what the spec says. "missing", "bad": a unit test not there, or weak. */
  kind: "missing" | "bad" | "wrong";
  what: string;
  /**
   * A behaviour the spec states is not implemented, or implemented wrong, or not yet tested: no test for it, or
   * one that cannot fail - it only checks that something exists, asserts nothing, mocks the unit it tests, is skipped.
   */
  blocking?: boolean;
}

/**
 * How many reviews may send the unit tests back before the arbiter weighs them: from this one on, every review that
 * sends them back goes to the arbiter first, and only what it upholds reaches the coding agent.
 */
export const UNIT_REVIEW_ROUNDS = ARBITER_AFTER;
/**
 * How many reviews at most. The review optimises the tests; it does not decide whether the work is done - the
 * unit testing script does. Past this many, whatever it still finds, blocking or not, is let go, kept in the notes,
 * and the work goes on.
 */
export const UNIT_REVIEW_LIMIT = REVIEW_LIMIT;

/** The unit test files that differ from what they were when the work started: added or changed. */
export function changedUnitTests(buildDir: string, atStart: Map<string, string>): string[] {
  const { added, changed } = diffFiles(atStart, digestFiles(buildDir));
  return [...added, ...changed].filter((file) => TEST_FILE_PATTERN.test(basename(file)));
}

/**
 * The reviewer's task, for its instructions: what it reviews, against which specification, and how. It stays word for
 * word through every review of the loop; what each review is shown comes as a message (`unitReviewRequest`).
 */
export function unitReviewTask(options: {
  buildDir: string;
  /** What the work built: "functionality 3 of module `m`", "the spec change to module `m`". */
  what: string;
  /** The specification it built, as the coding agent had it, what is new in this work apart (`reviewedSpec`). */
  spec: string;
  /** The work is a spec change, not a functionality. */
  forChange?: boolean;
  /** What the work does to each functional spec (work.ts): each part held to its own case. */
  cases?: JobCases;
  /** It has can_it_fail, to check that a test it doubts can fail. */
  canItFail?: boolean;
}): string {
  const mechanical = options.cases?.mechanical === true;
  return [
    `You review the work on ${options.what}, each time its unit tests pass: passing tests prove only what they`,
    "check - a test that checks next to nothing passes whatever the code does, and code no test reaches is not checked",
    "at all. Review both: that the code does what the specification says, and that its unit tests test it.",
    "",
    "You are the exacting reviewer: opinionated, thorough, and hard to satisfy. Raise every problem you find with",
    "the code and its tests, however small - a senior engineer weighs your findings after you, and lets go what is",
    "not worth the time. Missing one is worse than raising one too many.",
    "",
    `The code and its unit tests are in ${options.buildDir}.`,
    "",
    "How to read it:",
    "- <specification> is the specification exactly as the coding agent had it. Review the work against <new in this",
    "  work>; the rest is there so you know what the words mean and what was there before.",
    "- The diff you are shown is exactly what changed in the code folder - code and tests - new files whole. It is",
    "  taken by the harness, not by the agent: start from it, and read a file whole where the diff shows too little of",
    "  it, or to see how the new code fits what was there. Do not guess what the code does - it is all there.",
    "- <the coding agent's account> is what the agent that did the work says it did. It is a claim: check every part of",
    "  it against the diff and the files. A problem it says is fixed that the code does not fix is still a problem; one",
    "  it declined, weigh its reason - it may be right.",
    "",
    "<specification>",
    options.spec.trim(),
    "</specification>",
    "",
    ...(options.cases !== undefined ? [...codeReviewCasesBlock(options.cases), ""] : []),
    // A job that touches no functional spec is held only to that: the checks of behaviour are not its.
    ...(mechanical ? [] : ["Check that the code does what the specification states for this work:"]),
    ...(mechanical
      ? []
      : [
          "- Every behaviour, edge case, validation rule and error it states is implemented, and implemented as it says -",
          "  the values, the messages, the order, the limits. Nothing is left as a stub, a placeholder, a TODO or a",
          "  hard-coded answer that passes a test and nothing else.",
          "- It keeps to the implementation reqs, and does not break what the code already implements.",
          "- When the work wrote no code at all, or none for a behaviour, that behaviour is not implemented: raise it.",
          "",
          "Check that every behaviour the specification states for this work is tested, and tested well:",
          "- Each behaviour, edge case, validation rule and error the specification states has a test, and the test",
          "  asserts the outcome the specification says - the exact value returned, the state stored, the error raised",
          "  and its message or code - not only that something came back.",
          "- A test fails when the behaviour it is named for breaks. Weak: it only checks that a function, a route, a",
          "  file or a field exists; that a result is not null, is truthy, has a type or a length; that a status is 200",
          "  and nothing about the body; `assert True`, an empty or skipped test, an exception caught and swallowed, an",
          "  assertion so loose any answer passes, an expected value computed the way the code computes it.",
          ...(options.canItFail === true
            ? [
                "- A test you doubt can fail, check: can_it_fail puts a bug in a copy of the code - a condition turned round, a",
                "  value changed - and runs the unit tests on it. A test that still passes cannot fail: raise it as bad, with the",
                `  bug it missed. ${REVIEWER_CAN_IT_FAIL_RUNS} runs a session: spend them on the tests the work rests on.`,
              ]
            : []),
          "- It tests the code, not a stand-in: what is outside the unit - a network service, a clock, a database the",
          "  unit does not own - may be replaced; the unit under test itself never is, and a test that asserts only",
          "  what a mock was told to return tests the mock.",
          "- Deterministic: no real network, no sleeping, no dependence on the time of day or the order tests run in.",
          ...(options.forChange === true
            ? [
                "This work is the <spec change> in <new in this work>, section by section: what it adds or changes is what needs",
                "testing, and the tests it changed still have to test the rest as they did. A change that adds no behaviour - a",
                "description, a renamed concept, a reworded spec - needs no new test.",
                "Behaviour is what a functional spec, an acceptance test or an implementation req states. A definition says what",
                "a word means: a page, a component or a record that only <definitions> name, and no functional spec or",
                "implementation req of this codebase asks for, has no code yet, and a test for it is not missing.",
              ]
            : []),
        ]),
    "Only what this work's specification asks for: a test of something it does not state, or of how the code",
    "works inside rather than what it does, is not a problem to raise; nor is code written another way than you",
    "would have, as long as it does what the specification says.",
    "",
    "You review the same work more than once. The first time you are shown everything it wrote, and find every problem",
    "in that one review: the work goes back once with all of them. Each time after, you are shown what it changed since",
    "and what the coding agent says it did about each problem: check each one you raised first - fixed, or still there -",
    "and raise a new one only when it would be blocking (below). It is not done again from the start.",
    "",
    "Each review ends with submit_review, once: pass when the code does what the specification says and nothing is",
    'missing or weak; otherwise every problem - the file, the test or the function, its kind - "wrong" for code that does',
    'not do what the specification says, "missing" for a test that is not there, "bad" for one that is weak or wrong -',
    "and exactly what, with what the specification says instead. Be specific: the agent that fixes them gets your list",
    "and nothing else. Mark a problem blocking when because of it a behaviour the specification states is not",
    "implemented, implemented wrong, or not tested - no test for it, or one that cannot fail. Those are worked on first;",
    "the rest - ways to make code or tests that already do it better - are let go after a few reviews.",
  ].join("\n");
}

/** What one review is shown: the whole work the first time; after that, what changed since the last, and the problems it raised. */
export function unitReviewRequest(options: {
  /** First review: the whole work (`workDiff`). After it: the diff since the last review (`diffSinceSnapshot`). */
  diff: string;
  changed: string[];
  /** The coding agent's account of its work since the last review (`describeAccounts`). */
  account: string;
  /** The problems the last review raised that went to the coding agent - given, this is a review after it. */
  earlier?: UnitReviewProblem[];
  /** What the arbiter let go of the last review: not to be raised again. */
  letGo?: UnitReviewProblem[];
}): string {
  const diff = options.diff.trim();
  const again = options.earlier !== undefined;
  return [
    again
      ? "The unit tests pass again, after the coding agent worked on the problems your last review raised. Review it again."
      : "The unit tests pass. Review the work.",
    "",
    again ? "<what changed since your last review - a diff of the code folder>" : "<the code this work wrote - a diff of the code folder from where the work started>",
    diff !== "" ? diff : again ? "(nothing changed since your last review)" : "(nothing - the code folder is as the work found it)",
    again ? "</what changed since your last review>" : "</the code this work wrote>",
    "",
    "<unit tests added or changed by the work>",
    options.changed.length > 0 ? options.changed.join("\n") : "(none - no unit test was added or changed)",
    "</unit tests added or changed by the work>",
    "",
    "<the coding agent's account>",
    options.account,
    "</the coding agent's account>",
    // The problems it raised last are its own submit_review, in its session: named, not sent again.
    ...(again && options.earlier!.length > 0
      ? ["", options.earlier!.length === 1 ? "Check first the problem your last review raised." : `Check first each of the ${options.earlier!.length} problems your last review raised.`]
      : []),
    ...(options.letGo !== undefined && options.letGo.length > 0
      ? ["", "The arbiter weighed your last review and let these go - they are settled, do not raise them again:", ...options.letGo.map((problem) => `- ${problemLine(problem)}`)]
      : []),
    "",
    "Then call submit_review.",
  ].join("\n");
}


export interface UnitReviewer {
  /** One review: what it is shown (`unitReviewRequest`), and its verdict. No verdict is no pass. */
  review(request: string): Promise<{ pass: boolean; problems: UnitReviewProblem[] }>;
  dispose(): void;
}

/**
 * The reviewer: a read-only agent, on the judge model, that says pass or every problem - one session for the whole
 * loop, so a review after the first starts from what it already read and raised, not from nothing. Its task is its
 * instructions; its work is compacted as it gets longer.
 */
export async function createUnitReviewer(options: {
  /** What the work does to each functional spec (work.ts): the reviewer holds each part to its own case. */
  cases?: JobCases;
  buildDir: string;
  what: string;
  spec: string;
  forChange?: boolean;
  label: string;
  model?: string;
  onDelta?: (delta: string) => void;
  /** The unit testing script, where it runs on a copy: the reviewer checks with can_it_fail that a test it doubts can fail. */
  unitScript?: string;
}): Promise<UnitReviewer> {
  let verdict: { pass: boolean; problems: UnitReviewProblem[] } | undefined;
  const submit = defineTool({
    name: "submit_review",
    label: "Submit the review",
    description: "Say whether the code and its unit tests pass the review, and if not, every problem with them. Call this once, when you are done.",
    parameters: Type.Object({
      pass: Type.Boolean({ description: "True only when the code does what the specification says and no test is missing or weak" }),
      problems: Type.Array(
        Type.Object({
          file: Type.String({ description: "The file, relative to the code folder: the code that is wrong, the test file, or the file a missing test belongs in" }),
          test: Type.Optional(Type.String({ description: "The test or the function in it, when it is one" })),
          kind: Type.String({
            description:
              '"wrong" when the code does not do what the specification says - or does not do it at all; "missing" when a test the specification' +
              ' calls for is not there; "bad" when a test is there but weak or wrong. Any other word is read as one of these - one starting with' +
              ' "wrong" as wrong, with "missing" as missing, the rest as bad',
          }),
          what: Type.String({ description: "Exactly what is wrong, missing or weak, and what the specification says instead" }),
          blocking: Type.Boolean({
            description:
              "True when because of it a behaviour the specification states is not implemented, implemented wrong, or not tested - no test, or one that cannot fail." +
              " False for a way to make code or a test that already does it better",
          }),
        }),
      ),
    }),
    async execute(_id, params) {
      // "missing_test", "weak": the verdict is what counts, not the exact word - one bad word never throws a review away.
      const given = { ...(params as { pass: boolean; problems: Array<UnitReviewProblem & { kind: string }> }) };
      given.problems = given.problems.map((problem) => ({ ...problem, kind: /^\s*wrong/i.test(problem.kind) ? "wrong" : reviewKind(problem.kind) }));
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
  // A test it doubts, it checks: whether the tests catch a bug put in a copy of the code - the code itself untouched.
  const canItFail = options.unitScript !== undefined ? [createCanItFailTool({ buildDir: options.buildDir, script: options.unitScript, runs: REVIEWER_CAN_IT_FAIL_RUNS })] : [];
  const session = await createExecutor({
    cwd: options.buildDir,
    customTools: [submit, ...canItFail, ...fence.tools],
    tools: [...fence.names, ...canItFail.map((tool) => tool.name), "submit_review"],
    model: options.model,
    label: `${options.label} reviewer`, role: "reviewer",
    system: fence.note,
    task: unitReviewTask({ ...options, canItFail: options.unitScript !== undefined }),
    compaction: { instructions: REVIEWER_COMPACTION },
    budget: { calls: REVIEWER_CALLS, finish: ["submit_review"] },
  });
  return {
    async review(request) {
      verdict = undefined;
      await ask(session, request, options.onDelta);
      if (verdict === undefined) await ask(session, "You have not called submit_review. Call it now: pass, or every problem.", options.onDelta);
      return (
        verdict ?? {
          pass: false,
          problems: [{ file: "(all)", kind: "bad", what: "The review gave no verdict. Check the code and every unit test you added or changed against the specification yourself." }],
        }
      );
    },
    dispose: () => session.dispose(),
  };
}

/** The review's problems, for the coding agent. */
export function unitReviewFeedbackPrompt(problems: UnitReviewProblem[]): string {
  return [
    "The unit tests pass. A review of the work found where the code does not yet do what the specification says, or its",
    "tests do not yet test it - each, exactly:",
    "",
    ...problems.map((problem, index) => `${index + 1}. ${problemLine(problem)}`),
    "",
    "Fix every one: make the code WRONG names do what the specification says, write the tests that are missing, and",
    "make the weak ones assert what the specification says - the exact outcome, so they fail when it breaks. Then run",
    "the unit tests. One you are sure the review is wrong about, decline, and say why.",
    ...SUBMIT_AFTER_REVIEW,
    ...REVIEW_LESSON,
  ].join("\n");
}

/**
 * Review the code and its unit tests until they pass it: each time it finds problems, they go to the coding agent
 * and the unit tests must pass again before the next review. Past UNIT_REVIEW_ROUNDS reviews with
 * nothing blocking, what it still suggests is let go and kept in the notes; past UNIT_REVIEW_LIMIT,
 * whatever is left is let go the same way - the review optimises the tests, it never stops the work.
 * Only unit tests that no longer pass after a round of fixes do.
 */
export async function untilUnitTestsReviewed(options: {
  /** What the work does to each functional spec (work.ts): the reviewer holds each part to its own case. */
  cases?: JobCases;
  buildDir: string;
  /** The code folder's files when the work started, to see which unit tests it added or changed. */
  atStart: Map<string, string>;
  what: string;
  /** The specification it built, what is new in this work apart (`reviewedSpec`). */
  spec: string;
  forChange?: boolean;
  label: string;
  model?: string;
  /** Send the coding agent a prompt. */
  send: (prompt: string) => Promise<void>;
  /** Run the unit tests with the coding agent until they pass: false when they do not. */
  untilPassing: () => Promise<boolean>;
  stage: (label: string) => void;
  onDelta?: (delta: string) => void;
  /** What the coding agent handed over through submit_work: its account, beside the diff, for the reviewer. */
  work?: WorkLedger;
  /** Send the coding agent back once for problems its account left unanswered. Default true when `work` is given. */
  askForAnswers?: boolean;
  /** The unit testing script, where it runs on a copy: the reviewer checks with can_it_fail that a test it doubts can fail. */
  unitScript?: string;
}): Promise<{ passed: boolean; waived?: UnitReviewProblem[]; problems?: UnitReviewProblem[]; reviews: number }> {
  const reviewer = await createUnitReviewer(options);
  try {
    return await reviewLoop(options, reviewer);
  } finally {
    reviewer.dispose();
  }
}

async function reviewLoop(
  options: Parameters<typeof untilUnitTestsReviewed>[0],
  reviewer: UnitReviewer,
): Promise<{ passed: boolean; waived?: UnitReviewProblem[]; problems?: UnitReviewProblem[]; reviews: number }> {
  let earlier: UnitReviewProblem[] | undefined;
  const history: UnitReviewProblem[][] = [];
  const waived: UnitReviewProblem[] = [];
  /** What the reviewer saw last: the next review is shown only what changed since. */
  let seen: string | undefined;
  /** What the arbiter dismissed of the last review: the reviewer is told, so it does not raise them again. */
  let letGo: UnitReviewProblem[] = [];
  const said = (problems: UnitReviewProblem[]) => problems.map((problem) => `${problem.file}${problem.test ? ` ${problem.test}` : ""}: ${problem.what.trim()}`).join("; ").slice(0, 600);
  for (let reviews = 0; reviews < UNIT_REVIEW_LIMIT; reviews += 1) {
    const changed = changedUnitTests(options.buildDir, options.atStart);
    // What the coding agent has written by now: it changes between reviews. The arbiter, fresh each time, reads it whole.
    const code = workDiff(options.buildDir);
    const account = describeAccounts(options.work?.take() ?? [], earlier);
    const request =
      seen === undefined || earlier === undefined
        ? unitReviewRequest({ diff: code, changed, account })
        : unitReviewRequest({ diff: diffSinceSnapshot(options.buildDir, seen), changed, account, earlier, letGo });
    seen = workSnapshot(options.buildDir);
    letGo = [];
    options.stage(`reviewing the code and its unit tests (review ${reviews + 1}): does the code do what the spec says, and does each test fail when that breaks`);
    const review = await reviewer.review(request);
    if (review.pass) {
      options.stage("the review has nothing left to improve in the code or its unit tests");
      return waived.length > 0 ? { passed: true, waived, reviews: reviews + 1 } : { passed: true, reviews: reviews + 1 };
    }
    let problems = review.problems;
    // After the first UNIT_REVIEW_ROUNDS reviews that send them back, the arbiter weighs each first: only what it upholds goes to the coding agent.
    if (reviews >= UNIT_REVIEW_ROUNDS) {
      options.stage(`the review sent the work back ${reviews + 1 === 1 ? "once" : `${reviews + 1} times`} - the arbiter weighs what it found`);
      const ruling = await arbitrateReview({
        subject: `the code and unit tests of ${options.what}`,
        workdir: options.buildDir,
        read: [options.buildDir],
        uphold: [
          "- uphold it when because of it a behaviour this work's specification states - in a functional spec, an",
          "  acceptance test or an implementation req - is not implemented, is implemented other than it says, is not tested, or a",
          "  test cannot fail when that behaviour breaks. Then the reviewer is right, and the coding agent fixes it.",
        ],
        changed,
        spec: `<specification>\n${options.spec.trim()}\n</specification>`,
        code,
        problems: review.problems,
        history,
        label: `${options.label} unit test`,
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.onDelta !== undefined ? { onDelta: options.onDelta } : {}),
      });
      // No ruling: the review stands, as it did before there was an arbiter.
      if (ruling !== undefined) {
        waived.push(...ruling.dismissed.map((entry) => entry.problem));
        if (ruling.dismissed.length > 0) recordNote(options.buildDir, "pitfalls", dismissedNote(ruling, "unit test"), `${options.label} unit tests`);
        if (ruling.upheld.length === 0) {
          options.stage("the arbiter approved the code and its unit tests as they are - what the review still raised is let go, and in the notes");
          return { passed: true, waived, reviews: reviews + 1 };
        }
        options.stage(`the arbiter upheld ${ruling.upheld.length} of the review's ${review.problems.length} problem${review.problems.length === 1 ? "" : "s"} - the coding agent fixes ${ruling.upheld.length === 1 ? "it" : "those"}`);
        problems = ruling.upheld.map((entry) => entry.problem);
        letGo = ruling.dismissed.map((entry) => entry.problem);
      }
    }
    history.push(review.problems);
    const blocking = problems.filter((problem) => problem.blocking === true);
    const wrong = problems.filter((problem) => problem.kind === "wrong");
    reportActivity(`  the review found ${problems.length} problem${problems.length === 1 ? "" : "s"}: ${problems[0]!.what.slice(0, 140)}`);
    options.stage(
      wrong.length > 0
        ? `the review found ${wrong.length} place${wrong.length === 1 ? "" : "s"} where the code does not do what the spec says - the coding agent fixes the code${problems.length > wrong.length ? " and its tests" : ""}`
        : blocking.length > 0
          ? `the review found ${blocking.length} behaviour${blocking.length === 1 ? "" : "s"} of the spec not yet tested - the coding agent completes the unit tests`
          : `the review found ${problems.length} way${problems.length === 1 ? "" : "s"} to make the unit tests test more - the coding agent improves them`,
    );
    earlier = problems;
    const pitfalls = readNotes(options.buildDir).pitfalls;
    await options.send(unitReviewFeedbackPrompt(problems));
    // Every problem answered - fixed, or declined and why - so the reviewer knows what became of each: sent back once.
    if (options.work !== undefined && options.askForAnswers !== false) {
      const missing = unanswered(options.work.peek(), problems.length);
      if (missing.length > 0) await options.send(unansweredPrompt(missing));
    }
    // The lesson, left for the agents after it: the next functionality's tests start from it.
    await reflectOnReview(options.buildDir, pitfalls, options.send);
    if (!(await options.untilPassing())) return { passed: false, problems, reviews: reviews + 1 };
  }
  // An optimiser, not a gate: what the last review sent back was worked on and the unit tests pass - it is not reviewed again.
  options.stage(`the last of ${UNIT_REVIEW_LIMIT} reviews sent the work back once more; its unit tests pass - going on without another review`);
  recordNote(
    options.buildDir,
    "pitfalls",
    `the unit tests went on after ${UNIT_REVIEW_LIMIT} reviews, the last one's problems worked on but not reviewed again: ${said(earlier ?? [])}`,
    `${options.label} unit tests`,
  );
  return { passed: true, waived: [...waived, ...(earlier ?? [])], reviews: UNIT_REVIEW_LIMIT };
}
