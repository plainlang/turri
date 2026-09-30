import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ACCEPTANCE_TESTS,
  DEFINITIONS,
  FUNCTIONAL_REQUIREMENTS,
  NON_FUNCTIONAL_REQUIREMENTS,
  REQUIRED_FUNCTIONAL_SPECS,
  TEST_REQUIREMENTS,
  getInheritedFunctionalSpecs,
  type MarshalledPlainSource,
} from "../plain/spec.ts";
import { validateConcepts } from "../plain/concepts.ts";
import { sectionTag } from "./prompt.ts";

/**
 * The steps from one spec to another: a sequence of spec diffs that, rendered one after the
 * other, take code built from the first spec to code built from the second.
 *
 * Both specs are marshalled trees, written out as text with one JSON value per line - a
 * section's name, then each of its items on a line of its own - and compared with git. So an
 * item is the unit of change: a functional spec with its acceptance tests and linked resources,
 * a definition, a req. Git lines them up, so a spec inserted in the middle is one addition and
 * the specs after it are untouched, though their numbers moved.
 *
 * The planner (`chunk-plan.ts`) cuts the changes into steps - which go together, which go first. It
 * picks changes by id; it never writes a diff. `makeStep` applies what it picked, and `inconsistencies`
 * checks that each step leaves a spec that holds together - no concept used before a step defines it.
 */

/** The sections of a tree, in the order they are written. Written even when empty, so they never change. */
export const TREE_SECTIONS = [DEFINITIONS, NON_FUNCTIONAL_REQUIREMENTS, TEST_REQUIREMENTS, FUNCTIONAL_REQUIREMENTS, REQUIRED_FUNCTIONAL_SPECS];

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/**
 * A tree as text: each section's name on a line - `["definitions"]` - then one JSON value per
 * item, keys sorted. No commas and no brackets around a section, so adding an item at the end
 * changes nothing before it.
 */
