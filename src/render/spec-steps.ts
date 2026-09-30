import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  ACCEPTANCE_TESTS,
  DEFINITIONS,
  FUNCTIONAL_REQUIREMENTS,
  NON_FUNCTIONAL_REQUIREMENTS,
  REQUIRED_FUNCTIONAL_SPECS,
  TEST_REQUIREMENTS,
  getFrids,
  getInheritedFunctionalSpecs,
  type MarshalledPlainSource,
} from "../plain/spec.ts";
import { validateConcepts } from "../plain/concepts.ts";
import { sectionsOf, specStateFor } from "./state.ts";
import { ask, createExecutor } from "../pi.ts";
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
 * An agent orders the changes into steps - which go together, which go first. It picks changes
 * by id; it never writes a diff. The harness applies what it picked, checks that each step leaves
 * a spec that holds together - no concept used before a step defines it - and compares the
 * result with the target. Whatever the agent left out, or placed in a step that did not hold, is
 * diffed again from where its good steps got to, and it is asked about that - until applying
 * every step, in order, gives the target exactly.
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
 * Whether `to` is `from` with functional specs added at the end, and nothing else: every other
 * section the same, `from`'s functional specs unchanged and in order at the start of `to`'s, and
 * at least one more after them. Two trees the same are not - nothing was added.
 *
 * Such a change needs no spec diff: the new functional specs are built one by one, on top of
 * what is there, as a module is.
 */
export function onlyAppendsFunctionalSpecs(from: MarshalledPlainSource, to: MarshalledPlainSource): boolean {
  const before = (from[FUNCTIONAL_REQUIREMENTS] as unknown[] | undefined) ?? [];
  const after = (to[FUNCTIONAL_REQUIREMENTS] as unknown[] | undefined) ?? [];
  if (after.length <= before.length) return false;
  // `to` without what it added has to be `from`, exactly.
  return serializeTree({ ...to, [FUNCTIONAL_REQUIREMENTS]: after.slice(0, before.length) }) === serializeTree({ ...from, [FUNCTIONAL_REQUIREMENTS]: before });
}

/**
 * Whether `current` is `built` with functional specs added at the end, and nothing else - so the
 * new ones are rendered one by one, on top of what is there, as render_module builds a module.
 * The definitions, the implementation and test reqs and the inherited functional specs as built,
 * and the functional specs built unchanged at the start of the spec. Nothing of the module's own
 * built yet is the first case of it: its first render is built from the spec as it stands. Two the
 * same are too: there is nothing to do. Anything else - a spec changed in place, a req added, a
 * definition changed - takes spec diffs.
 *
 * Compared as the specs read - their text, with their acceptance tests - so a tree recorded by an
 * earlier plainwright, which kept the text, compares as it should.
 */
