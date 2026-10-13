import { basename } from "node:path";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { highlightLine, roleOf, type PlainRole } from "../plain/highlight.ts";
import { ACCEPTANCE_TEST_HEADING, DEFINITIONS, FUNCTIONAL_REQUIREMENTS, NON_FUNCTIONAL_REQUIREMENTS } from "../plain/spec.ts";
import type { DiffPaint } from "./diff-view.ts";
import { spinner } from "./job-panel.ts";
import type { Job } from "./jobs.ts";
import { countOf, type Mark, type MarkedItem, type MarkedPage } from "./spec-map.ts";
import type { TranscriptStyle } from "./transcript-view.ts";

/**
 * The regeneration drawn: a page a module, an item a row - see spec-map.ts for what each mark means.
 *
 * Each item's first line, with its one mark in the gutter - its rung on the ladder; a changed item's changed
 * sub-bullets under it, word by word; an item taken out as a struck-through ghost. Enter opens an item: all of it, its
 * acceptance tests, the pulse that brings it, its conformance tests, and - a definition - the built specs that use it.
 * One module is shown at a time, a tab a module of the chain - ←→ go from one to the next: the module growing now, until
 * another tab is chosen, and again once another module starts growing. Under its own text, the files it imports, a
 * folded block each. A chain of many modules nested one in another was too deep to read, and too much to draw.
 */

export interface SpecMapState {
  /** Which view the side panel shows: the map, or the pulse list. */
  view: "map" | "pulses";
  /** The row the cursor is on, and the key of what is there - it stays on the item when rows move. */
  cursor: number;
  cursorKey?: string;
  /** The first line shown. */
  top: number;
  /** The items opened, by key. */
  open: Set<string>;
  /** Import blocks opened by hand, by where they are and file: the rest closed. */
  imports: Map<string, boolean>;
  /** The tab chosen by hand - its .plain file - and the module in focus when it was: another in focus, or it starts growing, the view follows that. */
  tab?: { file: string; focus?: string };
  /** An item to show - in its module and import block, opened for it - and put the cursor on: by .plain file and key. */
  reveal?: { file: string; key: string };
}

export function createSpecMapState(): SpecMapState {
  return { view: "map", cursor: 0, top: 0, open: new Set(), imports: new Map() };
}

/** A row: a group's heading; an import block; an item. */
export type MapRow =
  | { kind: "group"; page: MarkedPage; key: string; label: string; depth: number }
  | { kind: "import"; page: MarkedPage; file: string; key: string; open: boolean; depth: number }
  | { kind: "item"; page: MarkedPage; item: MarkedItem; key: string };

/** What a line shows, for the minimap: the mark of the item it belongs to. */
type LineMark = Mark | "removed" | undefined;

/**
 * The module in focus: the one growing now, else the last the loop looks after - the module asked for, at the top of its
 * chain - else the first.
 */
export function focusOf(pages: MarkedPage[]): MarkedPage | undefined {
  return pages.find((page) => page.items.some((item) => item.mark === "growing")) ?? pages.findLast((page) => page.tracked) ?? pages[0];
}

/** The module in focus as a tab chosen by hand remembers it: which it is, and whether it was growing - one starting to grow is shown. */
function focusKey(pages: MarkedPage[]): string | undefined {
  const focus = focusOf(pages);
  return focus === undefined ? undefined : `${focus.plainFile}${focus.items.some((item) => item.mark === "growing") ? "\ngrowing" : ""}`;
}

/** The module shown: the tab chosen by hand while the module in focus is as it was then, else the one in focus. */
export function shownPage(pages: MarkedPage[], state: SpecMapState): MarkedPage | undefined {
  const focus = focusOf(pages);
  const chosen = state.tab !== undefined && state.tab.focus === focusKey(pages) ? pages.find((page) => page.plainFile === state.tab!.file) : undefined;
  if (chosen === undefined) state.tab = undefined;
  return chosen ?? focus;
}

/** The tab `by` along from the one shown - the chain's order, the module it is built on to the left - its cursor at its top. */
export function switchTab(pages: MarkedPage[], state: SpecMapState, by: number): void {
  const shown = shownPage(pages, state);
  const at = shown === undefined ? 0 : pages.indexOf(shown);
  const next = pages[Math.max(0, Math.min(pages.length - 1, at + by))];
  if (next === undefined || next === shown) return;
  state.tab = { file: next.plainFile, ...(focusKey(pages) !== undefined ? { focus: focusKey(pages)! } : {}) };
  state.cursor = 0;
  state.top = 0;
  state.cursorKey = undefined;
}

