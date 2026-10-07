import { basename } from "node:path";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { highlightLine, roleOf, type PlainRole } from "../plain/highlight.ts";
import { DEFINITIONS, FUNCTIONAL_REQUIREMENTS, NON_FUNCTIONAL_REQUIREMENTS } from "../plain/spec.ts";
import type { DiffPaint } from "./diff-view.ts";
import { spinner } from "./job-panel.ts";
import { formatDuration, type Job } from "./jobs.ts";
import { countOf, type Mark, type MarkedItem, type MarkedPage } from "./spec-map.ts";
import type { TranscriptStyle } from "./transcript-view.ts";

/**
 * The regeneration drawn: a page a module, an item a row - see spec-map.ts for what each mark means.
 *
 * Each item's first line, with its mark in the gutter and its conformance tests beside it; a changed item's changed
 * sub-bullets under it, word by word; an item taken out as a struck-through ghost. Enter opens an item: all of it, its
 * acceptance tests, the pulse that brings it, its conformance tests, and - a definition - the built specs that use it.
 * Every module of the map is a row of its own - its strip, its count, its status - opened and closed like a block: the
 * module in focus open, the rest closed until opened. Under a module opened, after its own text, what it is built from
 * in two groups: the files it imports, a folded block each, and the modules it requires - down its chain, nearest
 * first - each a module row of its own; all closed until opened. A module another one requires is shown there, not
 * at the top.
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
  /** Modules opened or closed by hand, by where they are: the rest open only while in focus. */
  modules: Map<string, boolean>;
  /** An item to show - in its module and import block, opened for it - and put the cursor on: by .plain file and key. */
  reveal?: { file: string; key: string };
}

export function createSpecMapState(): SpecMapState {
  return { view: "map", cursor: 0, top: 0, open: new Set(), imports: new Map(), modules: new Map() };
}

/** A row: a module, at the top or required by the one above it; a group's heading; an import block; an item. */
export type MapRow =
  | { kind: "module"; page: MarkedPage; key: string; open: boolean; depth: number }
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
/** Strike text through. */
const strike = (text: string) => `\x1b[9m${text}\x1b[29m`;

/** How far a group, and what is in it, is indented under its module. */
const INDENT = "  ";

/** The gutter before the bar: the cursor, the mark, the tests. */
const GUTTER = 6;
const BAR = "│ ";
const CONTINUED = `${" ".repeat(GUTTER)}${BAR}`;

function markText(item: MarkedItem, style: TranscriptStyle, now: number): string {
  const glyph =
    item.state === "removed"
      ? style.error("−")
      : item.mark === "built"
        ? (style.success ?? style.added)("✓")
        : item.mark === "growing"
          ? style.accent(spinner(now))
          : item.mark === "planned"
            ? // Provisional: dimmer than the one growing.
              style.muted(String(item.pulse!.number))
            : item.mark === "planning"
              ? style.accent("…")
              : item.mark === "stuck"
                ? style.error("!")
                : item.mark === "waiting"
                  ? style.muted("·")
                  : " ";
  const width = visibleWidth(glyph);
  return `${" ".repeat(Math.max(0, 2 - width))}${glyph}`;
}

/**
 * The mark of a functional spec its conformance tests pass for: more than tested - its code is shown, end to end, to
 * do what the spec says. ⊨ is "satisfies": the code satisfies the spec.
 */
export const CONFORMS = "⊨";

function testsText(item: MarkedItem, style: TranscriptStyle, now: number): string {
  // A test req's own mark says it: it is the conformance tests' alone.
  if (item.state === "test") return " ";
  if (item.testing === true) return style.accent(spinner(now));
  if (item.tests === "now") return (style.conforms ?? style.success ?? style.added)(CONFORMS);
  if (item.tests === "older") return style.muted(CONFORMS);
  if (item.tests === "removed") return style.error(strike(CONFORMS));
  return " ";
}

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
  if (line.was === line.now) return style.muted(line.now ?? "");
  if (line.was === undefined) return style.added(line.now ?? "");
  if (line.now === undefined) return style.removed(strike(line.was));
  return wordDiff(line.was, line.now, style);
}

