import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listFiles } from "./testing.ts";

/**
 * The two kinds of test the conformance step writes, and how each is told apart in the code.
 *
 * Conformance tests are written from the functional spec itself: what the functionality does,
 * its edge cases, its errors - as if no acceptance tests had been given. Acceptance tests are the
 * ones the spec's author wrote, each implemented as a test of its own, doing what it says. The
 * two are kept apart even when the acceptance tests would seem to cover the functionality: tests
 * derived only from the acceptance tests check what the author thought to check, and nothing
 * the spec says beyond it.
 *
 * Each kind is labelled where anyone reading the tests can see it - in its file names, and in a
 * comment the harness looks for - so which test is which, and which acceptance test a test
 * implements, never has to be guessed.
 */

export function conformanceLabel(frid: string): string {
  return `conformance tests of functionality ${frid}`;
}

export function acceptanceLabel(frid: string, n: number): string {
  return `acceptance test ${n} of functionality ${frid}`;
}

/** An acceptance test as the spec gives it, without its bullet. */
export function acceptanceText(item: string): string {
  return item.trim().replace(/^[-*]\s+/, "");
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

/**
 * What is missing from the labelling of a functionality's tests: the conformance label, when no
 * test file carries it, and each acceptance test no test is labelled as implementing.
 */
export function missingTestLabels(testsDir: string, frid: string, acceptanceTests: string[]): string[] {
  const text = normalise(
    listFiles(testsDir)
      .map((file) => {
        try {
          return readFileSync(join(testsDir, file), "utf8");
        } catch {
          return "";
        }
      })
      .join("\n"),
  );
  // Functionality 2's label must not be found in functionality 2.1's.
  const has = (label: string) =>
    new RegExp(`${normalise(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9.]*[0-9])`).test(text);
  const missing: string[] = [];
  if (!has(conformanceLabel(frid))) missing.push(`No test file is labelled "${conformanceLabel(frid)}".`);
  acceptanceTests.forEach((item, i) => {
    if (!has(acceptanceLabel(frid, i + 1))) missing.push(`No test is labelled "${acceptanceLabel(frid, i + 1)}": ${acceptanceText(item)}`);
  });
  return missing;
}

/** Sent back when the labels are missing: which, and how to label them. */
export function labelsPrompt(frid: string, missing: string[]): string {
  return [
    `The tests pass, but they are not labelled as the two kinds they must be kept apart as:`,
    "",
    ...missing.map((line) => `- ${line}`),
    "",
    `Every conformance test file of functionality ${frid} has a comment "${conformanceLabel(frid)}" at its top.`,
    `Every acceptance test is its own test, with a comment right above it: "${acceptanceLabel(frid, 1)}:" and the`,
    "acceptance test's text. Add what is missing - an acceptance test that is not implemented yet is written as a",
    "test of its own, not folded into a conformance test - and run the tests again.",
  ].join("\n");
}
