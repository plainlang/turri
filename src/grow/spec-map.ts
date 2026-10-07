import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { withParseCache } from "../plain/parser.ts";
import {
  ACCEPTANCE_TESTS,
  DEFINITIONS,
  FUNCTIONAL_REQUIREMENTS,
  NON_FUNCTIONAL_REQUIREMENTS,
  REQUIRED_FUNCTIONAL_SPECS,
  TEST_REQUIREMENTS,
  type MarshalledPlainSource,
} from "../plain/spec.ts";
import { configForSpec, readProjectConfig } from "../config.ts";
import { STDLIB_ROOT } from "../plain/stdlib.ts";
import { conformanceDirFor } from "./conformance.ts";
import { chainSpec, type MapCodebase, type MapPlan, type MapPulse } from "./loop.ts";
import { modulesRoot, projectDirOf } from "./paths.ts";
import { HISTORY_DIR } from "./lineage.ts";
import { codeTree, readRecord, RECORD_FILE } from "./records.ts";
import { specFilesOf } from "./regrow.ts";
import { builtTips, resolveRequiresChain, type ChainEntry } from "./requires.ts";
import { changesBetween, layoutOf, serializeTree, type SpecChange } from "./spec-steps.ts";

/**
 * The regeneration: the spec itself, with the build drawn onto it - see docs/using.md.
 *
 * Nothing new is stored. A page a module, read from what turri keeps already: the code record (what is built, and the
 * old side of each change), the .plain files now (the lines, and what differs), the tests record (which functional
 * specs have conformance tests) - so the map is right from the files alone, the moment turri opens a project. The work
 * loop's plan is laid over it (`markSpecMap`): the pulse growing each item, the pulse planned to, or why there is none.
 *
 * An item is what turri plans and diffs by: a definition, a req, a functional spec with its sub-bullets and acceptance
 * tests. Items are matched to pulses by their lines in the trees each pulse goes between, as the loop has them.
 */

/** Where an item stands against the code record. A test req is the conformance track's: it is never built. */
export type ItemState = "built" | "new" | "changed" | "removed" | "test";

export interface MapItem {
  /** Stable while the item reads the same: what the cursor stays on. */
  key: string;
  section: string;
  /** The imported file it is written in, as shown; undefined, the module's own file. */
  file?: string;
  state: ItemState;
  /** Its text now - for one taken out, the code record's. */
  text: string;
  /** The code record's text, for a changed item. */
  was?: string;
  /** Its acceptance tests, as the spec has them now. */
  acceptance: string[];
  /** Its line in the code's tree now, and in the code record's: what a pulse's trees are matched by. */
  line?: string;
  wasLine?: string;
  /** A functional spec's conformance tests: written for it as it reads now, for an earlier text, or for one taken out. */
  tests?: "now" | "older" | "removed";
}

export interface MapPage {
  module: string;
  plainFile: string;
  /** The codebase its code lives in: whose record it is read from, and whose pulses grow it. */
  buildDir: string;
  /** The files it imports, as shown, in the order it reads them. */
  imports: string[];
  /** The module it requires - whose code it is built on - when it requires one. */
  requires?: string;
  /** Its conformance tests are on, as its config has it: `conformance-tests:` is not false. */
  conformance?: boolean;
  items: MapItem[];
  /** Its spec does not parse, or could not be read. */
  error?: string;
}

/** An item's mark in the gutter. */
export type Mark = "built" | "growing" | "planned" | "waiting" | "planning" | "stuck" | "removing" | "none";

export interface MarkedItem extends MapItem {
  mark: Mark;
  /** The pulse growing it, or planned to: running, or its provisional number. */
  pulse?: MapPulse;
  /** In the pulse that did not land: that pulse's number - rolled back, and waiting. */
  rolledBack?: number;
  /** A conformance pulse is writing its tests now. */
  testing?: boolean;
}

export interface MarkedPage extends MapPage {
  items: MarkedItem[];
  /** The loop looks after its codebase: something asked for it. */
  tracked: boolean;
  /** Its codebase, as the loop has it. */
  codebase?: MapCodebase;
  /** The top line's reason: what is happening, or why nothing is. */
  status: string;
  /** It needs the person: halted, or the planner found no plan, or its spec does not parse. */
  stuck: boolean;
}