/** The pulse's running job, for how long it has run. */
function elapsedOf(item: MarkedItem, jobs: Job[]): string | undefined {
  const job = item.pulse?.running === true ? jobs.find((entry) => entry.id === item.pulse!.rowId) : undefined;
  return job === undefined ? undefined : formatDuration(job);
}

/** What goes at the end of an item's row, when anything does. */
function annotation(item: MarkedItem, page: MarkedPage, jobs: Job[], style: TranscriptStyle): string {
  const elapsed = elapsedOf(item, jobs);
  if (item.state === "removed") {
    if (item.mark === "growing") return style.muted(`← being removed now${elapsed !== undefined ? ` · ${elapsed}` : ""}`);
    if (item.mark === "planned") return style.muted(`← removing in pulse ${item.pulse!.number}`);
  }
  if (item.mark === "growing" && item.state === "test") return style.accent(`← its conformance tests being written${elapsed !== undefined ? ` · ${elapsed}` : ""}`);
  if (item.mark === "growing") return style.accent(`← growing now${elapsed !== undefined ? ` · ${elapsed}` : ""}`);
  if (item.rolledBack !== undefined) return style.error(`← rolled back · was pulse ${item.rolledBack}`);
  if (item.mark === "planning" && item.state === "new") return style.muted("← new · planning");
  if (item.mark === "waiting" && item.state === "new" && page.tracked) return style.muted("← new · not planned yet");
  return "";
}

const firstLine = (text: string) => text.split("\n")[0] ?? "";

function wrapped(text: string, width: number, colour: (text: string) => string = (line) => line): string[] {
  return text
    .split("\n")
    .flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, Math.max(10, width - CONTINUED.length))))
    .map((line) => `${CONTINUED}${colour(line)}`);
}

/** All of an item, opened: its text, its acceptance tests, the pulse that brings it, its tests, what uses it. */
function detailLines(item: MarkedItem, page: MarkedPage, width: number, style: TranscriptStyle, jobs: Job[], now: number): string[] {
  const lines: string[] = [];
  // The rest of its text - its first line is the row - against the record's, for a change.
  const rest = item.state === "changed" ? lineDiff(item.was ?? "", item.text).slice(1) : item.text.split("\n").slice(1).map((line) => ({ was: line, now: line }));
  for (const line of rest) {
    const drawn = item.state === "removed" ? style.removed(strike(line.now ?? "")) : item.state === "changed" ? diffLine(line, style) : highlighted(line.now ?? "", style);
    lines.push(...wrapped(drawn, width));
  }
  if (item.state === "changed" && firstLine(item.was ?? "") !== firstLine(item.text)) lines.push(...wrapped(`was: ${firstLine(item.was ?? "")}`, width, style.muted));
  if (item.acceptance.length > 0) {
    lines.push(`${CONTINUED}${style.muted("acceptance tests:")}`);
    for (const test of item.acceptance) lines.push(...wrapped(test.split("\n").map((line) => `  ${highlighted(line, style)}`).join("\n"), width));
  }
  // Where it stands, when its mark alone does not say: growing, planned, or why it is neither. Built, the ✓ says it.
  const elapsed = elapsedOf(item, jobs);
  const pulse = item.pulse;
  const where =
    item.mark === "built" || item.mark === "none"
      ? undefined
      : item.state === "test"
        ? pulse !== undefined
          ? `a test req: conformance pulse ${pulse.number} writes the conformance tests to follow it${pulse.running ? `, now${elapsed !== undefined ? ` · ${elapsed}` : ""}` : ""}`
          : "a test req: the conformance tests do not follow it yet - they are written once the code is built"
        : pulse !== undefined
          ? `${item.state === "removed" ? "taken out" : "grown"} by pulse ${pulse.number}${pulse.running ? `, growing now${elapsed !== undefined ? ` · ${elapsed}` : ""}` : " (planned - the number moves when the plan is made again)"}: ${pulse.title}`
          : item.mark === "planning"
            ? "being planned into pulses now"
            : item.rolledBack !== undefined
              ? `pulse ${item.rolledBack} was growing it, and was rolled back: ${page.codebase?.stuck?.why ?? ""}`
              : item.mark === "stuck"
                ? `not growing: ${page.codebase?.stuck?.why ?? page.status}`
                : `not planned yet: ${page.status}`;
  if (where !== undefined) lines.push(...wrapped(where, width, item.mark === "stuck" ? style.error : style.muted));
  return lines;
}