/** A tab's name: its .plain file's, without the extension. */
const tabName = (page: MarkedPage) => basename(page.plainFile).replace(/\.plain$/, "");

/**
 * The tabs, a module each in the chain's order, the one shown marked - those growing spin, those stuck say so - fitted to
 * `width` around the one shown, what does not fit counted at either end.
 */
export function tabBar(pages: MarkedPage[], shown: MarkedPage | undefined, width: number, style: TranscriptStyle, now: number): string {
  const label = (page: MarkedPage) => {
    const growing = page.items.some((item) => item.mark === "growing");
    const mark = growing ? `${spinner(now)} ` : page.stuck ? "! " : "";
    const text = `${mark}${tabName(page)}`;
    if (page === shown) return style.heading(`[${text}]`);
    return growing ? style.accent(text) : page.stuck ? style.error(text) : style.muted(text);
  };
  const tabs = pages.map(label);
  const at = Math.max(0, shown === undefined ? 0 : pages.indexOf(shown));
  let from = at;
  let to = at + 1;
  const lineOf = (a: number, b: number) =>
    `${a > 0 ? style.muted(`‹ ${a}  `) : ""}${tabs.slice(a, b).join("  ")}${b < tabs.length ? style.muted(`  ${tabs.length - b} ›`) : ""}`;
  // Out from the one shown, a tab at a time on either side, while they fit.
  for (let grew = true; grew; ) {
    grew = false;
    if (to < tabs.length && visibleWidth(lineOf(from, to + 1)) <= width) (to += 1), (grew = true);
    if (from > 0 && visibleWidth(lineOf(from - 1, to)) <= width) (from -= 1), (grew = true);
  }
  return truncateToWidth(lineOf(from, to), width, "…");
}
/** Strike text through. */
const strike = (text: string) => `\x1b[9m${text}\x1b[29m`;

/** How far a group, and what is in it, is indented under its module. */
const INDENT = "  ";

/**
 * Where an item stands, as one mark on a ladder every item climbs: planned, working, regenerated, validating, conform - and needs
 * you, off it - named in the legend in the panel's corner. The same mark means the same thing whatever the config says
 * of conformance tests: a functional spec regenerated and not conformed is hollow whether its tests are on, off or not
 * chosen, so changing that changes no mark.
 */
export const LADDER = {
  toRegenerate: "○",
  regenerated: "◇",
  conform: "◆",
  needsYou: "!",
  takenOut: "−",
} as const;

/**
 * An item's rung: what its one mark shows. Working is regenerating or taking out alike; validating, its conformance tests
 * being written and run - a spinner of its own colour, the green of the rungs it is between.
 */
export type Rung = "toRegenerate" | "working" | "regenerated" | "validating" | "conform" | "needsYou" | "takenOut" | "none";

export function rungOf(item: MarkedItem): Rung {
  if (item.state === "removed") return item.mark === "growing" ? "working" : "takenOut";
  // A test req is only ever grown by a conformance pulse: growing, it is validating.
  if (item.testing === true || (item.state === "test" && item.mark === "growing")) return "validating";
  if (item.mark === "growing") return "working";
  if (item.mark === "stuck") return "needsYou";
  if (item.mark === "none") return "none";
  // A test req is the conformance tests' alone: it is followed by them, conform, or not yet.
  if (item.state === "test") return item.mark === "built" ? "conform" : "toRegenerate";
  if (item.mark === "built") return item.tests === "now" ? "conform" : "regenerated";
  return "toRegenerate";
}

/** The gutter before the bar - the status column: the cursor and the mark, under its heading. */
const STATUS_HEADING = "status";
const GUTTER = STATUS_HEADING.length + 2;
const BAR = "│ ";
const CONTINUED = `${" ".repeat(GUTTER)}${BAR}`;

function rungGlyph(rung: Rung, style: TranscriptStyle, now: number): string {
  const green = style.success ?? style.added;
  if (rung === "working") return style.accent(spinner(now));
  if (rung === "validating") return green(spinner(now));
  if (rung === "regenerated") return green(LADDER.regenerated);
  if (rung === "conform") return green(LADDER.conform);
  if (rung === "needsYou") return style.error(LADDER.needsYou);
  if (rung === "takenOut") return style.error(LADDER.takenOut);
  if (rung === "toRegenerate") return style.muted(LADDER.toRegenerate);
  return " ";
}

