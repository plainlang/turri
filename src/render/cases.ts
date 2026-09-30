import type { JobCases, TouchedSpec } from "./work.ts";

/**
 * What a job's agents are told to do, by its cases - see docs/rendering.md. A job's functional specs each fall in
 * one case - fresh, added, changed (patched), taken out - or, with none touched, the job is mechanical. The coding
 * agent and the conformance agent are each told, case by case, exactly what to do with the functional specs of that
 * case; their reviewers, what to hold each to. A job holding several cases gets a section for each.
 */

const named = (specs: TouchedSpec[]) => specs.map((spec) => `fs ${spec.frid} (${spec.text})`).join("; ");

/** What the coding agent does, case by case. */
export function codeCasesBlock(cases: JobCases): string[] {
  const lines: string[] = [];
  if (cases.fresh) {
    lines.push(
      "- Nothing is built yet: set the project up first - its layout, its dependency manifest, and its unit tests",
      "  where the unit testing script runs them - then build what follows, with its unit tests.",
    );
  }
  if (cases.add.length > 0) lines.push(`- New - build each, and write its unit tests: ${named(cases.add)}.`);
  if (cases.patch.length > 0) {
    lines.push(
      `- Changed - its text, or a concept it uses: ${named(cases.patch)}.`,
      "  Its code and unit tests exist: change them to match what it says now. Do not build it again from scratch.",
    );
  }
  if (cases.delete.length > 0) {
    lines.push(`- Taken out - remove its code, and the unit tests only it had, where nothing that remains needs them: ${named(cases.delete)}.`);
  }
  if (cases.mechanical) {
    lines.push(
      "- No functional spec is touched: the change is to implementation reqs, or definitions no functional spec uses.",
      "  Adapt the code to it. Write no new tests. An existing test may change only mechanically - an import, a",
      "  fixture, its setup - never what it asserts. Every test must still pass.",
    );
  }
  return lines;
}

/** What the unit reviewer holds the work to, case by case - in place of its checks, when the job is mechanical. */
export function codeReviewCasesBlock(cases: JobCases): string[] {
  if (cases.mechanical) {
    return [
      "This work touches no functional spec - only implementation reqs, or definitions none uses. Review only that",
      "the code keeps to them and still does what it did, and that no test was removed or weakened: an assertion",
      "loosened or taken out, a case dropped, a test skipped or deleted. A test may change mechanically - an import, a",
      "fixture, its setup. Raise no missing test: this work adds no behaviour to test.",
    ];
  }
  return [
    "What this work does, by functional spec - hold each part to its own:",
    ...(cases.add.length > 0 ? [`- New: ${named(cases.add)} - implemented, and tested as below.`] : []),
    ...(cases.patch.length > 0 ? [`- Changed: ${named(cases.patch)} - the code and its tests changed to match it now, not left as they were.`] : []),
    ...(cases.delete.length > 0 ? [`- Taken out: ${named(cases.delete)} - its code and the tests only it had removed, and nothing else.`] : []),
  ];
}

/** What the conformance agent does, case by case. */
export function conformanceCasesBlock(cases: JobCases): string[] {
  const lines: string[] = [];
  if (cases.fresh) {
    lines.push(
      "- There are no conformance tests yet: set the tests folder up first - the tests' own build and layout, so the",
      "  conformance testing script, which brings the tests together with the code, runs them - then write what follows.",
    );
  }
  if (cases.add.length > 0) lines.push(`- New - write its conformance tests: ${named(cases.add)}.`);
  if (cases.patch.length > 0) {
    lines.push(
      `- Changed - its text, its acceptance tests, or a concept it uses: ${named(cases.patch)}.`,
      "  Its conformance tests exist: rewrite them to what it says now. The tests of everything else stay as they are.",
    );
  }
  if (cases.delete.length > 0) lines.push(`- Taken out - remove its conformance tests: ${named(cases.delete)}.`);
  if (cases.mechanical) {
    lines.push(
      "- No functional spec is touched: the change is to the test reqs, or to definitions or implementation reqs alone.",
      "  Adapt the existing tests to it. Write no new tests. A test may change only mechanically - how it is built,",
      "  started or reaches the software - never what it asserts. Every test must still pass.",
    );
  }
  return lines;
}

/** What the conformance test reviewer holds the tests to, when the job is mechanical: in place of its checks. */
export function conformanceReviewCasesBlock(cases: JobCases): string[] {
  if (!cases.mechanical) return [];
  return [
    "This work touches no functional spec - only the test reqs, or definitions or implementation reqs alone. Review",
    "only that the tests follow them, and that no test was removed or weakened: an assertion loosened or taken out, a",
    "case dropped, a test skipped or deleted. A test may change mechanically. Raise no missing test.",
  ];
}