/** An import block's line: its file, how many items, and how far they are built. */
function importSummary(items: MarkedItem[]): string {
  const counts = [
    [DEFINITIONS, "definition"],
    [NON_FUNCTIONAL_REQUIREMENTS, "req"],
    [FUNCTIONAL_REQUIREMENTS, "functional spec"],
  ] as const;
  const kinds = counts.map(([section, name]) => ({ name, count: items.filter((item) => item.section === section && item.state !== "removed").length })).filter((kind) => kind.count > 0);
  const size = kinds.length === 1 ? `${kinds[0]!.count} ${kinds[0]!.name}${kinds[0]!.count === 1 ? "" : "s"}` : `${items.filter((item) => item.state !== "removed" && item.state !== "test").length} items`;
  const changing = items.filter((item) => item.state === "new" || item.state === "changed" || item.state === "removed");
  if (changing.length === 0) return `${size} · all built`;
  const pulses = new Set(changing.map((item) => (item.pulse === undefined ? undefined : item.pulse.number)));
  const only = pulses.size === 1 ? [...pulses][0] : undefined;
  const growing = changing.some((item) => item.mark === "growing");
  return `${size} · ${changing.length} changing${growing ? " · growing now" : only !== undefined ? ` in pulse ${only}` : ""}`;
}

/**
 * The rows, top to bottom: each module not required by another, and - open - its own items, then the files it
 * imports and the modules it requires, each group under its heading. The module in focus is open - and the module it
 * is required by, so it can be seen - and the rest closed, unless opened or closed by hand.
 */