/** An item's mark, under the middle of the status column's heading; the cursor goes before it. */
function markText(item: MarkedItem, style: TranscriptStyle, now: number): string {
  // With the cursor before it and the space before the bar after it, as wide as the column.
  return `  ${rungGlyph(rungOf(item), style, now)}${" ".repeat(GUTTER - 5)}`;
}

/** The two columns' headings, over the map - status, and the module's file - and a line of space under them. */
export function columnHeadings(page: MarkedPage, width: number, style: TranscriptStyle): string[] {
  return [truncateToWidth(`${style.muted(` ${STATUS_HEADING} `)}${BAR}${style.heading(basename(page.plainFile))}`, width), CONTINUED.trimEnd()];
}

/** The legend, a line a mark, up the ladder: planned, working, regenerated, validating, conform - and needs you, off it. */
const LEGEND: Array<[Rung, string]> = [
  ["toRegenerate", "planned"],
  ["working", "working"],
  ["regenerated", "regenerated"],
  ["validating", "validating"],
  ["conform", "conform"],
  ["needsYou", "needs you"],
  ["takenOut", "to take out"],
];

/**
 * The legend's lines, for the panel's lower right corner: every rung of the ladder, always - what a mark means never
 * depends on the page - and to take out only where the page has something to take out.
 */
export function legendLines(page: MarkedPage, style: TranscriptStyle): string[] {
  const removing = page.items.some((item) => rungOf(item) === "takenOut");
  return LEGEND.filter(([rung]) => rung !== "takenOut" || removing).map(([rung, name]) => `${rungGlyph(rung, style, 0)} ${style.muted(name)}`);
}

/** What the person is needed for, and how: the line under a page's first `!`, and its top line's end. */
export const DISCUSS_KEY = "d";
const needsLine = (page: MarkedPage) => `needs you - ${page.status} · ${DISCUSS_KEY} to talk it through in the chat`;

/** Each character's role in a line of ***plain, as plyn highlights it - kept, the map redraws every half second. */
const rolesSeen = new Map<string, Array<PlainRole | undefined>>();
function rolesOf(line: string): Array<PlainRole | undefined> {
  const seen = rolesSeen.get(line);
  if (seen !== undefined) return seen;
  const roles: Array<PlainRole | undefined> = [];
  for (const token of highlightLine(line).tokens) {
    const role = roleOf(token.scopes);
    for (let at = 0; at < token.text.length; at += 1) roles.push(role);
  }
  if (rolesSeen.size > 2000) rolesSeen.clear();
  rolesSeen.set(line, roles);
  return roles;
}

/** A piece of a line - `text`, from `from` in it - painted by the roles of the line's characters. */
function paintRoles(text: string, from: number, roles: Array<PlainRole | undefined>, paint: DiffPaint): string {
  let out = "";
  let run = "";
  let role: PlainRole | undefined;
  for (let at = 0; at < text.length; at += 1) {
    const next = roles[from + at];
    if (next !== role && run !== "") {
      out += role === undefined ? run : paint.syntax(role, run);
      run = "";
    }
    role = next;
    run += text[at]!;
  }
  return out + (run === "" ? "" : role === undefined ? run : paint.syntax(role, run));
}

/** A line of ***plain highlighted as plyn highlights it: the whole line read, so a span over several words keeps its colour. */
export function highlighted(line: string, style: TranscriptStyle): string {
  return style.diff === undefined ? line : paintRoles(line, 0, rolesOf(line), style.diff);
}

/** The words of a line and the spaces between them, for a word-level diff. */
const tokens = (line: string) => line.split(/(\s+)/).filter((token) => token !== "");