type Item = { markdown: string; module?: string; frid?: string; [ACCEPTANCE_TESTS]?: Array<{ markdown?: string }> };

const itemsOf = (tree: MarshalledPlainSource | null | undefined, heading: string): Item[] => ((tree?.[heading] as Item[] | undefined) ?? []).slice();

/** The sections an item of the code is in, as a page has them: a module below's functional specs among them. */
const CODE_SECTIONS = [DEFINITIONS, NON_FUNCTIONAL_REQUIREMENTS, FUNCTIONAL_REQUIREMENTS];

/** A module's part of a codebase's tree: its own items untagged when it is the codebase, else those tagged with it. */
function moduleTree(tree: MarshalledPlainSource | null, module: string, own: boolean): MarshalledPlainSource {
  const mine = (item: Item) => (own ? item.module === undefined : item.module === module);
  return {
    [DEFINITIONS]: itemsOf(tree, DEFINITIONS).filter(mine),
    [NON_FUNCTIONAL_REQUIREMENTS]: itemsOf(tree, NON_FUNCTIONAL_REQUIREMENTS).filter(mine),
    [FUNCTIONAL_REQUIREMENTS]: own ? itemsOf(tree, FUNCTIONAL_REQUIREMENTS) : itemsOf(tree, REQUIRED_FUNCTIONAL_SPECS).filter((item) => item.module === module),
  };
}

/** The changes between two serialized trees - git runs for each, so the last ones are kept. */
const changesSeen = new Map<string, SpecChange[]>();
function changesOf(before: string, after: string): SpecChange[] {
  const key = `${before}\u0000${after}`;
  const seen = changesSeen.get(key);
  if (seen !== undefined) return seen;
  const changes = changesBetween(before, after);
  if (changesSeen.size > 64) changesSeen.clear();
  changesSeen.set(key, changes);
  return changes;
}

const markdownOf = (line: string | undefined): string => {
  try {
    return (JSON.parse(line ?? "") as Item).markdown ?? "";
  } catch {
    return "";
  }
};

/**
 * A module's items, from what its code is built from and what its spec says now: every item of the spec in its place,
 * each built, new or changed, and between them the items taken out that the code still has.
 *
 * `spec` and `record` are the codebase's trees - the module's items untagged when `own`, tagged with it otherwise. `full`
 * is the spec with its acceptance tests and test reqs.
 */
