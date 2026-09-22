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

function stepLines(step: TryStep): string[] {
  const verdict =
    step.exitCode === undefined ? "" : step.exitCode === 0 ? "  ✓ checked" : `  ✗ failed when checked (exit ${step.exitCode})`;
  switch (step.kind) {
    case "manual":
      return [`  Then: ${step.do}`, `    → ${step.expect}`];
    case "long_running":
      return [`  $ ${step.do}`, "    (keeps running - stop it with Ctrl-C)", `    → ${step.expect}`];
    default:
      return [`  $ ${step.do}${verdict}`, `    → ${step.expect}`];
  }
}

function tryItLines(delivery: Delivery): string[] {
  const tryIt = delivery.tryIt;
  const lines = ["", "Try it", `  $ cd ${shortPath(tryIt?.dir ?? delivery.buildDir)}`];
  if (tryIt?.dir !== undefined) {
    lines.push("    (a copy of the build as it is now - later renders do not touch it)");
  }

  if (tryIt === undefined) {
    lines.push("  (the build did not say how to run it - ask and it can be worked out from the code)");
    return lines;
  }

  for (const command of tryIt.setup) {
    const failed = tryIt.failedSetup?.includes(command);
    lines.push(`  $ ${command}${failed ? "  ✗ failed when checked" : ""}`);
  }
  if (tryIt.setup.length > 0) lines.push("    (one-off setup)");
  for (const step of tryIt.steps) lines.push(...stepLines(step));
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
