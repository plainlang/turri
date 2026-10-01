import { ACCEPTANCE_TESTS, DEFINITIONS, FUNCTIONAL_REQUIREMENTS, NON_FUNCTIONAL_REQUIREMENTS, TEST_REQUIREMENTS } from "../plain/spec.ts";
import type { DiffWhere } from "./diff-view.ts";
import { resourceDiff, type SpecChange } from "./spec-steps.ts";

/**
 * A job's change as its agent is given it, for the panels: the same items `describeSpecChange` writes into
 * `<spec change>` - what the job's functional specs use, from the module's own file and from the files it
 * imports and requires alike - laid out as a diff the panels already show (`diff-view.ts`). Each section is
 * a block under its header, each item as its file writes it - its markdown, its acceptance tests indented
 * under it - so placed in the .plain files (`locateDiffLines`) every line is shown in the file it is written
 * in, with its line there: split by file and by block. A text diff of the module's file would show other
 * things - the lines around a change, the items no job takes yet - and leave out what an import adds.
 */

/** The sections in the order the agent is given them, then any other. */
const ORDER = [DEFINITIONS, NON_FUNCTIONAL_REQUIREMENTS, TEST_REQUIREMENTS, FUNCTIONAL_REQUIREMENTS];

/** An item's lines as a .plain file writes them: its markdown, then its acceptance tests indented under it. */
function itemLines(serialized: string | undefined): string[] {
  if (serialized === undefined) return [];
  let item: unknown;
  try {
    item = JSON.parse(serialized);
  } catch {
    return serialized.split("\n");
  }
  if (typeof item === "string") return item.split("\n");
  const { markdown, [ACCEPTANCE_TESTS]: tests } = (item ?? {}) as { markdown?: string; [key: string]: unknown };
  const lines = (markdown ?? JSON.stringify(item)).split("\n");
  if (Array.isArray(tests) && tests.length > 0) {
    lines.push("", "    ***acceptance tests***", "");
    for (const test of tests) {
      const text = typeof test === "string" ? test : ((test as { markdown?: string }).markdown ?? JSON.stringify(test));
      lines.push(...text.split("\n").map((line) => `    ${line}`));
    }
  }
  return lines;
}

/**
 * `changes` as a diff of `file` - the module's .plain file, which the diff names - section by section: a removed
 * item's lines taken out, an added one's put in, a changed one's both. A change to what a linked file holds
 * follows, as the step's own diff has it.
 */
export function changeDiff(changes: SpecChange[], file: string): string {
  return laidOut(changes, file).diff;
}

/**
 * `changeDiff`, each section's items in the order they are written - by file, then by line - rather than in the
 * order the spec is read in, which puts a concept after those it uses: placed by `locate`, as the panels place it.
 */
export function changeDiffInFiles(changes: SpecChange[], file: string, locate: (diff: string) => DiffWhere): { diff: string; where: DiffWhere } {
  const first = laidOut(changes, file);
  const where = locate(first.diff);
  const placeOf = (change: SpecChange) => {
    const at = where[first.starts.get(change) ?? -1];
    return at === undefined ? undefined : { file: at.file, line: at.line };
  };
  const ordered = [...changes].sort((a, b) => {
    // Each section is laid out on its own: between two, any order that holds will do.
    if (a.section !== b.section) return a.section < b.section ? -1 : 1;
    const [x, y] = [placeOf(a), placeOf(b)];
    if (x === undefined || y === undefined) return a.position - b.position;
    return x.file === y.file ? x.line - y.line : (x.file === file ? -1 : y.file === file ? 1 : x.file.localeCompare(y.file));
  });
  const diff = laidOut(ordered, file, true).diff;
  return { diff, where: locate(diff) };
}

/** The diff, and the line each change starts on in it. `asGiven`: each section's items in the order given. */
function laidOut(changes: SpecChange[], file: string, asGiven = false): { diff: string; starts: Map<SpecChange, number> } {
  const starts = new Map<SpecChange, number>();
  const sections = [...new Set(changes.map((change) => change.section))].sort(
    (a, b) => (ORDER.indexOf(a) === -1 ? ORDER.length : ORDER.indexOf(a)) - (ORDER.indexOf(b) === -1 ? ORDER.length : ORDER.indexOf(b)),
  );
  const lines = [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`];
  for (const section of sections) {
    const own = changes.filter((change) => change.section === section);
    if (!asGiven) own.sort((a, b) => a.position - b.position);
    const body: string[] = [];
    // Where this section's lines start in the diff: after the lines so far, its hunk header and its section header.
    const offset = lines.length + 2;
    for (const change of own) {
      const before = change.kind === "add" ? [] : itemLines(change.before);
      const after = change.kind === "remove" ? [] : itemLines(change.after);
      // Where it is found: its first line now, or - removed - its first line as it was.
      starts.set(change, offset + body.length + (change.kind === "change" && after.length > 0 ? before.length : 0));
      // Only what a file it links holds changed: the item as it is, the file's change after the spec's.
      if (change.kind === "change" && before.join("\n") === after.join("\n")) {
        body.push(...after.map((line) => ` ${line}`));
        continue;
      }
      body.push(...before.map((line) => `-${line}`), ...after.map((line) => `+${line}`));
    }
    if (body.length === 0) continue;
    lines.push("@@ @@", ` ***${section}***`, ...body);
  }
  return { diff: `${lines.join("\n")}\n${resourceDiff(changes, file)}`, starts };
}

/** The changes a job's agent works from: a code job's leave out the test reqs, which are the conformance job's. */
export function agentChanges(changes: SpecChange[], track: "code" | "conformance"): SpecChange[] {
  return track === "conformance" ? changes : changes.filter((change) => change.section !== TEST_REQUIREMENTS);
}