export function pageItems(input: { module: string; own: boolean; spec: MarshalledPlainSource; record: MarshalledPlainSource | null; tested?: MarshalledPlainSource | null }): MapItem[] {
  const now = moduleTree(input.spec, input.module, input.own);
  const before = serializeTree(moduleTree(input.record === null ? null : codeTree(input.record), input.module, input.own));
  const after = serializeTree(codeTree(now));
  const changes = changesOf(before, after);

  // Each item's acceptance tests, by its line in the code's tree.
  const acceptance = new Map<string, string[]>();
  for (const item of itemsOf(now, FUNCTIONAL_REQUIREMENTS)) {
    const line = serializeTree(codeTree({ [FUNCTIONAL_REQUIREMENTS]: [item] })).split("\n").find((entry) => entry.startsWith("{"));
    if (line !== undefined) acceptance.set(line, (item[ACCEPTANCE_TESTS] ?? []).map((test) => test.markdown ?? ""));
  }

  // The record's lines, with what is added in front of each and what becomes of each: the spec's order, the ghosts in theirs.
  const lines = before.split("\n").slice(0, -1);
  const removedBy = new Map<number, SpecChange>();
  const addedAt = new Map<number, SpecChange[]>();
  for (const change of changes) {
    if (change.removes !== undefined) removedBy.set(change.removes, change);
    if (change.kind === "add" && change.inserts !== undefined) addedAt.set(change.inserts.at, [...(addedAt.get(change.inserts.at) ?? []), change]);
  }
  const items: MapItem[] = [];
  const push = (section: string, state: ItemState, line: string | undefined, wasLine: string | undefined) => {
    const text = markdownOf(line ?? wasLine);
    items.push({
      key: "",
      section,
      state,
      text,
      ...(state === "changed" ? { was: markdownOf(wasLine) } : {}),
      acceptance: line !== undefined ? (acceptance.get(line) ?? []) : [],
      ...(line !== undefined ? { line } : {}),
      ...(wasLine !== undefined ? { wasLine } : {}),
    });
  };
  let section = "";
  for (let at = 0; at <= lines.length; at += 1) {
    for (const change of (addedAt.get(at) ?? []).sort((a, b) => a.inserts!.order - b.inserts!.order)) push(change.section, "new", change.after, undefined);
    if (at === lines.length) break;
    const line = lines[at]!;
    if (line.startsWith("[")) {
      section = (JSON.parse(line) as string[])[0]!;
      continue;
    }
    const change = removedBy.get(at);
    if (change?.kind === "change") push(section, "changed", change.after, line);
    else if (change?.kind === "remove") push(section, "removed", undefined, line);
    else push(section, "built", line, undefined);
  }
  // Test reqs are the conformance tests', never the code's: written for, as the tests record has them, or not yet.
  const testReqs = new Set(itemsOf(input.tested ?? null, TEST_REQUIREMENTS).map((item) => item.markdown.trim()));
  if (input.own) {
    for (const item of itemsOf(input.spec, TEST_REQUIREMENTS)) {
      items.push({ key: "", section: TEST_REQUIREMENTS, state: "test", text: item.markdown, acceptance: [], ...(testReqs.has(item.markdown.trim()) ? { tests: "now" as const } : {}) });
    }
  }

  // Conformance tests: of the functional specs, those the tests record has as they read now, as they read before, or taken out.
  const tested = new Set(itemsOf(input.tested ?? null, FUNCTIONAL_REQUIREMENTS).map((item) => item.markdown.trim()));
  for (const item of items) {
    if (item.section !== FUNCTIONAL_REQUIREMENTS || tested.size === 0) continue;
    if (item.state === "removed") {
      if (tested.has(item.text.trim())) item.tests = "removed";
    } else if (tested.has(item.text.trim())) item.tests = "now";
    else if (item.was !== undefined && tested.has(item.was.trim())) item.tests = "older";
  }
  return keyed(items);
}

