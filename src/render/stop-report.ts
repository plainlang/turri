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
  conformance?: Pick<RenderConformanceTestsResult, "runs">;
  /** Repairs made to earlier functionalities' code before it gave up. */
  repairs?: number;
}

/**
 * Where it stopped, why, and what to do about it - for the person, in a few lines, and in terms
 * of the spec. The spec is all the person works on: the code is generated from it, so every fix
 * offered here is a change to a `.plain` file, never to code, tests or the machine.
 */
export function describeStop(facts: StopFacts): string {
  const what = facts.frid !== undefined ? `${facts.moduleName} functionality ${facts.frid}` : `the spec change in ${facts.moduleName}`;
  const tries = ATTEMPTS[facts.at];
  let why: string;
  let todo: string[];

  if (facts.at === "unit tests") {
    why = `after ${tries} attempts it still could not be built to pass its own unit tests.`;
    todo = [
      "The functional spec is most likely too big for one functionality, or leaves a choice open that keeps coming " +
        "out wrong. Split it into smaller functional specs (`analyze-if-func-spec-too-complex`, `break-down-func-spec`), " +
        "or say exactly what it should do.",
      "If it needs something the stack does not name - a library, a tool, a service - add it to the implementation reqs.",
      "If its unit tests have to be run in a particular way, say how in the implementation reqs.",
    ];
  } else if (facts.at === "conformance") {
    why = `after ${tries} rounds, its conformance tests and its code still disagree about what the spec means.`;
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
