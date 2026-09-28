import { basename } from "node:path";
import type { SpecConflict } from "./activity.ts";
import type { RenderConformanceTestsResult } from "./conformance.ts";
import type { TestRun } from "./testing.ts";

/**
 * What to tell the person when a build gives up.
 *
 * A build stops at one of three gates - its unit tests, its conformance tests, or the tests of
 * what was built before it - after the harness has tried as many times as it will. "Stopped at
 * regression" says where, not why, and not what to do; this says all three, in the words of
 * someone who has not read the harness.
 */

export type StopPoint = "unit tests" | "conformance" | "regression";

/** How many times each gate is tried before a build stops there. */
export const ATTEMPTS: Record<StopPoint, number> = {
  "unit tests": 20,
  conformance: 20,
  regression: 20,
};

export interface StopFacts {
  moduleName: string;
  /** The functionality it stopped at; none for a spec change. */
  frid?: string;
  at: StopPoint;
  /** The unit test runs, the last of which is the failing one. */
  runs?: TestRun[];
  conformance?: Pick<RenderConformanceTestsResult, "runs" | "rounds" | "specConflict" | "stuck" | "review">;
  /** Repairs made to earlier functionalities' code before it gave up. */
  repairs?: number;
  /** How many times the harness judged it before it stopped - the unit tests' attempts. */
  attempts?: number;
}

/**
 * Where it stopped, why, and what to do about it - for the person, in a few lines, and in terms
 * of the spec. The spec is all the person works on: the code is generated from it, so every fix
 * offered here is a change to a `.plain` file, never to code, tests or the machine.
 */