/** Each item's key: its section, whether it is a ghost, its text - and which of the same it is. */
function keyed(items: MapItem[]): MapItem[] {
  const seen = new Map<string, number>();
  for (const item of items) {
    const base = `${item.section}\n${item.state === "removed" ? "-" : "+"}${item.text.trim()}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    item.key = count === 0 ? base : `${base}\n${count}`;
  }
  return items;
}

/** A spec file as the map names it: a template of turri's standard library by its import path, others from the project. */
export function importLabel(path: string, projectDir: string, stdlibRoot = STDLIB_ROOT): string {
  const name = path.startsWith(`${stdlibRoot}/stdlib/`) ? relative(stdlibRoot, path) : relative(projectDir, path) || basename(path);
  return name.replace(/\.plain$/, "");
}

/**
 * The items laid out as the files have them: the module's own file first - its sections in its order, its definitions
 * in its order - then each file it imports, the same way. A ghost keeps its place after the item before it.
 */
export function layOut(items: MapItem[], files: Array<{ label?: string; text: string }>): MapItem[] {
  const firstLine = (text: string) => text.trim().split("\n")[0]!.trim();
  // Each item's file: the first that has its first line - else the module's own, where a ghost was.
  const fileOf = (item: MapItem): number => {
    const line = firstLine(item.text);
    const at = files.findIndex((file) => file.text.includes(line));
    return at === -1 ? 0 : at;
  };
  const layouts = files.map((file) => layoutOf(file.text));
  const placed = items.map((item, index) => ({ item, index, file: item.state === "removed" ? -1 : fileOf(item) }));
  // A ghost goes in the file of the item before it.
  placed.forEach((entry, at) => {
    if (entry.file === -1) entry.file = at > 0 ? placed[at - 1]!.file : 0;
  });
  // Within a file, sections in its order; definitions by their concept's place, a ghost just after the one before it.
  let lastRank = -1;
  const rank = placed.map((entry) => {
    if (entry.item.section !== DEFINITIONS) return 0;
    const concept = /^- :([^:\s]+):/.exec(entry.item.text.trim())?.[1];
    const found = concept !== undefined && entry.item.state !== "removed" ? layouts[entry.file]!.concepts.get(concept) : undefined;
    lastRank = found ?? lastRank + 0.001;
    return lastRank;
  });
  const sectionPlace = (entry: (typeof placed)[number]) => {
    const order = layouts[entry.file]!.sections;
    const at = order.indexOf(entry.item.section);
    return at === -1 ? order.length + [DEFINITIONS, NON_FUNCTIONAL_REQUIREMENTS, TEST_REQUIREMENTS, FUNCTIONAL_REQUIREMENTS].indexOf(entry.item.section) : at;
  };
  return placed
    .sort((a, b) => a.file - b.file || sectionPlace(a) - sectionPlace(b) || rank[a.index]! - rank[b.index]! || a.index - b.index)
    .map((entry) => (entry.file === 0 ? entry.item : { ...entry.item, file: files[entry.file]!.label ?? "" }));
}

/** Whether a module's codebase has been started: anything in it, or a record. */
const started = (entry: ChainEntry) => {
  try {
    if (readdirSync(entry.buildDir).length > 0) return true;
  } catch {
    /* no folder */
  }
  return readRecord(entry.buildDir) !== null;
};

/** The files a module's page is read from: its spec files, its records, and its history - a commit moves the record read. */
function depsOf(entry: ChainEntry, codebase: ChainEntry, testsDir: string): string[] {
  const history = (dir: string) => [join(dirname(dir), HISTORY_DIR, "logs", "HEAD"), join(dir, RECORD_FILE)];
  return [entry.plainFile, ...history(codebase.buildDir), ...history(testsDir), dirname(dirname(codebase.buildDir))];
}

/** The chain a file's map reads: where its code lives - its furthest-built tip - or its own requires chain. */
function chainOf(plainFile: string): ChainEntry[] {
  return builtTips(plainFile)[0] ?? resolveRequiresChain(plainFile, [], undefined, { allowNoFunctionalities: true });
}

/**
 * The pages of the files given, from the files alone: one a module of each file's requires chain, bottom first, each
 * once. A module below the furthest-built one is read from that one's codebase, whose record has every module's items;
 * a module above it from its own, empty until its turn comes.
 */
export function readSpecMap(files: string[]): MapPage[] {
  return readSpecMapWithDeps(files).pages;
}

/** The pages, and the files they were read from: while none of them changes, the pages read the same. */
export function readSpecMapWithDeps(files: string[]): { pages: MapPage[]; deps: string[] } {
  const deps = new Set<string>(files);
  const pages = withParseCache(() => {
    const pages: MapPage[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      let chain: ChainEntry[];
      try {
        chain = chainOf(file);
      } catch (error) {
        if (!seen.has(file)) pages.push({ module: basename(file, ".plain"), plainFile: file, buildDir: "", imports: [], items: [], error: message(error) });
        seen.add(file);
        continue;
      }
      const furthest = chain.findLastIndex(started);
      const specs = new Map<number, MarshalledPlainSource | Error>();
      const specOf = (at: number) => {
        if (!specs.has(at)) {
          try {
            specs.set(at, chainSpec(chain.slice(0, at + 1)).tree);
          } catch (error) {
            specs.set(at, error instanceof Error ? error : new Error(String(error)));
          }
        }
        return specs.get(at)!;
      };
      chain.forEach((entry, at) => {
        if (seen.has(entry.plainFile)) return;
        seen.add(entry.plainFile);
        const home = Math.max(at, furthest);
        const codebase = chain[home]!;
        const page: MapPage = {
          module: entry.moduleName,
          plainFile: entry.plainFile,
          buildDir: codebase.buildDir,
          imports: [],
          items: [],
          ...(entry.requires !== null ? { requires: entry.requires } : {}),
          conformance: conformanceOn(entry.plainFile),
        };
        const spec = specOf(home);
        if (spec instanceof Error) {
          pages.push({ ...page, error: spec.message });
          return;
        }
        const projectDir = projectDirOf(entry.plainFile);
        const record = home <= furthest ? readRecord(codebase.buildDir) : null;
        const tested = readRecord(conformanceDirFor(entry.moduleName, modulesRoot(projectDir)));
        const paths = specFilesOf(entry.plainFile);
        for (const path of [...paths, ...depsOf(entry, codebase, conformanceDirFor(entry.moduleName, modulesRoot(projectDir)))]) deps.add(path);
        const texts = paths.map((path, index) => ({ ...(index > 0 ? { label: importLabel(path, projectDir) } : {}), text: readText(path) }));
        const items = pageItems({ module: entry.moduleName, own: home === at, spec, record, tested });
        pages.push({ ...page, imports: texts.slice(1).map((text) => text.label!), items: layOut(items, texts) });
      });
    }
    return pages;
  });
  return { pages, deps: [...deps] };
}

/** What the files read last are now: each one's time and size, or that it is not there. */
function fingerprint(paths: string[]): string {
  return paths
    .map((path) => {
      try {
        const stat = statSync(path);
        return `${path}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        return `${path}:-`;
      }
    })
    .join("\n");
}

