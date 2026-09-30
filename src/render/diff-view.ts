import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { highlightLine, roleOf, type HighlightState, type PlainRole } from "../plain/highlight.ts";
import { RESOURCE_MARKER } from "../plain/markdown.ts";

/**
 * A spec diff as the panels show it: each line's ***plain highlighted as plyn highlights it
 * (`plain/highlight.ts`), an added line on a green band and a removed one on a red, the band the width
 * of the panel - as an editor shows a diff. Each file is named once, quietly, above its hunks - not
 * git's headers - and a hunk header is a quiet rule between hunks.
 */

/** How a diff is painted: ***plain's colours, and the fills of added and removed lines (`plain-palette.ts`). */
export interface DiffPaint {
  /** A piece of ***plain, by what it is. */
  syntax(role: PlainRole, text: string): string;
  /** The +/- in front of an added or removed line. */
  added(text: string): string;
  removed(text: string): string;
  /** A whole added or removed row, padded to the width: its band. */
  addedBand(text: string): string;
  removedBand(text: string): string;
  muted(text: string): string;
}

/** Painted with nothing: the text as it is, for where there are no colours. */
export const PLAIN_PAINT: DiffPaint = {
  syntax: (_colour, text) => text,
  added: (text) => text,
  removed: (text) => text,
  addedBand: (text) => text,
  removedBand: (text) => text,
  muted: (text) => text,
};

/**
 * Where the lines of a diff are in the .plain files: by a line's place in the diff, the file it is in and its
 * line there. Only lines that are in a file - added and unchanged ones; a removed line is in none now.
 */
export type DiffWhere = Record<number, { file: string; line: number; section?: string }>;

/** A section's header: `***functional specs***`. */
const SECTION = /^\*\*\*[^*].*\*\*\*$/;

/** A line of a .plain file as the spec reads it: its links as the parser renders them (markdown.ts). */
function asRead(line: string): string {
  return line.replace(/\[([^\]]*)\]\([^)]*\)/g, (_, text: string) => `\`${RESOURCE_MARKER}${text}\``);
}

/**
 * Place a spec diff's lines in the .plain files they come from - `files`, the module's and every one it
 * reads, named as they are to be shown. A spec diff is of the spec as read, the files it imports laid into
 * it, so its own line numbers are not the file's: each line is found where it is written, the file a line
 * before it was found in first, from there on, and each place once.
 */
export function locateDiffLines(diff: string, files: Array<{ name: string; text: string }>): DiffWhere {
  const where: DiffWhere = {};
  // Each line as the parser renders it: a link `[text](path)` is the span `` `[resource]text` `` in the spec as read.
  const texts = files.map((file) => ({ name: file.name, lines: file.text.split("\n").map((line) => asRead(line.trimEnd())) }));
  // The section each line of a file is in: the nearest `***...***` header above it, or on it.
  const sections = texts.map((file) => {
    let current: string | undefined;
    return file.lines.map((line) => (SECTION.test(line.trim()) ? (current = line.trim()) : current));
  });
  const used = new Set<string>();
  let last: { file: number; line: number } | undefined;
  const take = (file: number, line: number, index: number) => {
    used.add(`${file}:${line}`);
    const section = sections[file]![line];
    where[index] = { file: texts[file]!.name, line: line + 1, ...(section !== undefined ? { section } : {}) };
    last = { file, line };
  };
  diff
    .replace(/\n+$/, "")
    .split("\n")
    .forEach((line, index) => {
      if (HEADER.test(line) || line.startsWith("+++ ") || line.startsWith("@@") || line.startsWith("\\") || line.startsWith("-")) return;
      const text = (line.startsWith("+") || line.startsWith(" ") ? line.slice(1) : line).trimEnd();
      if (text === "") {
        // A blank line: the one right after the line before it, when that is blank.
        if (last !== undefined && texts[last.file]!.lines[last.line + 1] === "" && !used.has(`${last.file}:${last.line + 1}`)) take(last.file, last.line + 1, index);
        return;
      }
      const order = last === undefined ? texts.map((_, file) => file) : [last.file, ...texts.map((_, file) => file).filter((file) => file !== last!.file)];
      for (const file of order) {
        const lines = texts[file]!.lines;
        const from = last !== undefined && file === last.file ? last.line + 1 : 0;
        const found = [...lines.keys()].slice(from).concat([...lines.keys()].slice(0, from)).find((at) => lines[at] === text && !used.has(`${file}:${at}`));
        if (found !== undefined) return take(file, found, index);
      }
    });
  return where;
}

const HEADER = /^(diff --git |index |--- |new file mode |deleted file mode )/;

/** A file's part of a spec diff, as the panels show it: its name, what it adds and takes out, and its rows. */
export interface DiffFile {
  file: string;
  added: number;
  removed: number;
  rows: string[];
}