export function serializeTree(tree: MarshalledPlainSource): string {
  const others = Object.keys(tree)
    .filter((key) => !TREE_SECTIONS.includes(key))
    .sort();
  const lines: string[] = [];
  for (const key of [...TREE_SECTIONS, ...others]) {
    const value = tree[key];
    if (value !== undefined && !Array.isArray(value)) {
      // Not a list of items: one value, on its own line.
      lines.push(JSON.stringify([key, "value"]), JSON.stringify(sortKeys(value)));
      continue;
    }
    if (value === undefined && !TREE_SECTIONS.includes(key)) continue;
    lines.push(JSON.stringify([key]));
    for (const item of (value as unknown[] | undefined) ?? []) lines.push(JSON.stringify(sortKeys(item)));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Whether two trees are the same spec, however it is laid out across files: the definitions, the
 * implementation and test reqs the same - in any order, from the module's own file or an imported
 * one - and the functional specs the same, in order, those it inherits then its own, whichever
 * module each is written in. Specs moved between a module and the ones it requires are the same
 * spec: the code holds them all. But a module required now that was not before is not - its code
 * is not in this codebase - so `after` may only drop required modules, never gain one.
 *
 * What it takes to tell a restructuring of the specs - definitions moved to a common module,
 * sections reordered - from a change: one of these has nothing to render.
 */
export function sameSpec(before: MarshalledPlainSource, after: MarshalledPlainSource): boolean {
  const modulesOf = (tree: MarshalledPlainSource) => new Set(getInheritedFunctionalSpecs(tree).map((spec) => spec.module));
  const had = modulesOf(before);
  if ([...modulesOf(after)].some((module) => !had.has(module))) return false;
  const text = (item: unknown) => {
    const { module: _module, frid: _frid, ...rest } = item as Record<string, unknown>;
    return JSON.stringify(sortKeys(rest));
  };
  const list = (tree: MarshalledPlainSource, heading: string) => ((tree[heading] as unknown[] | undefined) ?? []).map(text);
  const shape = (tree: MarshalledPlainSource) => {
    const others = Object.keys(tree)
      .filter((key) => !TREE_SECTIONS.includes(key))
      .sort()
      .map((key) => [key, sortKeys(tree[key])]);
    return JSON.stringify({
      sections: [DEFINITIONS, NON_FUNCTIONAL_REQUIREMENTS, TEST_REQUIREMENTS].map((heading) => list(tree, heading).sort()),
      specs: [...list(tree, REQUIRED_FUNCTIONAL_SPECS), ...list(tree, FUNCTIONAL_REQUIREMENTS)],
      others,
    });
  };
  return shape(before) === shape(after);
}

/** Whether a line of a serialized tree is a section's name rather than an item. */
function headerOf(line: string): { key: string; value: boolean } | undefined {
  if (!line.startsWith("[")) return undefined;
  const parsed = JSON.parse(line) as unknown[];
  return { key: parsed[0] as string, value: parsed[1] === "value" };
}

/** A serialized tree read back. A known section with no items is left out, as the parser leaves it. */
export function parseTree(text: string): MarshalledPlainSource {
  const tree: MarshalledPlainSource = {};
  let section: string | undefined;
  let single = false;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const header = headerOf(line);
    if (header !== undefined) {
      section = header.key;
      single = header.value;
      if (!single && !TREE_SECTIONS.includes(section)) tree[section] = [];
      continue;
    }
    if (section === undefined) throw new Error(`An item before any section: ${line}`);
    const item = JSON.parse(line) as unknown;
    if (single) tree[section] = item;
    else tree[section] = [...((tree[section] as unknown[] | undefined) ?? []), item];
  }
  return tree;
}

/** git's diff of two serialized trees, with `context` lines around each change. */
export function diffTrees(before: string, after: string, context = 3): string {
  return gitDiff(before, after, context, ["spec.before", "spec.after"]);
}

/** git's diff of two texts, written to files of the names given. */
function gitDiff(before: string, after: string, context: number, [from, to]: [string, string]): string {
  const dir = mkdtempSync(join(tmpdir(), "plainwright-spec-steps-"));
  try {
    // The names are paths - "plain/hubspot.plain" for a spec in a folder of the project: their folders first.
    mkdirSync(dirname(join(dir, "a", from)), { recursive: true });
    mkdirSync(dirname(join(dir, "b", to)), { recursive: true });
    writeFileSync(join(dir, "a", from), before);
    writeFileSync(join(dir, "b", to), after);
    const run = spawnSync(
      "git",
      ["diff", "--no-index", "--no-color", "--no-ext-diff", "--no-prefix", `-U${context}`, `a/${from}`, `b/${to}`],
      { cwd: dir, encoding: "utf8" },
    );
    // 1 means the two differ: that is the diff, not a failure.
    if (run.status !== 0 && run.status !== 1) throw new Error(`git diff failed: ${run.stderr}`);
    // As a spec diff written in the interview reads: no index line, and no heading git guesses
    // for a hunk - in a .plain file that is whatever line above it starts with a letter.
    return run.stdout
      .split("\n")
      .filter((line) => !line.startsWith("index "))
      .map((line) => line.replace(/^(@@ -\S+ \+\S+ @@).*$/, "$1"))
      .join("\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * One change between two serialized trees: an item added, removed, or changed in place. Where it
 * goes is given in the lines of the tree it applies to, so any selection of changes applies to
 * that tree on its own, in any order.
 */
export interface SpecChange {
  id: string;
  /** The section the item is in. */
  section: string;
  kind: "add" | "remove" | "change";
  /** The item's line as it is, for a removal or a change. */
  before?: string;
  /** The item's line as it becomes, for an addition or a change. */
  after?: string;
  /** Its number in its section, from 1: where it is now, or - for an addition - where it lands in the target. */
  position: number;
  /** The line it removes, in the tree it applies to. */
  removes?: number;
  /** The line it goes in front of, and its place among others that go there. */
  inserts?: { at: number; order: number };
}

/** Which section each line of a serialized tree is in, and each line's number within it. */
function sectionsOfLines(lines: string[]): Array<{ section: string; index: number }> {
  let section = "";
  let index = 0;
  return lines.map((line) => {
    const header = headerOf(line);
    if (header !== undefined) {
      section = header.key;
      index = 0;
      return { section, index: 0 };
    }
    index += 1;
    return { section, index };
  });
}

/** The changes that take one serialized tree to another, in the order git lists them. */
export function changesBetween(before: string, after: string): SpecChange[] {
  const lines = before.split("\n").slice(0, -1);
  const where = sectionsOfLines(lines);
  const whereAfter = sectionsOfLines(after.split("\n").slice(0, -1));
  const changes: SpecChange[] = [];
  let order = 0;
  const hunks = diffTrees(before, after, 0).split("\n");
  for (let i = 0; i < hunks.length; i += 1) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,\d+)? @@/.exec(hunks[i]!);
    if (match === null) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    // Where the added lines are in the target: from its line numbers, their numbers in their sections.
    const addedFrom = Number(match[3]) - 1;
    // git numbers from 1, and an empty side names the line before it.
    const first = count === 0 ? start : start - 1;
    const removed: string[] = [];
    const added: string[] = [];
    for (i += 1; i < hunks.length && !hunks[i]!.startsWith("@@"); i += 1) {
      const line = hunks[i]!;
      if (line.startsWith("-")) removed.push(line.slice(1));
      else if (line.startsWith("+")) added.push(line.slice(1));
    }
    i -= 1;

    // An item replaced by one like it is a change to it; one replaced by something else is a
    // removal and an addition - a spec taken out and another put where it was are two changes,
    // not one. Pairs keep their order on both sides, and a section's name is never paired.
    const pairs = pairItems(removed, added);
    const pairOfRemoved = new Map(pairs.map(([r, a]) => [r, a]));
    const pairedAdded = new Set(pairs.map(([, a]) => a));
    // Each change in the order git lists the lines: removals, then what is added. An addition
    // goes in front of the line of the next pair after it - where it sits in the target - or,
    // with none, after the last removed line.
    const nextId = () => `c${changes.length + 1}`;
    const end = first + removed.length;
    const anchorOf = (a: number) => {
      const next = pairs.find(([, pa]) => pa > a);
      return next === undefined ? end : first + next[0];
    };
    const orderOf = new Map(added.map((_, a) => [a, order++]));
    removed.forEach((line, r) => {
      const at = first + r;
      const a = pairOfRemoved.get(r);
      if (a !== undefined) {
        changes.push({
          id: nextId(),
          section: where[at]!.section,
          kind: "change",
          before: line,
          after: added[a]!,
          position: where[at]!.index,
          removes: at,
          inserts: { at, order: orderOf.get(a)! },
        });
      } else {
        changes.push({ id: nextId(), section: where[at]!.section, kind: "remove", before: line, position: where[at]!.index, removes: at });
      }
    });
    added.forEach((line, a) => {
      if (pairedAdded.has(a)) return;
      const at = anchorOf(a);
      const landing = whereAfter[addedFrom + a]!;
      changes.push({
        id: nextId(),
        section: landing.section,
        kind: "add",
        after: line,
        position: landing.index,
        inserts: { at, order: orderOf.get(a)! },
      });
    });
  }
  return changes;
}

/** The words of an item's text, for telling a changed item from a different one. */
function wordsOf(line: string): Set<string> {
  const item = JSON.parse(line) as { markdown?: string };
  return new Set((item.markdown ?? line).toLowerCase().match(/[a-z0-9_]+/g) ?? []);
}

/** How alike two items are: the share of their words they have in common. */
export function similarity(a: string, b: string): number {
  const x = wordsOf(a);
  const y = wordsOf(b);
  if (x.size === 0 && y.size === 0) return 1;
  let shared = 0;
  for (const word of x) if (y.has(word)) shared += 1;
  return shared / (x.size + y.size - shared);
}

/** Alike enough to be the same item, changed. */
const SAME_ITEM = 0.5;

/**
 * Which removed item became which added one, in order on both sides: the pairing that matches
 * the most alike items. Only items at least SAME_ITEM alike are paired.
 */
function pairItems(removed: string[], added: string[]): Array<[number, number]> {
  const alike = (r: number, a: number) =>
    headerOf(removed[r]!) === undefined && headerOf(added[a]!) === undefined && similarity(removed[r]!, added[a]!) >= SAME_ITEM
      ? similarity(removed[r]!, added[a]!)
      : 0;
  // Best total likeness over order-keeping pairings - a longest common subsequence, weighted.
  const best = Array.from({ length: removed.length + 1 }, () => new Array<number>(added.length + 1).fill(0));
  for (let r = removed.length - 1; r >= 0; r -= 1) {
    for (let a = added.length - 1; a >= 0; a -= 1) {
      const score = alike(r, a);
      best[r]![a] = Math.max(best[r + 1]![a]!, best[r]![a + 1]!, score > 0 ? score + best[r + 1]![a + 1]! : 0);
    }
  }
  const pairs: Array<[number, number]> = [];
  for (let r = 0, a = 0; r < removed.length && a < added.length; ) {
    const score = alike(r, a);
    if (score > 0 && best[r]![a] === score + best[r + 1]![a + 1]!) {
      pairs.push([r, a]);
      r += 1;
      a += 1;
    } else if (best[r]![a] === best[r + 1]![a]!) r += 1;
    else a += 1;
  }
  return pairs;
}

/** A selection of changes, applied to the serialized tree they were found in. */
export function applyChanges(before: string, changes: SpecChange[]): string {
  const lines = before.split("\n").slice(0, -1);
  const removed = new Set(changes.flatMap((change) => (change.removes === undefined ? [] : [change.removes])));
  const inserts = changes
    .filter((change) => change.inserts !== undefined)
    .sort((a, b) => a.inserts!.order - b.inserts!.order);
  const out: string[] = [];
  for (let at = 0; at <= lines.length; at += 1) {
    for (const change of inserts) if (change.inserts!.at === at) out.push(change.after!);
    if (at < lines.length && !removed.has(at)) out.push(lines[at]!);
  }
  return `${out.join("\n")}\n`;
}

/** An item as a person reads it: its text, and its acceptance tests under it. */
function itemText(line: string): string {
  const item = JSON.parse(line) as { markdown?: string; [ACCEPTANCE_TESTS]?: Array<{ markdown?: string }> };
  const tests = item[ACCEPTANCE_TESTS] ?? [];
  return [
    item.markdown ?? line,
    ...(tests.length > 0 ? ["  <acceptance tests>", ...tests.map((test) => `  ${(test.markdown ?? "").replace(/\n/g, "\n  ")}`), "  </acceptance tests>"] : []),
  ].join("\n");
}

/** A serialized tree as a person reads it, section by section. */
export function treeText(serialized: string): string {
  const out: string[] = [];
  // Each section in its tag, as every agent is shown a spec (see specPrimer).
  let open: string | undefined;
  for (const line of serialized.split("\n")) {
    if (line === "") continue;
    const header = headerOf(line);
    if (header !== undefined) {
      if (open !== undefined) out.push(`</${open}>`, "");
      open = sectionTag(header.key);
      out.push(`<${open}>`);
    } else out.push(itemText(line));
  }
  if (open !== undefined) out.push(`</${open}>`);
  return out.join("\n").trim();
}

/** What of an item a change touches: its text, its acceptance tests, its linked resources. */
function changedParts(before: string, after: string): string {
  if (headerOf(before) !== undefined || headerOf(after) !== undefined) return "the text";
  const x = JSON.parse(before) as Record<string, unknown>;
  const y = JSON.parse(after) as Record<string, unknown>;
  const names: Record<string, string> = { markdown: "the text", [ACCEPTANCE_TESTS]: "the acceptance tests", linked_resources: "the linked resources", code_variables: "the code variables" };
  const parts = [...new Set([...Object.keys(x), ...Object.keys(y)])]
    .filter((key) => JSON.stringify(x[key]) !== JSON.stringify(y[key]))
    .map((key) => names[key] ?? key);
  return parts.length === 0 ? "the text" : parts.join(" and ");
}

/** A change as the planning agent is shown it. */
export function describeChange(change: SpecChange): string {
  const what =
    change.kind === "add"
      ? `add to ${change.section}, as item ${change.position}`
      : change.kind === "remove"
        ? `remove item ${change.position} of ${change.section}`
        : `change ${changedParts(change.before!, change.after!)} of item ${change.position} of ${change.section}`;
  const header = (line: string | undefined) => (line !== undefined && headerOf(line) !== undefined ? `the section ${headerOf(line)!.key}` : undefined);
  const body = [
    ...(change.before !== undefined ? ["  before:", `    ${(header(change.before) ?? itemText(change.before)).replace(/\n/g, "\n    ")}`] : []),
    ...(change.after !== undefined ? ["  after:", `    ${(header(change.after) ?? itemText(change.after)).replace(/\n/g, "\n    ")}`] : []),
  ];
  return [`${change.id}: ${what}`, ...body].join("\n");
}

/** One step of the sequence: a spec diff, and the spec before and after it. */
export interface SpecStep {
  title: string;
  reason: string;
  /** The changes it makes. */
  changes: SpecChange[];
  /** The spec before and after it, serialized. */
  before: string;
  after: string;
  /** The spec after it, as a tree: what a render of this step builds from. */
  tree: MarshalledPlainSource;
  /** git's diff of `before` to `after`, as serialized. */
  diff: string;
  /**
   * The same change as a person - or a coding agent - reads a spec change: git's diff of the spec
   * before and after, written out as ***plain text, section by section.
   */
  textDiff: string;
  /** The sections it changes. */
  sections: string[];
  /** Made by the harness for what the agent never placed, after its rounds ran out. */
  fallback?: boolean;
}

/**
 * What makes a spec not hold together that neither end already has: a concept used before any
 * step defines it, or defined twice - the parser's own concept checks.
 */
export function inconsistencies(tree: MarshalledPlainSource, endpoints: Set<string>): string[] {
  return validateConcepts(tree).filter((error) => !endpoints.has(error));
}

/** How the module's `.plain` file is laid out, for writing a tree out as that file would have it. */
export interface SpecLayout {
  /** Everything before the first section: the frontmatter, imports and requires. */
  preamble: string;
  /** The sections, in the order the file has them. */
  sections: string[];
  /** Each concept's place in the file's definitions - the parser orders them by what uses what. */
  concepts: Map<string, number>;
  /** The sections whose items the file writes with no blank line between them. */
  tight: Set<string>;
}

const SECTION_HEADING = /^\*\*\*\s*(.+?)\s*\*\*\*\s*$/;
const CONCEPT = /^- :([^:\s]+):/;

export function layoutOf(text: string): SpecLayout {
  const lines = text.split("\n");
  const first = lines.findIndex((line) => SECTION_HEADING.test(line));
  const sections: string[] = [];
  const concepts = new Map<string, number>();
  const tight = new Set<string>();
  let section: string | undefined;
  let previous = "";
  for (const line of first === -1 ? [] : lines.slice(first)) {
    const heading = SECTION_HEADING.exec(line);
    if (heading) {
      section = heading[1]!;
      sections.push(section);
      previous = "";
      continue;
    }
    // An item straight after another's last line, with no blank line: the section is written tight.
    if (section !== undefined && line.startsWith("- ") && previous.trim() !== "" && !SECTION_HEADING.test(previous)) tight.add(section);
    previous = line;
    const concept = CONCEPT.exec(line);
    if (section === DEFINITIONS && concept && !concepts.has(concept[1]!)) concepts.set(concept[1]!, concepts.size);
  }
  return { preamble: first === -1 ? "" : lines.slice(0, first).join("\n").trimEnd(), sections, concepts, tight };
}

/**
 * A serialized tree as the module's `.plain` file would have it: only its own sections, and only
 * the ones with something in them. The functional specs it inherits are the required modules'
 * - `required functional specs` is the parser's key for them, not a section anyone writes. With
 * the file's layout, it is written as the file is: its preamble, its sections in its order, a
 * blank line between items, and the definitions in the file's order rather than the parser's -
 * so a spec diff reads as an edit to the file, at the file's line numbers.
 */
export function plainText(serialized: string, layout?: SpecLayout): string {
  const sections: Array<{ key: string; items: string[] }> = [];
  for (const line of serialized.split("\n")) {
    if (line === "") continue;
    const header = headerOf(line);
    if (header !== undefined) sections.push({ key: header.key, items: [] });
    else sections.at(-1)?.items.push(itemText(line));
  }
  const own = sections.filter((section) => section.key !== REQUIRED_FUNCTIONAL_SPECS && section.items.length > 0);
  if (layout === undefined) return own.map((section) => [`***${section.key}***`, "", ...section.items].join("\n")).join("\n\n");

  const place = (key: string) => {
    const index = layout.sections.indexOf(key);
    return index === -1 ? layout.sections.length + TREE_SECTIONS.indexOf(key) : index;
  };
  const rank = (item: string) => {
    const concept = CONCEPT.exec(item);
    return concept ? (layout.concepts.get(concept[1]!) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
  };
  const body = [...own]
    .sort((a, b) => place(a.key) - place(b.key))
    .map((section) => {
      // A stable sort: concepts the file does not have yet keep the parser's order, after the rest.
      const items = section.key === DEFINITIONS ? [...section.items].sort((a, b) => rank(a) - rank(b)) : section.items;
      return [`***${section.key}***`, "", items.join(layout.tight.has(section.key) ? "\n" : "\n\n")].join("\n");
    })
    .join("\n\n");
  return layout.preamble === "" ? body : `${layout.preamble}\n\n${body}`;
}

/** git's diff of two serialized trees, as ***plain text - see plainText. */
export function diffSpecText(before: string, after: string, file = "spec.plain", layout?: SpecLayout): string {
  return gitDiff(`${plainText(before, layout)}\n`, `${plainText(after, layout)}\n`, 3, [file, file]);
}

export function makeStep(title: string, reason: string, changes: SpecChange[], before: string, after: string, file: string, layout?: SpecLayout): SpecStep {
  return {
    title,
    reason,
    changes,
    before,
    after,
    tree: parseTree(after),
    diff: diffTrees(before, after),
    textDiff: diffSpecText(before, after, file, layout),
    sections: [...new Set(changes.map((change) => change.section))],
  };
}