export function describeStop(facts: StopFacts): string {
  const what = facts.frid !== undefined ? `${facts.moduleName} functionality ${facts.frid}` : `the spec change in ${facts.moduleName}`;
  // What actually happened, not the most it could have been.
  const tries =
    facts.at === "unit tests" ? (facts.attempts ?? ATTEMPTS[facts.at]) : facts.at === "conformance" ? (facts.conformance?.rounds ?? ATTEMPTS[facts.at]) : ATTEMPTS[facts.at];
  let why: string;
  let todo: string[];

  if (facts.at === "unit tests") {
    why = `after ${tries} attempt${tries === 1 ? "" : "s"} it still could not be built to pass its own unit tests.`;
    todo = [
      "The functional spec is most likely too big for one functionality, or leaves a choice open that keeps coming " +
        "out wrong. Split it into smaller functional specs (`analyze-if-func-spec-too-complex`, `break-down-func-spec`), " +
        "or say exactly what it should do.",
      "If it needs something the stack does not name - a library, a tool, a service - add it to the implementation reqs.",
      "If its unit tests have to be run in a particular way, say how in the implementation reqs.",
    ];
  } else if (facts.at === "conformance" && facts.conformance?.specConflict !== undefined) {
    const { functionalities, reason } = facts.conformance.specConflict;
    const [one, two] = functionalities.map((ref) => `${ref.module} ${ref.frid}`);
    why = `its spec contradicts itself: functionalities ${one} and ${two} cannot both hold. ${reason.trim()}`;
    todo = [
      `Compare functional specs ${one} and ${two} (\`analyze-2-func-specs\`, \`resolve-spec-conflict\`) and change whichever is wrong - ` +
        "or both, so they say the same thing about where they meet.",
      "If one is meant to change what the other does, say so in the one that changes it, and update its acceptance tests to match.",
    ];
  } else if (facts.at === "conformance" && facts.conformance?.review !== undefined && facts.conformance.stuck === undefined) {
    const problems = facts.conformance.review;
    why =
      `its conformance tests pass, but never passed review in ${tries} round${tries === 1 ? "" : "s"}: they do not yet test what the spec says, ` +
      `black box. What the review last found:\n${problems.slice(0, 8).map((problem) => `    - ${problem.kind === "missing" ? "missing" : "bad"} · ${problem.file}${problem.test ? ` · ${problem.test}` : ""}: ${problem.what.trim().replace(/\s+/g, " ")}`).join("\n")}`;
    todo = [
      "If an acceptance test asks for something the tests cannot do - a service they cannot reach, data they cannot set up - say in the test " +
        "reqs how they do it, or change the acceptance test to what can be checked.",
      "If the test reqs leave open how the software is reached or what may be mocked, say so exactly.",
    ];
  } else if (facts.at === "conformance" && facts.conformance?.stuck !== undefined) {
    const { error, times, rounds } = facts.conformance.stuck;
    why =
      `its conformance tests kept failing with ${error} - ${times} times, and ${times} more after the explorer was asked again ` +
      `what they lacked, in ${rounds} attempts - so nothing more would have come of the rest of them.`;
    todo = [
      "The tests most likely cannot reach the software the way the test reqs have them do it. Say exactly how in the test reqs: " +
        "what the tests depend on or start - the package or entry point the conformance testing script builds or installs, by its exact name - " +
        "and how they start it.",
      "If the tests need longer than the time limit for a run - a long-running request - raise PLAINWRIGHT_COMMAND_TIMEOUT, or say in " +
        "the test reqs how they keep it short.",
      "If the test reqs contradict each other, settle which is meant.",
    ];
  } else if (facts.at === "conformance") {
    why = `after ${tries} round${tries === 1 ? "" : "s"}, its conformance tests and its code still disagree about what the spec means.`;
    todo = [
      "The functional spec can be read more than one way. Say exactly what should happen - the inputs, the outputs, " +
        "the edge cases - and add acceptance tests that pin down the expected result.",
      "If the conformance tests are meant to be written or run differently - framework, command, setup - change the test reqs.",
    ];
  } else {
    why =
      `building it broke what was built before it, and ${facts.repairs ?? tries} attempt${facts.repairs === 1 ? "" : "s"} ` +
      "to reconcile the two did not succeed.";
    todo = [
      "This most often means its spec contradicts an earlier one. Compare them (`analyze-func-specs`, " +
        "`resolve-spec-conflict`) and change whichever is wrong.",
      "If the new behaviour is meant to change what an earlier functionality does, change that earlier spec and its " +
        "acceptance tests to say so.",
    ];
  }

  return [
    `Stopped at ${what}: ${why}`,
    "Nothing after it was built - the functionalities after it, and the modules built on this one, wait on it.",
    "",
    "What to change in the spec:",
    ...todo.map((line) => `- ${line}`),
    "",
    "Then build again: it picks up here, and what is built stays built.",
  ].join("\n");
}

/**
 * A spec that contradicts itself, for the person: exactly which two functional specs, as they
 * read, and what cannot hold - then that the decision is theirs. Nothing about code or tests: the
 * spec is all they work on, and the fix is theirs to choose.
 */
export function describeSpecConflict(conflict: SpecConflict): string {
  const name = (spec: SpecConflict["specs"][number]) => `functional spec ${spec.frid} of ${spec.module}`;
  const [one, two] = conflict.specs;
  return [
    `The spec contradicts itself: ${name(one!)} and ${name(two!)} cannot both hold.`,
    "",
    ...conflict.specs.flatMap((spec) => [
      `Functional spec ${spec.frid} of ${spec.module} (${basename(spec.plainFile)}):`,
      ...spec.text.trim().split("\n").map((line) => `  ${line}`),
      "",
    ]),
    "What cannot hold:",
    ...[...new Set(conflict.reasons)].map((reason) => `- ${reason.replace(/\s+/g, " ")}`),
    "",
    `This was found ${conflict.reasons.length} times running the conformance tests, and nothing in the code or the tests can`,
    "settle it: only you can say what is meant. Decide which spec is right - or how the two should read together -",
    "and the spec is changed to say it.",
  ].join("\n");
}
