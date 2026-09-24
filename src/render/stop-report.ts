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
  conformance?: Pick<RenderConformanceTestsResult, "triage" | "runs">;
  /** Repairs made to earlier functionalities' code before it gave up. */
  repairs?: number;
}

function lastRun(runs: TestRun[] | undefined): string {
  const last = runs?.at(-1);
  return last ? ` The last run was \`${last.command}\` (exit ${last.exitCode}).` : " The tests were never run.";
}

/** Where it stopped, why, and what to do about it - for the person, in a few lines. */
export function describeStop(facts: StopFacts): string {
  const what = facts.frid !== undefined ? `${facts.moduleName} functionality ${facts.frid}` : `the spec change in ${facts.moduleName}`;
  const tries = ATTEMPTS[facts.at];
  let why: string;
  let todo: string[];

  if (facts.at === "unit tests") {
    why = `its unit tests still fail after ${tries} attempts to fix them.${lastRun(facts.runs)}`;
    todo = [
      "See why: `/watch` on this job shows every attempt and what failed.",
      "Most often the spec is the cause: the functionality is too big for one build (check it with " +
        "`analyze-if-func-spec-too-complex`, split it with `break-down-func-spec`), or it leaves a choice open " +
        "that keeps coming out wrong. Change the spec, then build again.",
      "If the failures are about the machine rather than the code - a missing tool or library, a download that " +
        "was blocked - install it with `install_system_packages`, run `plainwright doctor`, or allow the host with " +
        "PLAINWRIGHT_ALLOWED_HOSTS; then build again.",
    ];
  } else if (facts.at === "conformance") {
    const verdict = facts.conformance?.triage.at(-1)?.fault;
    const last = facts.conformance?.runs.at(-1);
    why =
      `its conformance tests still fail after ${tries} rounds of deciding who is wrong and fixing it` +
      (verdict ? ` - the last verdict was that the ${verdict === "code_at_fault" ? "code" : "test"} was wrong` : "") +
      "." +
      (last ? ` The last run was \`${last.command}\` (exit ${last.exitCode}).` : "");
    todo = [
      "The tests and the code keep disagreeing about what the spec means, which usually means the spec can be " +
        "read more than one way. Make the functional spec and its acceptance tests say exactly what should happen, " +
        "then regenerate the functionality.",
      "If the tests are run the wrong way - wrong framework, command or setup - fix the test reqs or the " +
        "conformance-test script instead.",
      "`/watch` on this job shows each verdict and why it was reached.",
    ];
  } else {
    why =
      `building it broke tests of what was built before it, and ${facts.repairs ?? tries} repair` +
      `${facts.repairs === 1 ? "" : "s"} to the code did not make them pass again.`;
    todo = [
      "This most often means the new spec contradicts an earlier one. Check it against the earlier specs " +
        "(`analyze-func-specs`, `resolve-spec-conflict`), change whichever is wrong, then regenerate.",
      "If an earlier test was wrong all along, fix that functionality's spec or acceptance tests and regenerate it.",
      "`/watch` on this job shows which tests broke and what each repair tried.",
    ];
  }

  return [
    `Stopped at ${what}: ${why}`,
    "Nothing after it was built - the functionalities after it, and the modules built on this one, wait on it. " +
      "Running the same build again picks up here: what is built stays built.",
    "",
    "What to do:",
    ...todo.map((line) => `- ${line}`),
  ].join("\n");
}
