import { relative } from "node:path";
import type { TestRun } from "./testing.ts";
import type { TryIt, TryStep } from "./try-it.ts";

/**
 * What to tell someone when a functionality lands.
 *
 * A background render finishes while the person is doing something else, so the
 * notification has to stand on its own: what the software does now that it did not do
 * before, and how to run it and see that for themselves. The steps come from the agent that
 * built it, and the ones that finish on their own were run by the harness first, so each is
 * marked with whether it actually worked. Tests are a footnote - they are how the build was
 * checked, not how a person uses what was built.
 */

export interface Delivery {
  moduleName: string;
  frid: string;
  /** The functionality's own text. */
  functionality: string;
  buildDir: string;
  added: string[];
  runs: TestRun[];
  conformanceRuns?: TestRun[];
  passed: boolean;
  tryIt?: TryIt;
}

const MAX_FILES = 3;

function lastPassing(runs: TestRun[]): string | undefined {
  return runs.filter((run) => run.exitCode === 0).at(-1)?.command;
}

function shortPath(buildDir: string): string {
  const fromHere = relative(process.cwd(), buildDir);
  return fromHere === "" || fromHere.startsWith("..") ? buildDir : fromHere;
}

/** Whether a step worked when the harness ran it, as the mark after the command. */
function mark(exitCode: number | undefined): string {
  if (exitCode === undefined) return "";
  return exitCode === 0 ? "   ✓" : "   ✗ did not work when checked";
}

function stepLines(step: TryStep, n: number): string[] {
  const see = `     You should see: ${step.expect}`;
  switch (step.kind) {
    case "manual":
      return [`  ${n}. ${step.do}`, see];
    case "long_running":
      return [`  ${n}. Start it - it keeps running, so do the next steps in a second terminal:`, `     $ ${step.do}${mark(step.exitCode)}`, see];
    default:
      return [`  ${n}. $ ${step.do}${mark(step.exitCode)}`, see];
  }
}

function tryItLines(delivery: Delivery): string[] {
  return describeTryIt(delivery.tryIt, delivery.buildDir);
}

/**
 * The "Try it" block, for a person reading it once: where to go, what to set up, then numbered
 * steps - each one thing to run or do, and what they should see. Commands carry a ✓ when they
 * worked when checked; one that did not is marked, and the block says so up front.
 */
export function describeTryIt(tryIt: TryIt | undefined, buildDir: string): string[] {
  const lines = ["", "Try it"];
  if (tryIt === undefined) {
    lines.push("  (how to try it was not worked out for this build - ask, and it can be from the code)");
    return lines;
  }

  const failed = (tryIt.failedSetup?.length ?? 0) > 0 || tryIt.steps.some((step) => step.exitCode !== undefined && step.exitCode !== 0);
  if (failed) lines.push("  Some of these did not work when checked (marked ✗) - they may not work for you either.");
  lines.push(`  In a fresh copy of the build:`, `  $ cd ${shortPath(tryIt.dir ?? buildDir)}`);

  if (tryIt.setup.length > 0) {
    lines.push("", "  Set up once:");
    for (const command of tryIt.setup) {
      const didFail = tryIt.failedSetup?.includes(command);
      const wasRun = !didFail && !(tryIt.failedSetup?.length ?? 0);
      lines.push(`  $ ${command}${didFail ? mark(1) : wasRun ? mark(0) : ""}`);
    }
  }
  lines.push("");
  tryIt.steps.forEach((step, index) => lines.push(...stepLines(step, index + 1)));
  return lines;
}

function footer(delivery: Delivery): string {
  const parts: string[] = [];
  const count = delivery.added.length;
  if (count > 0) {
    const shown = delivery.added.slice(0, MAX_FILES).join(", ");
    parts.push(`${count} new file${count === 1 ? "" : "s"} (${shown}${count > MAX_FILES ? ", …" : ""})`);
  }
  const unit = lastPassing(delivery.runs);
  if (unit !== undefined) parts.push(`unit tests pass (${unit})`);
  const conformance = delivery.conformanceRuns ? lastPassing(delivery.conformanceRuns) : undefined;
  if (conformance !== undefined) parts.push(`conformance tests pass (${conformance})`);
  return parts.join(" · ");
}

export function describeDelivery(delivery: Delivery): string {
  const lines: string[] = [
    delivery.passed
      ? `${delivery.moduleName}: functionality ${delivery.frid} is ready to try.`
      : `${delivery.moduleName}: functionality ${delivery.frid} was built, but its tests are not passing.`,
  ];

  const functionality = delivery.functionality.trim();
  if (functionality !== "") {
    lines.push("", "What's new", ...functionality.split("\n").map((line) => `  ${line}`));
  }

  // Instructions for software that is not working would send the person after something
  // that does not exist yet.
  if (delivery.passed) lines.push(...tryItLines(delivery));

  const small = footer(delivery);
  if (small !== "") lines.push("", small);

  return lines.join("\n");
}