export function reachedByRendering(built: MarshalledPlainSource | null, current: MarshalledPlainSource): boolean {
  const builtFrids = built === null ? [] : [...getFrids(built)];
  // Nothing of the module's own built - no functional spec, no section: only what it inherits,
  // or nothing at all. A spec change that built the sections has built something, and what was
  // added to them since is a change like any other.
  const ownSections = built === null ? [] : Object.values(sectionsOf(built)).flat();
  if (builtFrids.length === 0 && ownSections.length === 0) return true;
  const currentFrids = [...getFrids(current)];
  if (builtFrids.length > currentFrids.length) return false;
  const own = (tree: MarshalledPlainSource, frid: string) => {
    const { spec, acceptanceTests } = specStateFor(tree, frid);
    return JSON.stringify([spec, acceptanceTests ?? []]);
  };
  // The sections in any order: definitions moved to a common module read the same.
  const around = (tree: MarshalledPlainSource) =>
    JSON.stringify([Object.entries(sectionsOf(tree)).map(([heading, texts]) => [heading, [...texts].sort()]), getInheritedFunctionalSpecs(tree)]);
  return around(built!) === around(current) && builtFrids.every((frid) => own(built!, frid) === own(current, frid));
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
    mkdirSync(join(dir, "a"));
    mkdirSync(join(dir, "b"));
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

/** A step as the agent planned it: the changes it takes, by id. */
export interface PlannedStep {
  title: string;
  reason: string;
  changes: string[];
}

export interface PlanRequest {
  /** The spec as the steps planned so far leave it, serialized. */
  current: string;
  /** The spec to get to, serialized. */
  target: string;
  /** What is left to do, by id. */
  changes: SpecChange[];
  /** The steps planned in earlier rounds, already applied to `current`. */
  planned: Array<{ title: string; reason: string }>;
  /** 1 for the first request; later ones are about what the first left out. */
  round: number;
  /** What was wrong with the last round's answer, when anything was. */
  feedback?: string;
}

export type Planner = (request: PlanRequest) => Promise<PlannedStep[]>;

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

export interface SpecStepsResult {
  steps: SpecStep[];
  /** What each round asked about and what came back of it. */
  rounds: Array<{ round: number; asked: number; placed: number; problems: string[] }>;
}

export const DEFAULT_PLAN_ROUNDS = 4;

/**
 * The steps from one tree to another. Applying every step's changes, in order, gives `to`
 * exactly: that is checked, round after round, until it holds.
 */
export async function planSpecSteps(
  from: MarshalledPlainSource,
  to: MarshalledPlainSource,
  options: {
    planner: Planner;
    maxRounds?: number;
    /** What the text diffs call the spec: the module's .plain file. */
    specFile?: string;
    /** That file's text, whose layout the text diffs follow - see layoutOf. */
    specText?: string;
  },
): Promise<SpecStepsResult> {
  const file = options.specFile ?? "spec.plain";
  const layout = options.specText !== undefined ? layoutOf(options.specText) : undefined;
  const target = serializeTree(to);
  let current = serializeTree(from);
  const steps: SpecStep[] = [];
  const rounds: SpecStepsResult["rounds"] = [];
  const maxRounds = options.maxRounds ?? DEFAULT_PLAN_ROUNDS;
  let feedback: string | undefined;
  // What is wrong with the spec at either end is not the steps' doing.
  const endpoints = new Set([...validateConcepts(from), ...validateConcepts(to)]);

  for (let round = 1; round <= maxRounds && current !== target; round += 1) {
    const changes = changesBetween(current, target);
    const byId = new Map(changes.map((change) => [change.id, change]));
    const planned = await options.planner({
      current,
      target,
      changes,
      planned: steps.map(({ title, reason }) => ({ title, reason })),
      round,
      feedback,
    });

    // What the answer placed, each change once, in the order given. The rest is asked about again.
    const problems: string[] = [];
    const used = new Set<string>();
    const taken: Array<{ step: PlannedStep; changes: SpecChange[] }> = [];
    for (const step of planned) {
      const picked: SpecChange[] = [];
      for (const id of step.changes) {
        const change = byId.get(id);
        if (change === undefined) problems.push(`"${step.title}" names ${id}, which is not one of the changes.`);
        else if (used.has(id)) problems.push(`"${step.title}" names ${id}, which an earlier step already takes.`);
        else {
          used.add(id);
          picked.push(change);
        }
      }
      if (picked.length > 0) taken.push({ step, changes: picked });
      else problems.push(`"${step.title}" takes no change of its own, so it was left out.`);
    }
    const missing = changes.filter((change) => !used.has(change.id));
    if (missing.length > 0) problems.push(`No step takes ${missing.map((change) => change.id).join(", ")}.`);

    // Every step from this round applies to the same tree, `current`: step k is the first k
    // together. Each has to leave a spec that holds together - every concept it uses defined,
    // none defined twice - or it, and every step after it in this answer, is asked about again.
    const base = current;
    const sofar: SpecChange[] = [];
    let previous = base;
    let placed = 0;
    for (const { step, changes: picked } of taken) {
      const next = applyChanges(base, [...sofar, ...picked]);
      const wrong = inconsistencies(parseTree(next), endpoints);
      if (wrong.length > 0) {
        const after = taken.length - taken.findIndex((entry) => entry.step === step) - 1;
        problems.push(
          `"${step.title}" leaves the specification inconsistent, so it${after > 0 ? ` and the ${after} step${after === 1 ? "" : "s"} after it` : ""} ` +
            `were not taken:\n${wrong.map((error) => `  - ${error}`).join("\n")}`,
        );
        break;
      }
      sofar.push(...picked);
      placed += picked.length;
      steps.push(makeStep(step.title, step.reason, picked, previous, next, file, layout));
      previous = next;
    }
    current = previous;
    rounds.push({ round, asked: changes.length, placed, problems });
    feedback = problems.length > 0 ? problems.join("\n") : undefined;
  }

  if (current !== target) {
    // The rounds ran out with changes still unplaced: they go in one last step of their own,
    // so the sequence is complete whatever the agent did.
    const rest = changesBetween(current, target);
    steps.push({
      ...makeStep("The rest of the change", "Changes no planned step placed.", rest, current, applyChanges(current, rest), file, layout),
      fallback: true,
    });
    current = steps.at(-1)!.after;
  }
  if (current !== target) throw new Error("The steps do not add up to the target spec - this is a bug in plainwright.");
  return { steps, rounds };
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

/** What the planning agent is asked. */
export function planPrompt(request: PlanRequest): string {
  return [
    "Code has been built from one ***plain specification, and the specification has since changed. The code is",
    "to be brought up to date as a sequence of steps: each step is one spec change, rendered by a coding agent on",
    "its own, then its tests are brought in line, before the next step starts. Order the changes below into those",
    "steps.",
    "",
    "How to cut them:",
    "- A step is about one thing a person would name: a feature, a rule, a fix. Roughly one functional spec per step.",
    "- A definition goes in the first step whose functional spec uses it. A definition no step uses goes in the step",
    "  whose subject it belongs to, or on its own.",
    "- An implementation req that concerns one feature goes with that feature. One that concerns the whole codebase",
    "  goes in a step of its own, before the features that should be built with it.",
    "- A change to the test reqs, or to acceptance tests alone, goes in a step of its own: it changes only the tests.",
    "- A step never uses a concept a later step defines, and never relies on a functional spec a later step adds.",
    "- Keep the order of the functional specs, unless one depends on another that comes after it.",
    "- A removal goes with whatever replaces it; the removal of a spec goes with the removal of what only it used.",
    "",
    "Every change goes in exactly one step. Call submit_plan once, with the steps in order.",
    ...(request.round > 1
      ? [
          "",
          `This is round ${request.round}. These steps are already planned, and applied to the specification below:`,
          ...request.planned.map((step, index) => `${index + 1}. ${step.title}`),
          ...(request.feedback !== undefined ? ["", "What was wrong with the last answer:", request.feedback] : []),
          "",
          "Plan the steps that come after them, for the changes still left.",
        ]
      : []),
    "",
    "<specification as it stands>",
    treeText(request.current),
    "</specification as it stands>",
    "",
    "<specification to get to>",
    treeText(request.target),
    "</specification to get to>",
    "",
    "<changes>",
    request.changes.map(describeChange).join("\n\n"),
    "</changes>",
  ].join("\n");
}

/** The planning agent: a model with one tool, to hand its plan back with. */
export function llmPlanner(options: { cwd: string; model?: string; label?: string }): Planner {
  return async (request) => {
    let steps: PlannedStep[] | undefined;
    const submit: ToolDefinition = defineTool({
      name: "submit_plan",
      label: "Submit plan",
      description: "Hand back the steps, in order. Call this exactly once.",
      parameters: Type.Object({
        steps: Type.Array(
          Type.Object({
            title: Type.String({ description: "What the step does, in a few words" }),
            reason: Type.String({ description: "Why these changes go together, and why here in the order" }),
            changes: Type.Array(Type.String(), { description: 'The ids of the changes it makes, e.g. ["c1", "c4"]' }),
          }),
        ),
      }),
      async execute(_id, params) {
        steps = (params as { steps: PlannedStep[] }).steps;
        return { content: [{ type: "text" as const, text: "Plan recorded." }], details: {}, terminate: true };
      },
    }) as ToolDefinition;
    const session = await createExecutor({
      cwd: options.cwd,
      customTools: [submit],
      tools: ["submit_plan"],
      model: options.model,
      label: options.label ?? "spec steps planner",
    });
    try {
      await ask(session, planPrompt(request));
    } finally {
      session.dispose();
    }
    // No plan is a plan with nothing placed: the next round asks again.
    return steps ?? [];
  };
}