/** A line of the diff, read: its sign, its text highlighted, where it is. */
interface ReadLine {
  index: number;
  sign: "+" | "-" | " ";
  coloured: string;
  file: string;
  at?: { file: string; line: number; section?: string };
  /** The section it is in: in its file, or - placed nowhere - as the diff has it. */
  section?: string;
  /** It is a section's header itself. */
  header: boolean;
}

/**
 * A spec diff, file by file: each file's lines together, however the diff has them - a spec diff is of the
 * spec as read, so what one file holds can come in more than one place - the file being rendered first,
 * the rest by name. Each line is in the file it is placed in (`where`); a line placed nowhere - a removed
 * one, or one written other than it reads - goes with the line placed before it, else the one after it,
 * else the file the diff's own header names. The file being rendered is the one the diff's header names.
 */
export function diffFiles(diff: string, width: number, paint: DiffPaint = PLAIN_PAINT, where?: DiffWhere): DiffFile[] {
  const inner = Math.max(10, width);
  const lines = diff.replace(/\n+$/, "").split("\n");
  // The gutter: as wide as the largest line number there is. None known, there is no gutter.
  const digits = where === undefined || Object.keys(where).length === 0 ? 0 : String(Math.max(...Object.values(where).map((at) => at.line))).length;

  // Every line highlighted in the diff's order, so front matter one opens is carried to the lines after it on its side.
  let before: HighlightState = [];
  let after: HighlightState = [];
  let headerFile: string | undefined;
  let removedFrom: string | undefined;
  let rendered: string | undefined;
  // The section the diff is in on each side, from the headers it shows: for lines placed nowhere.
  let sectionBefore: string | undefined;
  let sectionAfter: string | undefined;
  const read: ReadLine[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("--- ")) removedFrom = line.slice(4).replace(/^a\//, "");
    if (line.startsWith("+++ ")) {
      // The file, by the name it has after the change - or had, when the change removes it.
      const named = line.slice(4).replace(/^b\//, "");
      headerFile = named === "/dev/null" ? (removedFrom ?? named) : named;
      rendered ??= headerFile;
      before = [];
      after = [];
      continue;
    }
    if (HEADER.test(line) || line.startsWith("@@") || line.startsWith("\\")) continue;
    const sign = line[0] === "+" || line[0] === "-" ? line[0] : " ";
    const text = sign === " " && !line.startsWith(" ") ? line : line.slice(1);
    let tokens;
    if (sign === "-") ({ tokens, state: before } = highlightLine(text, before));
    else if (sign === "+") ({ tokens, state: after } = highlightLine(text, after));
    else {
      // On both sides: each carries what it has open on.
      ({ tokens, state: before } = highlightLine(text, before));
      after = highlightLine(text, after).state;
    }
    const coloured = tokens
      .map((token) => {
        const role = roleOf(token.scopes);
        return role === undefined ? token.text : paint.syntax(role, token.text);
      })
      .join("");
    const header = SECTION.test(text.trim());
    if (header && sign !== "+") sectionBefore = text.trim();
    if (header && sign !== "-") sectionAfter = text.trim();
    const at = where?.[index];
    const section = at?.section ?? (sign === "-" ? sectionBefore : sectionAfter);
    read.push({ index, sign, coloured, file: at?.file ?? headerFile ?? "", header, ...(at !== undefined ? { at } : {}), ...(section !== undefined ? { section } : {}) });
  }
  // A line placed nowhere is never put in a file on a guess. A removed one - in no file now - is in the file of the
  // change it is part of: the lines placed in its own run of removed and added lines, or else the line right beside
  // it. Any other goes with the lines found in no file, named as such.
  // With nothing placed at all - a diff of the files themselves - its own headers say which file each line is in.
  for (const [at, line] of read.entries()) {
    if (line.at !== undefined || where === undefined) continue;
    line.file = NOT_FOUND;
    // A blank line says nothing of where it is: it goes with the line before it in the diff, or else the one after it.
    // Never a line of its own under "not found": beside nothing placed, it goes with the file being rendered.
    if (visibleWidth(line.coloured.trim()) === 0) {
      const candidates = [read[at - 1]?.file, read[at + 1]?.at?.file, headerFile];
      line.file = candidates.find((file): file is string => file !== undefined && file !== NOT_FOUND) ?? line.file;
      continue;
    }
    if (line.sign !== "-") continue;
    const run: ReadLine[] = [];
    for (let i = at; i >= 0 && read[i]!.sign !== " " && (i === at || read[i + 1]!.index - read[i]!.index === 1); i -= 1) run.unshift(read[i]!);
    for (let i = at + 1; i < read.length && read[i]!.sign !== " " && read[i]!.index - read[i - 1]!.index === 1; i += 1) run.push(read[i]!);
    const placed = run.find((other) => other.sign === "+" && other.at !== undefined) ?? run.find((other) => other.at !== undefined);
    const beside = [read[at - 1], read[at + run.length - run.indexOf(line)]].find(
      (other) => other !== undefined && other.at !== undefined && Math.abs(other.index - line.index) <= run.length,
    );
    const file = placed?.at?.file ?? beside?.at?.file;
    if (file !== undefined) line.file = file;
  }

  // The file being rendered first - the diff names it by its path from where it was written - then the rest by name.
  const names = [...new Set(read.map((line) => line.file))];
  const isRendered = (name: string) => rendered !== undefined && (name === rendered || rendered.endsWith(`/${name}`) || name.endsWith(`/${rendered}`));
  // The lines found in no file last.
  const rank = (name: string) => (name === NOT_FOUND ? 2 : isRendered(name) ? 0 : 1);
  names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

  // Only the files the diff changes: one whose lines are all context around a change elsewhere is not shown, and nor is
  // one whose only change is a blank line - spacing, not the spec.
  const changed = names.filter((file) => read.some((line) => line.file === file && line.sign !== " " && visibleWidth(line.coloured.trim()) > 0));
  return changed.map((file) => {
    const own = read.filter((line) => line.file === file);
    const rows: string[] = [];
    let previous: ReadLine | undefined;
    // Lines of the file not in the diff, as GitHub marks them: above the first block, and between two.
    // Its section beside it, as GitHub names a hunk's function - unless the block starts with the section's header itself.
    const hidden = (arrow: string, count: number | undefined, next: ReadLine | undefined) => {
      const lines = paint.muted(`${" ".repeat(digits)}${digits > 0 ? " " : ""}${arrow}${count !== undefined && count > 0 ? ` ${count} line${count === 1 ? "" : "s"}` : ""}`);
      return next?.section !== undefined && !next.header ? `${lines}${paint.muted(" · ")}${paint.syntax("section", next.section)}` : lines;
    };
    const firstAt = own.find((line) => line.at !== undefined)?.at?.line;
    if (own[0] !== undefined) {
      // Above the first block: how many lines are hidden there, when that is known - and its section, unless it starts with it.
      const count = own[0].at !== undefined && firstAt !== undefined ? firstAt - 1 : undefined;
      if ((count !== undefined && count > 0) || (own[0].section !== undefined && !own[0].header)) rows.push(hidden("↑", count, own[0]));
    }
    for (const line of own) {
      // Where its lines do not follow on from each other - another hunk, or another place in the file - the lines between are hidden.
      if (previous !== undefined) {
        const gap = line.at !== undefined && previous.at !== undefined ? line.at.line - previous.at.line - 1 : undefined;
        const follows = gap !== undefined ? gap <= 0 : line.index - previous.index <= 1;
        if (!follows) rows.push(hidden("↕", gap, line));
      }
      previous = line;
      const mark = line.sign === "+" ? paint.added("+") : line.sign === "-" ? paint.removed("-") : " ";
      const gutter = line.at !== undefined ? paint.muted(String(line.at.line).padStart(digits)) : " ".repeat(digits);
      const lead = digits > 0 ? `${gutter} ` : "";
      const blank = " ".repeat(digits > 0 ? digits + 1 : 0);
      const [first = "", ...rest] = line.coloured === "" ? [""] : wrapTextWithAnsi(line.coloured, inner - 2 - blank.length);
      // Continuations under the text, not the number or the sign: those columns stay clear.
      for (const row of [`${lead}${mark} ${first}`, ...rest.map((part) => `${blank}  ${part}`)]) {
        const padded = `${row}${" ".repeat(Math.max(0, inner - visibleWidth(row)))}`;
        rows.push(line.sign === "+" ? paint.addedBand(padded) : line.sign === "-" ? paint.removedBand(padded) : row);
      }
    }
    return { file, added: own.filter((line) => line.sign === "+").length, removed: own.filter((line) => line.sign === "-").length, rows };
  });
}

/** A file's header: its name, and what it adds and takes out. `open`, with the mark of a group that opens and closes. */
export function fileHeader(file: DiffFile, paint: DiffPaint, open?: boolean): string {
  const mark = open === undefined ? "" : open ? "▾ " : "▸ ";
  const counts = [file.added > 0 ? paint.added(`+${file.added}`) : "", file.removed > 0 ? paint.removed(`−${file.removed}`) : ""].filter(Boolean).join(" ");
  return `${paint.muted(`${mark}${file.file === "" ? "(the spec)" : file.file}`)}${counts !== "" ? `  ${counts}` : ""}`;
}

/** Where a spec diff's lines go that are in none of the spec's files as they are written. */
export const NOT_FOUND = "not found in the spec's files";

/** The diff's lines, at most `width` wide: every file, each under its header - for a view that opens none and closes none. */
export function diffView(diff: string, width: number, paint: DiffPaint = PLAIN_PAINT, where?: DiffWhere): string[] {
  return diffFiles(diff, width, paint, where).flatMap((file) => [fileHeader(file, paint), ...file.rows]);
}