export function specMapRows(pages: MarkedPage[], state: SpecMapState): MapRow[] {
  const focus = focusOf(pages);
  const byModule = new Map(pages.map((page) => [page.module, page]));
  // The modules a module is built on, down its chain, nearest first.
  const below = (page: MarkedPage): MarkedPage[] => {
    const out: MarkedPage[] = [];
    for (let at = page.requires; at !== undefined && byModule.has(at) && !out.includes(byModule.get(at)!); at = byModule.get(at)!.requires) out.push(byModule.get(at)!);
    return out;
  };
  const required = new Set(pages.flatMap(below));
  const reveal = state.reveal;
  const rows: MapRow[] = [];
  const moduleRows = (page: MarkedPage, path: string, depth: number, chain: MarkedPage[]) => {
    const holds = (target: MarkedPage | undefined) => target !== undefined && (target === page || chain.includes(target));
    const revealed = reveal !== undefined ? pages.find((entry) => entry.plainFile === reveal.file) : undefined;
    const open = (holds(revealed) ? true : undefined) ?? state.modules.get(path) ?? holds(focus);
    if (holds(revealed)) state.modules.set(path, true);
    rows.push({ kind: "module", page, key: `module\n${path}`, open, depth });
    if (!open) return;
    const item = (entry: MarkedItem): MapRow => ({ kind: "item", page, item: entry, key: `${path}\n${entry.key}` });
    rows.push(...page.items.filter((entry) => entry.file === undefined).map(item));
    const imports = page.imports.filter((file) => page.items.some((entry) => entry.file === file));
    if (imports.length > 0) rows.push({ kind: "group", page, key: `group\n${path}\nimported`, label: `imported (${imports.length})`, depth });
    for (const file of imports) {
      const items = page.items.filter((entry) => entry.file === file);
      const key = `${path}\n${file}`;
      if (revealed === page && items.some((entry) => entry.key === reveal!.key)) state.imports.set(key, true);
      const opened = state.imports.get(key) ?? false;
      rows.push({ kind: "import", page, file, key: `import\n${key}`, open: opened, depth });
      if (opened) rows.push(...items.map(item));
    }
    // Its chain, flattened: each module below it once, without a chain of its own again.
    if (chain.length > 0) rows.push({ kind: "group", page, key: `group\n${path}\nrequired`, label: `required (${chain.length})`, depth });
    for (const lower of chain) moduleRows(lower, `${path}\n${lower.plainFile}`, depth + 1, []);
  };
  for (const page of pages) if (!required.has(page)) moduleRows(page, page.plainFile, 0, below(page));
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
  jobs: Job[] = [],
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
  let block: string | undefined;
  let section: string | undefined;
  // Straight under an import block's line: its first heading needs no blank line before it.
  let underImport = false;
  rows.forEach((row, index) => {
    const here = index === state.cursor;
    const pointer = here ? style.accent("›") : " ";
    const page = row.page;
    if (row.kind === "module") {
      // A blank line above a module - not between closed ones, which sit together, nor under its group's heading.
      const previous = rows[index - 1];
      const together = (previous?.kind === "module" && !previous.open && !row.open) || previous?.kind === "group";
      if (lines.length > 0 && !together) add("");
      block = undefined;
      section = undefined;
      rowStarts.push(lines.length);
      add(moduleLine(row.page, row.open, here, width, style, now, `${pointer}${INDENT.repeat(row.depth)}`));
      if (row.open && page.error !== undefined) add(style.error(`      its spec does not parse: ${page.error}`));
      else if (row.open && page.items.length === 0) add(style.muted("      nothing in this spec yet"));
      underImport = true;
      return;
    }
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
    const gutter = `${pointer}${markText(item, style, now)} ${testsText(item, style, now)} ${BAR}`;
    const note = annotation(item, page, jobs, style);
    const room = Math.max(10, width - GUTTER - BAR.length - (note === "" ? 0 : visibleWidth(note) + 3));
    const first = firstLine(item.text);
    const wasFirst = firstLine(item.was ?? "");
    const drawn =
      item.state === "removed"
        ? style.removed(strike(first))
        : item.state === "changed" && wasFirst !== first
          ? wordDiff(wasFirst, first, style)
          : highlighted(first, style);
    const text = truncateToWidth(drawn, room, "…");
    const line = `${gutter}${text}${note === "" ? "" : `${" ".repeat(Math.max(1, room - visibleWidth(text) + 3))}${note}`}`;
    add(line, mark);
    if (state.open.has(row.key)) {
      for (const detail of detailLines(item, page, width, style, jobs, now)) add(detail, mark);
      return;
    }
    // A changed item shows what changed in it, closed too: its changed sub-bullets, word by word.
    if (item.state === "changed") {
      const changed = lineDiff(item.was ?? "", item.text)
        .slice(1)
        .filter((line) => line.was !== line.now);
      for (const line of changed.slice(0, 4)) add(truncateToWidth(`${CONTINUED}${diffLine(line, style)}`, width, "…"), mark);
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
function moduleLine(page: MarkedPage, open: boolean, here: boolean, width: number, style: TranscriptStyle, now: number, pointer: string): string {
  const { built, total } = countOf(page);
  const growing = page.items.some((item) => item.mark === "growing");
  const name = `${open ? "▾" : "▸"} ${basename(page.plainFile)}`;
  const strip = progressStrip(page, style, 12);
  const status = page.stuck ? style.error(`! ${page.status}`) : growing ? style.accent(`${spinner(now)} ${page.status}`) : style.muted(page.status);
  const count = total > 0 ? style.muted(`${built}/${total} built · `) : "";
  return truncateToWidth(`${pointer} ${here ? style.heading(name) : name}${strip !== "" ? `  ${strip}` : ""}  ${count}${status}`, width, "…");
}
/** The map's top lines: the page's name, its strip and its count and status - and, for a chain, a tab a module. */
export function specMapHeader(page: MarkedPage, width: number, style: TranscriptStyle, waiting = ""): string {
  const { built, total } = countOf(page);
  const strip = progressStrip(page, style);
  const count = total > 0 ? `${built} of ${total} functional spec${total === 1 ? "" : "s"} built · ` : "";
  const status = page.stuck ? style.error(`! ${page.status}`) : page.status;
  return truncateToWidth(`${style.heading("Regeneration")}  ${basename(page.plainFile)}${strip !== "" ? `   ${strip}` : ""}  ${count}${status}${waiting}`, width);
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
