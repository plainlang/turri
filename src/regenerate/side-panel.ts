import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Job } from "./jobs.ts";
import { createJobsTreeState, jobsTreeLines, jobsTreeRows, keepCursorInView, scrollTree, treeKey, type JobsTreeState, type TreeRow } from "./jobs-tree.ts";
import type { MarkedPage } from "./spec-map.ts";
import { columnHeadings, createSpecMapState, DISCUSS_KEY, legendLines, minimap, shownPage, specMapHeader, specMapLines, switchTab, tabBar, type MapRow, type SpecMapState } from "./spec-map-view.ts";
import type { TranscriptStyle } from "./transcript-view.ts";

/**
 * The side panel: the spec and how far the code has grown, beside the conversation rather than instead of it.
 *
 * Two views. The regeneration (spec-map-view.ts), shown first: every item of the spec with where it stands - built, growing,
 * planned, waiting, being taken out - under a row for each module, the one in focus open. And the pulses, as a
 * tree - running, queued, finished, a line per pulse and all of what it builds once opened (see jobs-tree.ts). `p`
 * goes from one to the other, the cursor with it: from an item to the pulse that grows it, and back. What the agents
 * said and did is not shown here: it is in each pulse's log (job-log.ts).
 */

export interface SidePanelOptions {
  /** Every job, oldest first. */
  jobs: () => Job[];
  /** The regeneration's pages. Not given: the pulse list alone. */
  map?: () => MarkedPage[];
  /** Rows the panel may use. */
  rows: () => number;
  style: TranscriptStyle;
  /** Back to the conversation: the panel closes. */
  back: () => void;
  /** Whether something in the conversation waits for the person - a question asked while the panel showed. */
  waiting?: () => boolean;
  /** Close the panel. */
  close: () => void;
  /**
   * A module needs the person - `!`: the panel closes, and the chat takes it up with them - what went wrong, and what
   * to do about it. Not given: the key is not offered.
   */
  discuss?: (page: MarkedPage) => void;
  /** The key that opens and closes it, shown in the footer. */
  key: string;
  /** The pulse list's tree - what is open, where the cursor is - kept across openings of the panel. */
  tree?: JobsTreeState;
  /** The regeneration's view - which page, what is open, where the cursor is, which view shows - kept the same way. */
  mapState?: SpecMapState;
}

/** The lines drawn last, and what the keys move over. */
interface Drawn<Row> {
  rows: Row[];
  rowStarts: number[];
  lineCount: number;
}