/** One line become another, word by word: what is gone struck through in red, what is new in green, the rest as it is. */
export function wordDiff(was: string, now: string, style: TranscriptStyle): string {
  const a = tokens(was);
  const b = tokens(now);
  // What is kept is highlighted as it reads in the new line: each word where it is in it.
  const roles = style.diff !== undefined ? rolesOf(now) : undefined;
  const starts: number[] = [];
  b.reduce((at, token) => (starts.push(at), at + token.length), 0);
  // Too long to align word by word: the old line struck, the new one after it.
  if (a.length * b.length > 40_000) return `${style.removed(strike(was))} ${style.added(now)}`;
  const best = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) best[i]![j] = a[i] === b[j] ? best[i + 1]![j + 1]! + 1 : Math.max(best[i + 1]![j]!, best[i]![j + 1]!);
  const out: string[] = [];
  let removed = "";
  let added = "";
  // What is kept, gathered until a change: painted in one go, where it starts in the new line.
  let kept = "";
  let keptFrom = 0;
  const flushKept = () => {
    if (kept !== "") out.push(roles !== undefined ? paintRoles(kept, keptFrom, roles, style.diff!) : kept);
    kept = "";
  };
  const flush = () => {
    if (removed !== "" || added !== "") flushKept();
    if (removed !== "") out.push(style.removed(strike(removed)));
    if (added !== "") out.push(style.added(added));
    removed = "";
    added = "";
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      if (kept === "") keptFrom = starts[j]!;
      kept += b[j]!;
      i += 1;
      j += 1;
    } else if (j < b.length && (i === a.length || best[i]![j + 1]! >= best[i + 1]![j]!)) {
      added += b[j]!;
      j += 1;
    } else {
      removed += a[i]!;
      i += 1;
    }
  }
  flush();
  flushKept();
  return out.join("");
}

/**
 * An item's text against the code record's, line by line: each line kept, or changed - paired with the line it was -
 * or only on one side. Lines are a functional spec's first line and its sub-bullets.
 */
export function lineDiff(was: string, now: string): Array<{ was?: string; now?: string }> {
  const a = was.split("\n");
  const b = now.split("\n");
  const best = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) best[i]![j] = a[i] === b[j] ? best[i + 1]![j + 1]! + 1 : Math.max(best[i + 1]![j]!, best[i]![j + 1]!);
  const out: Array<{ was?: string; now?: string }> = [];
  let gone: string[] = [];
  let come: string[] = [];
  // A run of lines gone and lines come: paired in order, the line each was, the rest on one side.
  const flush = () => {
    for (let k = 0; k < Math.max(gone.length, come.length); k += 1) out.push({ ...(gone[k] !== undefined ? { was: gone[k]! } : {}), ...(come[k] !== undefined ? { now: come[k]! } : {}) });
    gone = [];
    come = [];
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      out.push({ was: a[i]!, now: b[j]! });
      i += 1;
      j += 1;
    } else if (j < b.length && (i === a.length || best[i]![j + 1]! >= best[i + 1]![j]!)) come.push(b[j++]!);
    else gone.push(a[i++]!);
  }
  flush();
  return out;
}

/** A line of a diff as drawn: kept dimmed, changed word by word, gone struck in red, new in green. */
function diffLine(line: { was?: string; now?: string }, style: TranscriptStyle): string {
  // Unchanged, it is the spec as any of its lines: drawn as the spec is, not dimmed - dimmed is turri's own words.
  if (line.was === line.now) return highlighted(line.now ?? "", style);
  if (line.was === undefined) return style.added(line.now ?? "");
  if (line.now === undefined) return style.removed(strike(line.was));
  return wordDiff(line.was, line.now, style);
}

/** The pulse's running job, for how long it has run. */
const firstLine = (text: string) => text.split("\n")[0] ?? "";

/**
 * A line of the spec wrapped to `room`: the lines after the first indented past its bullet (`- `, `1. `) - `plain`, the
 * line without its colours, says how far.
 */
function hanging(drawn: string, plain: string, room: number): string[] {
  const hang = /^\s*(?:[-*+]|\d+[.)])?\s*/.exec(plain)?.[0].length ?? 0;
  const lines = wrapTextWithAnsi(drawn, Math.max(10, room - hang));
  return lines.map((line, index) => (index === 0 ? line : `${" ".repeat(hang)}${line}`));
}

function wrapped(text: string, width: number, colour: (text: string) => string = (line) => line): string[] {
  return text
    .split("\n")
    .flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, Math.max(10, width - CONTINUED.length))))
    .map((line) => `${CONTINUED}${colour(line)}`);
}

