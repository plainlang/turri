import { relative } from "node:path";
import type { TestRun } from "./testing.ts";

/**
 * What to tell someone when a functionality lands.
 *
 * A background render finishes while the person is doing something else, so the
 * notification has to stand on its own: what the software does now that it did not do
 * before, and that they can try it by asking - `deploy` sets it up from what is built. Tests
 * are a footnote - they are how the build was checked, not how a person uses what was built.
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
  /** End with the offer to try it. Default true; off when a conformance job follows, which makes the offer instead. */
  offerTry?: boolean;
}

const MAX_FILES = 3;

function lastPassing(runs: TestRun[]): string | undefined {
  return runs.filter((run) => run.exitCode === 0).at(-1)?.command;
}

function shortPath(buildDir: string): string {
  const fromHere = relative(process.cwd(), buildDir);
  return fromHere === "" || fromHere.startsWith("..") ? buildDir : fromHere;
}

/** What every job that lands code ends with: the person can try it now, by asking. */
export const TRY_IT_LINE = "Want to try it? Just ask me - I'll set it up from what's built so far.";

/** The same for a command-line run, which has no one to ask: the command that does it. */
export function tryItCommand(plainFile: string): string {
  return `To try it: plainwright deploy ${shortPath(plainFile)}`;
}

/** A job's report, ending with how to try what it built when it landed. */
export function withTryItLine(report: string, landed: boolean): string {
  return landed ? `${report}\n\n${TRY_IT_LINE}` : report;
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
    !delivery.passed
      ? `${delivery.moduleName}: functionality ${delivery.frid} was built, but its tests are not passing.`
      : delivery.offerTry === false
        ? `${delivery.moduleName}: functionality ${delivery.frid} is built - its conformance tests come next.`
        : `${delivery.moduleName}: functionality ${delivery.frid} is ready to try.`,
  ];

  const functionality = delivery.functionality.trim();
  if (functionality !== "") {
    lines.push("", "What's new", ...functionality.split("\n").map((line) => `  ${line}`));
  }

  const small = footer(delivery);
  if (small !== "") lines.push("", small);

  // Software that is not working is nothing to try yet.
  return withTryItLine(lines.join("\n"), delivery.passed && delivery.offerTry !== false);
}