export function createSidePanel(options: SidePanelOptions) {
  const style = options.style;
  let lastBodyHeight = 10;

  /** The tree: kept by the conversation, so it is as it was left when the panel opens again. */
  const tree = options.tree ?? createJobsTreeState();
  const map = options.mapState ?? createSpecMapState();
  if (options.map === undefined) map.view = "pulses";
  let drawnTree: Drawn<TreeRow> = { rows: [], rowStarts: [], lineCount: 0 };
  let drawnMap: Drawn<MapRow> = { rows: [], rowStarts: [], lineCount: 0 };
  let pages: MarkedPage[] = [];

  const waitingNote = () =>
    // A question asked while it showed waits in the chat, unanswered: the person is told it is there.
    options.waiting?.() === true ? `   ${style.warning?.("your question is waiting") ?? style.accent("your question is waiting")} - ${options.key} or esc to answer it, as you left it` : "";

  /** The top of a view, where it is seen first: its title, a line of space, and the keys, in `room` - wrapped, never cut short. */
  const topBlock = (title: string[], keys: string[], room: number): string[] => [
    ...title.flatMap((line) => wrapTextWithAnsi(line, room)),
    "",
    ...keyLines(keys, room).map(style.muted),
  ];

  /** The legend in a box of its own, for the panel's upper right corner. */
  const legendBox = (legend: string[]): string[] => {
    if (legend.length === 0) return [];
    const inner = Math.max(...legend.map(visibleWidth));
    return [
      style.muted(`┌${"─".repeat(inner + 2)}┐`),
      ...legend.map((entry) => `${style.muted("│")} ${entry}${" ".repeat(inner - visibleWidth(entry))} ${style.muted("│")}`),
      style.muted(`└${"─".repeat(inner + 2)}┘`),
    ];
  };

  /** The box laid over the upper right corner: what is under it cut where it starts, with no ellipsis. */
  const overBox = (lines: string[], box: string[], width: number): string[] => {
    if (box.length === 0) return lines;
    const room = width - visibleWidth(box[0]!) - 1;
    return lines.map((line, index) => {
      if (index >= box.length) return line;
      const left = truncateToWidth(line, room, "");
      return `${left}${" ".repeat(Math.max(0, room - visibleWidth(left)))} ${box[index]}`;
    });
  };

  /** The keys, as many to a line as fit, a line broken only between two keys - one too long alone wrapped. */
  const keyLines = (keys: string[], room: number): string[] => {
    const lines: string[] = [];
    for (const key of keys) {
      const last = lines.at(-1);
      if (last !== undefined && visibleWidth(`${last} · ${key}`) <= room) lines[lines.length - 1] = `${last} · ${key}`;
      else lines.push(...wrapTextWithAnsi(key, room));
    }
    return lines;
  };

  /** The rule under the top. */
  const rule = (width: number) => style.muted("─".repeat(Math.max(1, width)));

  const renderPulses = (width: number, rows: number): string[] => {
    const keys = ["↑↓ move", "enter open/close", "←→", "o/c all", "pgup pgdn scroll", ...(options.map !== undefined ? ["p regen"] : []), `esc or ${options.key} back to the chat`];
    const top = topBlock([`${style.heading("pulses")}${waitingNote()}`], keys, width);
    // Under the top: the rule, and a line of space - as the map has.
    const bodyHeight = Math.max(3, rows - top.length - 2);
    lastBodyHeight = bodyHeight;
    // The tree scrolls to keep the cursor in sight, and only that far.
    const tree_ = jobsTreeLines(options.jobs(), tree, width, style);
    drawnTree = { rows: tree_.rows, rowStarts: tree_.rowStarts, lineCount: tree_.lines.length };
    keepCursorInView(tree, tree_.rowStarts, tree_.lines.length, bodyHeight);
    const visible = tree_.lines.slice(tree.top, tree.top + bodyHeight);
    while (visible.length < bodyHeight) visible.push("");
    return [...top, rule(width), "", ...visible.map((line) => truncateToWidth(line, width))];
  };

  const renderMap = (width: number, rows: number): string[] => {
    pages = options.map!();
    const now = Date.now();
    if (pages.length === 0) {
      const top = topBlock([`${style.heading("regen")}${waitingNote()}`], ["p pulses", `esc or ${options.key} back to the chat`], width);
      lastBodyHeight = Math.max(3, rows - top.length - 1);
      drawnMap = { rows: [], rowStarts: [], lineCount: 0 };
      const body = [style.muted("  No .plain file to map: name one to regenerate, or set module: in config.turri.yaml."), ...new Array<string>(Math.max(0, lastBodyHeight - 1)).fill("")];
      return [...top, rule(width), ...body];
    }
    // A chain of modules: a tab each, on a line of their own under the top line.
    const tabbed = pages.length > 1;
    const page = shownPage(pages, map)!;
    const discuss = page.stuck && options.discuss !== undefined ? [`${DISCUSS_KEY} talk it through in the chat`] : [];
    const keys = [...discuss, "↑↓ move", "enter open/close", ...(tabbed ? ["←→ module"] : []), "o/c all", "pgup pgdn", "p pulses", `esc or ${options.key} back to the chat`];
    // The legend's box in the upper right corner, over what is under it; too narrow a panel has none.
    const box = width >= 60 ? legendBox(legendLines(page, style)) : [];
    const room = box.length > 0 ? width - visibleWidth(box[0]!) - 1 : width;
    // The top line whole - it wraps beside the box; the tabs fit themselves, counting what does not fit.
    const title = [specMapHeader(page, Number.MAX_SAFE_INTEGER, style, waitingNote()), ...(tabbed ? [tabBar(pages, page, room, style, now)] : [])];
    const top = topBlock(title, keys, room);
    // Under the top: the rule, a line of space, and the columns' headings - two lines.
    const bodyHeight = Math.max(3, rows - top.length - 4);
    lastBodyHeight = bodyHeight;
    // A long map has a minimap down its right edge: the content gives it two columns.
    const first = specMapLines(pages, map, width, style, options.jobs(), now);
    const long = first.lines.length > bodyHeight && width > 40;
    const drawn = long ? specMapLines(pages, map, width - 2, style, options.jobs(), now) : first;
    drawnMap = { rows: drawn.rows, rowStarts: drawn.rowStarts, lineCount: drawn.lines.length };
    keepCursorInView(map, drawn.rowStarts, drawn.lines.length, bodyHeight);
    const visible = drawn.lines.slice(map.top, map.top + bodyHeight).map((line) => truncateToWidth(line, long ? width - 2 : width));
    while (visible.length < bodyHeight) visible.push("");
    const body = long
      ? (() => {
          const strip = minimap(drawn.marks, bodyHeight, map.top, style);
          return visible.map((line, row) => `${line}${" ".repeat(Math.max(0, width - 2 - visibleWidth(line)))} ${strip[row]}`);
        })()
      : visible;
    // The rule beside the box stops short of it.
    return overBox([...top, rule(top.length < box.length ? room - 1 : width), "", ...columnHeadings(page, width, style), ...body], box, width);
  };

  /** From the map to the pulse list: onto the pulse that grows the item under the cursor, when one does. */
  const toPulses = () => {
    map.view = "pulses";
    const row = drawnMap.rows[map.cursor];
    const id = row?.kind === "item" ? row.item.pulse?.rowId : undefined;
    if (id === undefined) return;
    const jobs = options.jobs();
    const job = jobs.find((entry) => entry.id === id);
    if (job === undefined) return;
    const section = job.status === "running" ? "running" : job.status === "queued" ? "queued" : "finished";
    tree.open[section] = true;
    const at = jobsTreeRows(jobs, tree).findIndex((entry) => entry.kind === "job" && entry.job.id === id);
    if (at !== -1) tree.cursor = at;
  };

  /** From the pulse list to the map: onto the first item the pulse under the cursor grows, on whichever page it is. */
  const toMap = () => {
    map.view = "map";
    const row = drawnTree.rows[tree.cursor];
    const id = row !== undefined && row.kind !== "section" ? row.job.id : undefined;
    if (id === undefined) return;
    for (const page of options.map?.() ?? []) {
      const item = page.items.find((entry) => entry.pulse?.rowId === id);
      if (item === undefined) continue;
      // Inside a closed module, or a closed import block: they open, so the item can be shown.
      map.reveal = { file: page.plainFile, key: item.key };
      return;
    }
  };

  /** A key in the map. */
  const mapKey = (data: string) => {
    const page = Math.max(1, lastBodyHeight - 1);
    const rows = drawnMap.rows;
    const row = rows[map.cursor];
    const move = (to: number) => {
      map.cursor = Math.max(0, Math.min(rows.length - 1, to));
      map.cursorKey = rows[map.cursor]?.key;
    };
    const isOpen = (target: MapRow) => (target.kind === "item" ? map.open.has(target.key) : target.kind === "group" ? false : target.open);
    const toggle = (target: MapRow | undefined, open?: boolean) => {
      // A group's heading only says what is under it.
      if (target === undefined || target.kind === "group") return;
      const to = open ?? !isOpen(target);
      if (target.kind === "import") map.imports.set(target.key.replace(/^import\n/, ""), to);
      else if (to) map.open.add(target.key);
      else map.open.delete(target.key);
    };
    if (matchesKey(data, Key.up)) move(map.cursor - 1);
    else if (matchesKey(data, Key.down)) move(map.cursor + 1);
    else if (matchesKey(data, Key.enter) || data === " ") toggle(row);
    // ←→ go from one module's tab to the next.
    else if (matchesKey(data, Key.right)) switchTab(pages, map, 1);
    else if (matchesKey(data, Key.left)) switchTab(pages, map, -1);
    else if (data === "o" || data === "c") for (const entry of rows) toggle(entry, data === "o");
    else if (data === DISCUSS_KEY && options.discuss !== undefined) {
      const shown = shownPage(pages, map);
      if (shown?.stuck === true) options.discuss(shown);
    }
    else if (matchesKey(data, Key.pageUp)) scrollMap(-page);
    else if (matchesKey(data, Key.pageDown)) scrollMap(page);
    else if (matchesKey(data, Key.home) || data === "g") move(0);
    else if (matchesKey(data, Key.end) || data === "G") move(rows.length - 1);
  };

  const scrollMap = (by: number) => {
    scrollTree(map, by, drawnMap.rowStarts, drawnMap.lineCount, lastBodyHeight);
    map.cursorKey = drawnMap.rows[map.cursor]?.key;
  };

  return {
    render(width: number): string[] {
      const rows = Math.max(8, options.rows());
      try {
        return map.view === "map" && options.map !== undefined ? renderMap(width, rows) : renderPulses(width, rows);
      } catch (error) {
        // A frame that throws is never drawn - nor is anything after it: the screen would freeze. What failed is shown instead.
        const top = topBlock([`${style.heading(map.view === "map" ? "regen" : "pulses")}${waitingNote()}`], [...(options.map !== undefined ? ["p the other view"] : []), `esc or ${options.key} back to the chat`], width);
        const lines = (error instanceof Error ? (error.stack ?? error.message) : String(error)).split("\n").slice(0, Math.max(1, rows - top.length - 1));
        return [
          ...top,
          rule(width),
          ...lines.map((line, index) => truncateToWidth(index === 0 ? style.error(`could not be drawn: ${line}`) : style.muted(line), width)),
          ...new Array<string>(Math.max(0, rows - top.length - 1 - lines.length)).fill(""),
        ];
      }
    },

    handleInput(data: string): void {
      if (matchesKey(data, Key.escape)) {
        options.back();
        return;
      }
      if (options.map !== undefined && data === "p") {
        if (map.view === "map") toPulses();
        else toMap();
        return;
      }
      if (map.view === "map" && options.map !== undefined) {
        mapKey(data);
        return;
      }
      const page = Math.max(1, lastBodyHeight - 1);
      const key = matchesKey(data, Key.up)
        ? "up"
        : matchesKey(data, Key.down)
          ? "down"
          : matchesKey(data, Key.enter) || data === " "
            ? "toggle"
            : matchesKey(data, Key.right)
              ? "open"
              : matchesKey(data, Key.left)
                ? "close"
                : data === "o"
                  ? "openAll"
                  : data === "c"
                    ? "closeAll"
                    : undefined;
      if (key !== undefined) treeKey(tree, drawnTree.rows, key);
      else if (matchesKey(data, Key.pageUp)) scrollTree(tree, -page, drawnTree.rowStarts, drawnTree.lineCount, lastBodyHeight);
      else if (matchesKey(data, Key.pageDown)) scrollTree(tree, page, drawnTree.rowStarts, drawnTree.lineCount, lastBodyHeight);
      else if (matchesKey(data, Key.home) || data === "g") tree.cursor = 0;
      else if (matchesKey(data, Key.end) || data === "G") tree.cursor = Math.max(0, drawnTree.rows.length - 1);
    },

    /** The wheel scrolls the panel wherever the keyboard is. */
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
      if (event.type !== "wheel" || event.wheelDelta === undefined) return undefined;
      if (map.view === "map" && options.map !== undefined) scrollMap(event.wheelDelta * 3);
      else scrollTree(tree, event.wheelDelta * 3, drawnTree.rowStarts, drawnTree.lineCount, lastBodyHeight);
      return { handled: true };
    },

    invalidate(): void {},
  };
}