/** All of an item, opened: the rest of its text against the code's, and its acceptance tests. Where it stands is beside its mark. */
function detailLines(item: MarkedItem, width: number, style: TranscriptStyle): string[] {
  const lines: string[] = [];
  // The rest of its text - its first line is the row - against the record's, for a change.
  const rest = item.state === "changed" ? lineDiff(item.was ?? "", item.text).slice(1) : item.text.split("\n").slice(1).map((line) => ({ was: line, now: line }));
  for (const line of rest) {
    const drawn = item.state === "removed" ? style.removed(strike(line.now ?? "")) : item.state === "changed" ? diffLine(line, style) : highlighted(line.now ?? "", style);
    lines.push(...wrapped(drawn, width));
  }
  if (item.acceptance.length > 0) {
    // As the spec has them: nested under the functional spec as deep as its sub-bullets, under a heading of their own
    // drawn as a section's is.
    const nested = /^( +)\S/m.exec(item.text.split("\n").slice(1).join("\n"))?.[1] ?? INDENT;
    const heading = `***${ACCEPTANCE_TEST_HEADING}***`;
    lines.push(CONTINUED.trimEnd());
    lines.push(`${CONTINUED}${nested}${style.diff !== undefined ? style.diff.syntax("section", heading) : style.muted(heading)}`);
    for (const test of item.acceptance) lines.push(...wrapped(test.split("\n").map((line) => `${nested}${highlighted(line, style)}`).join("\n"), width));
  }
  return lines;
}

/** An import block's line: its file, how many items, and how far they are built. */
function importSummary(items: MarkedItem[]): string {
  const counts = [
    [DEFINITIONS, "definition"],
    [NON_FUNCTIONAL_REQUIREMENTS, "req"],
    [FUNCTIONAL_REQUIREMENTS, "functionality"],
  ] as const;
  const kinds = counts.map(([section, name]) => ({ name, count: items.filter((item) => item.section === section && item.state !== "removed").length })).filter((kind) => kind.count > 0);
  const plural = (name: string) => (name === "functionality" ? "functionalities" : `${name}s`);
  const size = kinds.length === 1 ? `${kinds[0]!.count} ${kinds[0]!.count === 1 ? kinds[0]!.name : plural(kinds[0]!.name)}` : `${items.filter((item) => item.state !== "removed" && item.state !== "test").length} items`;
  const changing = items.filter((item) => item.state === "new" || item.state === "changed" || item.state === "removed");
  if (changing.length === 0) return `${size} · all built`;
  const pulses = new Set(changing.map((item) => (item.pulse === undefined ? undefined : item.pulse.number)));
  const only = pulses.size === 1 ? [...pulses][0] : undefined;
  const growing = changing.some((item) => item.mark === "growing");
  return `${size} · ${changing.length} changing${growing ? " · growing now" : only !== undefined ? ` in pulse ${only}` : ""}`;
}

/**
 * The rows of the module shown, top to bottom: its own items, then the files it imports, a block each under their
 * heading, closed until opened. The modules it requires are tabs of their own.
 */
export function specMapRows(pages: MarkedPage[], state: SpecMapState): MapRow[] {
  const reveal = state.reveal;
  const revealed = reveal !== undefined ? pages.find((entry) => entry.plainFile === reveal.file) : undefined;
  // An item to show, on another tab: that tab, beside the module in focus now.
  if (revealed !== undefined) state.tab = { file: revealed.plainFile, ...(focusKey(pages) !== undefined ? { focus: focusKey(pages)! } : {}) };
  const page = shownPage(pages, state);
  const rows: MapRow[] = [];
  if (page === undefined) return rows;
  const path = page.plainFile;
  const item = (entry: MarkedItem): MapRow => ({ kind: "item", page, item: entry, key: `${path}\n${entry.key}` });
  rows.push(...page.items.filter((entry) => entry.file === undefined).map(item));
  const imports = page.imports.filter((file) => page.items.some((entry) => entry.file === file));
  if (imports.length > 0) rows.push({ kind: "group", page, key: `group\n${path}\nimported`, label: `imported (${imports.length})`, depth: 0 });
  for (const file of imports) {
    const items = page.items.filter((entry) => entry.file === file);
    const key = `${path}\n${file}`;
    if (revealed === page && items.some((entry) => entry.key === reveal!.key)) state.imports.set(key, true);
    const opened = state.imports.get(key) ?? false;
    rows.push({ kind: "import", page, file, key: `import\n${key}`, open: opened, depth: 0 });
    if (opened) rows.push(...items.map(item));
  }
  if (reveal !== undefined) {
    const found = rows.find((row) => row.kind === "item" && row.page.plainFile === reveal.file && row.item.key === reveal.key);
    if (found !== undefined) state.cursorKey = found.key;
    state.reveal = undefined;
  }
  return rows;
}