/** Whether a module's config has its conformance tests on: `conformance-tests:` is not false. */
function conformanceOn(plainFile: string): boolean {
  try {
    return configForSpec(plainFile).conformanceTests !== false;
  } catch {
    return true;
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The lines of a serialized tree, as a set: what a pulse's trees are matched by. */
const linesSeen = new WeakMap<MapPulse, { before: Set<string>; after: Set<string>; testing: Set<string>; testReqs: Set<string> }>();
function linesOf(pulse: MapPulse) {
  let seen = linesSeen.get(pulse);
  if (seen === undefined) {
    const set = (text: string) => new Set(text.split("\n").filter((line) => line.startsWith("{")));
    // A conformance pulse's trees are the tests record's: its functional specs' lines - each with its number and acceptance tests.
    const specLines = (text: string, of = FUNCTIONAL_REQUIREMENTS) => {
      const out: string[] = [];
      let section = "";
      for (const line of text.split("\n")) {
        if (line.startsWith("[")) section = (JSON.parse(line) as string[])[0]!;
        else if (line.startsWith("{") && section === of) out.push(line);
      }
      return out;
    };
    // The test reqs it writes tests to follow: those new in it.
    const testReqs = () => {
      const before = new Set(specLines(pulse.before, TEST_REQUIREMENTS));
      return new Set(specLines(pulse.after, TEST_REQUIREMENTS).filter((line) => !before.has(line)).map((line) => markdownOf(line).trim()));
    };
    const testing = () => {
      // What it writes tests for: each functional spec whose line is new - its text, its acceptance tests or its number
      // changed - by its text; none, and it is the definitions, reqs or test reqs that changed: it tests every one again.
      const before = new Set(specLines(pulse.before));
      const after = specLines(pulse.after);
      const changed = after.filter((line) => !before.has(line));
      return new Set((changed.length > 0 ? changed : after).map((line) => markdownOf(line).trim()));
    };
    seen = pulse.track === "code" ? { before: set(pulse.before), after: set(pulse.after), testing: new Set(), testReqs: new Set() } : { before: new Set(), after: new Set(), testing: testing(), testReqs: testReqs() };
    linesSeen.set(pulse, seen);
  }
  return seen;
}

/** Whether a pulse grows an item: brings its line now, or takes out its line in the record. */
function grows(pulse: MapPulse, item: MapItem): boolean {
  if (pulse.track !== "code") return false;
  const lines = linesOf(pulse);
  if (item.state === "removed") return item.wasLine !== undefined && lines.before.has(item.wasLine) && !lines.after.has(item.wasLine);
  return item.line !== undefined && lines.after.has(item.line) && !lines.before.has(item.line);
}

/** What the loop's reason for a halt says, short: "halted - pulse 3 didn't land". */
function haltText(stuck: NonNullable<MapCodebase["stuck"]>): string {
  if (stuck.pulse !== undefined) return `halted - pulse ${stuck.pulse.number} ${/was stopped/.test(stuck.why) ? "was stopped" : /did not start/.test(stuck.why) ? "didn't start" : /did not pass/.test(stuck.why) ? "didn't pass" : "didn't land"}`;
  if (/planner found no way/.test(stuck.why)) return "the planner couldn't cut it into pulses";
  return `halted - ${stuck.why.split(" - ")[0]}`;
}

/**
 * A test req's mark, from the conformance track: followed by the conformance tests as it reads now, being written
 * for in the running conformance pulse, planned in one, or not yet - none, where no conformance test is written at all.
 */
function testReqMark(item: MapItem, codebase: MapCodebase | undefined, page: MapPage): { mark: Mark; pulse?: MapPulse } {
  if (item.tests === "now") return { mark: "built" };
  const text = item.text.trim();
  const pulse = codebase?.pulses.find((candidate) => candidate.track === "conformance" && linesOf(candidate).testReqs.has(text));
  if (pulse !== undefined) return { mark: pulse.running ? "growing" : "planned", pulse };
  const anyTested = page.items.some((other) => other.tests !== undefined);
  return { mark: anyTested ? "waiting" : "none" };
}

/** The count a page's top line starts with: how many of its functional specs are built as the spec has them. */
export function countOf(page: MapPage): { built: number; total: number } {
  const specs = page.items.filter((item) => item.section === FUNCTIONAL_REQUIREMENTS && item.state !== "removed");
  return { built: specs.filter((item) => item.state === "built").length, total: specs.length };
}

/**
 * The plan laid over the pages: each item that differs from the code marked with the pulse growing it, the pulse
 * planned to, or - with none - planning, stuck or waiting; and each page's reason on its top line.
 */
export function markSpecMap(pages: MapPage[], plan: MapPlan): MarkedPage[] {
  return pages.map((page): MarkedPage => {
    const codebase = plan.codebases.find((entry) => entry.buildDir === page.buildDir);
    if (page.error !== undefined) return { ...page, items: [], tracked: codebase !== undefined, ...(codebase !== undefined ? { codebase } : {}), status: `its spec does not parse: ${page.error.split("\n")[0]}`, stuck: true };
    const stuckPulse = codebase?.stuck?.pulse;
    const failed: MapPulse | undefined = stuckPulse !== undefined ? { number: stuckPulse.number, title: "", track: "code", running: false, rowId: "", before: stuckPulse.before, after: stuckPulse.after } : undefined;
    const conformance = codebase?.pulses.find((pulse) => pulse.running && pulse.track === "conformance");
    // Test reqs only where conformance tests are on: the loop's word for it - the config, or asked for this session - else the config's.
    const conformanceIsOn = codebase?.conformance ?? page.conformance !== false;
    const items = page.items.filter((item) => item.state !== "test" || conformanceIsOn).map((item): MarkedItem => {
      const testing = conformance !== undefined && item.section === FUNCTIONAL_REQUIREMENTS && item.state !== "removed" && (() => {
        return linesOf(conformance).testing.has(item.text.trim());
      })();
      const extra = testing ? { testing: true } : {};
      if (item.state === "test") return { ...item, ...testReqMark(item, codebase, page), ...extra };
      if (item.state === "built") return { ...item, mark: "built", ...extra };
      const pulse = codebase?.pulses.find((candidate) => grows(candidate, item));
      if (pulse !== undefined) return { ...item, mark: pulse.running ? "growing" : "planned", pulse, ...extra };
      if (codebase?.planning === "code") return { ...item, mark: "planning", ...extra };
      if (codebase?.stuck !== undefined) {
        // The planner found no plan: every item is stuck. A halt: the items of the pulse that did not land are; the rest wait.
        if (failed === undefined) return { ...item, mark: "stuck", ...extra };
        if (grows(failed, item)) return { ...item, mark: "stuck", rolledBack: failed.number, ...extra };
      }
      return { ...item, mark: "waiting", ...extra };
    });
    const differing = items.filter((item) => item.state === "new" || item.state === "changed" || item.state === "removed").length;
    const pulses = codebase?.pulses ?? [];
    const running = pulses.find((pulse) => pulse.running);
    const last = pulses.at(-1)?.number;
    const status =
      codebase === undefined
        ? differing > 0
          ? "not asked to build - regrow plans it"
          : "all built"
        : running !== undefined
          ? `${running.track === "conformance" ? "conformance " : ""}pulse ${running.number} of ${last} growing`
          : codebase.planning !== undefined
            ? "planning"
            : codebase.waitsFor !== undefined
              ? `waits for ${codebase.waitsFor}`
              : codebase.stuck !== undefined
                ? haltText(codebase.stuck)
                : pulses.length > 0
                  ? `pulse ${pulses[0]!.number} of ${last} next`
                  : differing === 0
                    ? "all built"
                    : (codebase.why ?? "waiting");
    return { ...page, items, tracked: codebase !== undefined, ...(codebase !== undefined ? { codebase } : {}), status, stuck: codebase?.stuck !== undefined && running === undefined };
  });
}

/**
 * The .plain files the map shows when nothing has been asked for: the project's module from config.yaml, else the
 * .plain files in the folder that no other one there imports or requires.
 */
export function defaultMapFiles(cwd: string): string[] {
  try {
    const module = readProjectConfig(cwd).module;
    if (module !== undefined && existsSync(resolve(cwd, module))) return [resolve(cwd, module)];
  } catch {
    /* no config: the folder's files */
  }
  let files: string[];
  try {
    files = readdirSync(cwd)
      .filter((name) => name.endsWith(".plain"))
      .sort()
      .map((name) => join(cwd, name));
  } catch {
    return [];
  }
  const below = new Set<string>();
  for (const file of files) {
    try {
      for (const path of specFilesOf(file).slice(1)) below.add(path);
      for (const entry of resolveRequiresChain(file, [], undefined, { allowNoFunctionalities: true }).slice(0, -1)) below.add(resolve(entry.plainFile));
    } catch {
      /* a file that does not parse is still shown */
    }
  }
  return files.filter((file) => !below.has(resolve(file)));
}

/**
 * The map as the side panel reads it on every frame: read again from the files and laid over the plan at most every
 * `every` ms - git runs for the records and the diffs - and the same pages in between.
 */
export function createSpecMapSource(options: { files: () => string[]; plan: () => MapPlan; every?: number; now?: () => number }) {
  const every = options.every ?? 1000;
  const now = options.now ?? Date.now;
  let last: { at: number; pages: MarkedPage[] } | undefined;
  // The pages from the files, and what the files were: read again only once one of them changes.
  let read: { files: string; print: string; deps: string[]; pages: MapPage[] } | undefined;
  return {
    read(): MarkedPage[] {
      if (last !== undefined && now() - last.at < every) return last.pages;
      let pages: MarkedPage[];
      // Nothing here may throw: the panel draws from it on every frame, and a frame that throws draws nothing again.
      try {
        const plan = options.plan();
        const files = options.files();
        const key = files.join("\n");
        if (read === undefined || read.files !== key || fingerprint(read.deps) !== read.print) {
          const fresh = readSpecMapWithDeps(files);
          read = { files: key, print: fingerprint(fresh.deps), deps: fresh.deps, pages: fresh.pages };
        }
        pages = markSpecMap(read.pages, plan);
      } catch (error) {
        pages = last?.pages ?? [];
        if (pages.length === 0) pages = [{ module: "spec", plainFile: "", buildDir: "", imports: [], items: [], tracked: false, status: `the map could not be read: ${message(error)}`, stuck: true }];
      }
      last = { at: now(), pages };
      return pages;
    },
    /** Read the files again on the next frame, whatever they look like. */
    refresh(): void {
      last = undefined;
      read = undefined;
    },
  };
}