/**
 * A page as lines: each row, the cursor's marked, a section's heading where one starts; where each row starts, for
 * scrolling to it; and each line's mark, for the minimap.
 */
export function specMapLines(
  pages: MarkedPage[],
  state: SpecMapState,
  width: number,
  style: TranscriptStyle,
  _jobs: Job[] = [],
  now = Date.now(),
): { lines: string[]; rowStarts: number[]; rows: MapRow[]; marks: LineMark[] } {
  const rows = specMapRows(pages, state);
  // The cursor stays on its item when rows come and go above it.
  const kept = state.cursorKey === undefined ? -1 : rows.findIndex((row) => row.key === state.cursorKey);
  state.cursor = kept !== -1 ? kept : Math.max(0, Math.min(state.cursor, rows.length - 1));
  state.cursorKey = rows[state.cursor]?.key;
  const lines: string[] = [];
  const marks: LineMark[] = [];
  const rowStarts: number[] = [];
  const add = (line: string, mark?: LineMark) => {
    lines.push(line);
    marks.push(mark);
  };
  // The module shown: a spec that does not parse, or has nothing in it yet, says so.
  const shown = shownPage(pages, state);
  if (shown?.error !== undefined) add(style.error(`  its spec does not parse: ${shown.error}`));
  else if (shown !== undefined && shown.items.length === 0) add(style.muted("  nothing in this spec yet"));
  let block: string | undefined;
  let section: string | undefined;
  // Straight under an import block's line: its first heading needs no blank line before it.
  let underImport = false;
  // Whether what the module needs the person for is said yet, under its first `!`.
  let toldWhy = false;
  rows.forEach((row, index) => {
    const here = index === state.cursor;
    const pointer = here ? style.accent("›") : " ";
    const page = row.page;
    if (row.kind === "group") {
      if (lines.length > 0) add("");
      rowStarts.push(lines.length);
      const text = `${INDENT.repeat(row.depth + 1)}${row.label}`;
      add(`${pointer}${here ? style.heading(text) : style.muted(text)}`);
      underImport = true;
      return;
    }
    if (row.kind === "import") {
      // Open, its items have a blank line above it; closed, it sits with the others of its group.
      if (row.open || (rows[index - 1]?.kind === "item")) add("");
      block = row.file;
      section = undefined;
      rowStarts.push(lines.length);
      const items = page.items.filter((item) => item.file === row.file);
      const text = `${row.open ? "▾" : "▸"} from ${row.file} · ${importSummary(items)}`;
      add(`${pointer}${INDENT.repeat(row.depth + 1)}${here ? style.heading(text) : style.muted(text)}`);
      underImport = true;
      return;
    }
    const { item } = row;
    // A section's heading where one starts - in the module's own text, or in an import block's.
    if (item.section !== section || item.file !== block) {
      if (lines.length > 0 && !underImport) add(CONTINUED.trimEnd());
      section = item.section;
      block = item.file;
      add(`${CONTINUED}${style.diff !== undefined ? style.diff.syntax("section", `***${item.section}***`) : style.muted(`***${item.section}***`)}`);
    }
    underImport = false;
    rowStarts.push(lines.length);
    const mark: LineMark = item.state === "removed" ? "removed" : item.mark;
    const gutter = `${pointer}${markText(item, style, now)} ${BAR}`;
    // Nothing is written to its right: where it stands is in its mark, and in its lines once opened.
    const room = Math.max(10, width - GUTTER - BAR.length);
    const first = firstLine(item.text);
    const wasFirst = firstLine(item.was ?? "");
    const drawn =
      item.state === "removed"
        ? style.removed(strike(first))
        : item.state === "changed" && wasFirst !== first
          ? wordDiff(wasFirst, first, style)
          : highlighted(first, style);
    // Wrapped, never cut short: what follows a `…` is what a person came to read. The lines after the first hang
    // under the item's text, past its bullet.
    const [head = "", ...rest] = hanging(drawn, first, room);
    add(`${gutter}${head}`, mark);
    for (const line of rest) add(`${CONTINUED}${line}`, mark);
    // The first item that needs the person says what for, and how to go about it - opened or closed.
    if (page.stuck && !toldWhy && rungOf(item) === "needsYou") {
      toldWhy = true;
      for (const line of wrapped(needsLine(page), width, style.error)) add(line, mark);
    }
    if (state.open.has(row.key)) {
      for (const detail of detailLines(item, width, style)) add(detail, mark);
      return;
    }
    // A changed item shows what changed in it, closed too: its changed sub-bullets, word by word.
    if (item.state === "changed") {
      const changed = lineDiff(item.was ?? "", item.text)
        .slice(1)
        .filter((line) => line.was !== line.now);
      for (const line of changed.slice(0, 4)) {
        for (const part of hanging(diffLine(line, style), line.now ?? line.was ?? "", room)) add(`${CONTINUED}${part}`, mark);
      }
      if (changed.length > 4) add(`${CONTINUED}${style.muted(`… ${changed.length - 4} more - enter opens it`)}`, mark);
    }
  });
  return { lines, rowStarts, rows, marks };
}

/** How the strip and the minimap colour a mark. */
function paintOf(mark: LineMark, style: TranscriptStyle): (text: string) => string {
  if (mark === "built") return style.success ?? style.added;
  if (mark === "growing" || mark === "planning") return style.accent;
  if (mark === "stuck" || mark === "removed") return style.error;
  return style.muted;
}

/** The progress strip: the page's functional specs, built, growing, planned and waiting, in their colours. */
export function progressStrip(page: MarkedPage, style: TranscriptStyle, cells = 24): string {
  const specs = page.items.filter((item) => item.section === FUNCTIONAL_REQUIREMENTS && item.state !== "removed");
  if (specs.length === 0) return "";
  const parts: Array<{ count: number; glyph: string; paint: (text: string) => string }> = [
    { count: specs.filter((item) => item.mark === "built").length, glyph: "█", paint: style.success ?? style.added },
    { count: specs.filter((item) => item.mark === "growing").length, glyph: "█", paint: style.accent },
    { count: specs.filter((item) => item.mark === "planned").length, glyph: "▓", paint: style.muted },
  ];
  let used = 0;
  let out = "";
  let done = 0;
  for (const part of parts) {
    done += part.count;
    const upTo = Math.round((done / specs.length) * cells);
    if (upTo > used) out += part.paint(part.glyph.repeat(upTo - used));
    used = Math.max(used, upTo);
  }
  return out + style.muted("░".repeat(Math.max(0, cells - used)));
}

/** A module's row: opened or closed, its file, its strip, how many of its functional specs are built, and its status. */
/** The map's top line: the page's name, its strip and its count and status. */
export function specMapHeader(page: MarkedPage, width: number, style: TranscriptStyle, waiting = ""): string {
  const { built, total } = countOf(page);
  const strip = progressStrip(page, style);
  const count = total > 0 ? `${built} of ${total} ${total === 1 ? "functionality" : "functionalities"} built · ` : "";
  // Short, never cut off: what for, and how, is under the first `!`.
  const status = page.stuck ? style.error(`${LADDER.needsYou} needs you`) : page.status;
  // The module's file heads its column, under this line.
  return truncateToWidth(`${style.heading("regen")}${strip !== "" ? `  ${strip}` : ""}  ${count}${status}${waiting}`, width);
}
/**
 * The minimap: a column down the right edge, a cell for each slice of the page - the most pressing mark in it - and
 * the slice shown solid.
 */
export function minimap(marks: LineMark[], height: number, top: number, style: TranscriptStyle): string[] {
  const rank: Record<string, number> = { growing: 6, stuck: 5, planned: 4, planning: 3, removed: 3, waiting: 2, built: 1 };
  const out: string[] = [];
  const total = Math.max(1, marks.length);
  for (let row = 0; row < height; row += 1) {
    const from = Math.floor((row * total) / height);
    const to = Math.max(from + 1, Math.floor(((row + 1) * total) / height));
    let best: LineMark;
    for (let at = from; at < to && at < marks.length; at += 1) if ((rank[marks[at] ?? ""] ?? 0) > (rank[best ?? ""] ?? 0)) best = marks[at];
    const shown = to > top && from < top + height;
    out.push(best === undefined ? style.muted(shown ? "┃" : "│") : paintOf(best, style)(shown ? "█" : "▐"));
  }
  return out;
}
