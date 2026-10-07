import { Key, matchesKey, truncateToWidth, visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Job } from "./jobs.ts";
import { createJobsTreeState, jobsTreeLines, jobsTreeRows, keepCursorInView, scrollTree, treeKey, type JobsTreeState, type TreeRow } from "./jobs-tree.ts";
import type { MarkedPage } from "./spec-map.ts";
import { createSpecMapState, focusOf, minimap, specMapHeader, specMapLines, type MapRow, type SpecMapState } from "./spec-map-view.ts";
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
    options.waiting?.() === true ? `   ${style.warning?.("the chat is waiting for your answer") ?? style.accent("the chat is waiting for your answer")} - ${options.key} to go back` : "";

  const renderPulses = (width: number, rows: number): string[] => {
    const bodyHeight = rows - 3;
    lastBodyHeight = bodyHeight;
    // The tree scrolls to keep the cursor in sight, and only that far.
    const tree_ = jobsTreeLines(options.jobs(), tree, width, style);
    drawnTree = { rows: tree_.rows, rowStarts: tree_.rowStarts, lineCount: tree_.lines.length };
    keepCursorInView(tree, tree_.rowStarts, tree_.lines.length, bodyHeight);
    const visible = tree_.lines.slice(tree.top, tree.top + bodyHeight);
    const where = tree_.lines.length > bodyHeight ? `${tree.top + 1}-${Math.min(tree_.lines.length, tree.top + bodyHeight)} of ${tree_.lines.length}` : "all shown";
    while (visible.length < bodyHeight) visible.push("");
    const keys = ["↑↓ move", "enter open/close", "←→", "o/c all", "pgup pgdn scroll", ...(options.map !== undefined ? ["p regeneration"] : []), `esc or ${options.key} back to the chat`];
    return [
      truncateToWidth(`${style.heading("Pulses")}${waitingNote()}`, width),
      style.muted("─".repeat(Math.max(1, width))),
      ...visible.map((line) => truncateToWidth(line, width)),
      style.muted(truncateToWidth(`${where}  —  ${keys.join(" · ")}`, width)),
    ];
  };

  const renderMap = (width: number, rows: number): string[] => {
    pages = options.map!();
    const now = Date.now();
    if (pages.length === 0) {
      lastBodyHeight = rows - 3;
      drawnMap = { rows: [], rowStarts: [], lineCount: 0 };
      const body = [style.muted("  No .plain file to map: name one to regrow, or set module: in config.yaml."), ...new Array<string>(Math.max(0, rows - 4)).fill("")];
      return [truncateToWidth(`${style.heading("Regeneration")}${waitingNote()}`, width), style.muted("─".repeat(Math.max(1, width))), ...body, style.muted(truncateToWidth(`p pulses · esc or ${options.key} back to the chat`, width))];
    }
    const bodyHeight = Math.max(3, rows - 3);
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
    // The top line is the module the cursor is in.
    const page = drawn.rows[map.cursor]?.page ?? focusOf(pages)!;
    const where = drawn.lines.length > bodyHeight ? `${map.top + 1}-${Math.min(drawn.lines.length, map.top + bodyHeight)} of ${drawn.lines.length}` : "all shown";
    const keys = ["↑↓ move", "enter open/close", "←→", "o/c all", "pgup pgdn", "p pulses", `esc or ${options.key} back to the chat`];
    return [specMapHeader(page, width, style, waitingNote()), style.muted("─".repeat(Math.max(1, width))), ...body, style.muted(truncateToWidth(`${where}  —  ${keys.join(" · ")}`, width))];
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
      if (target.kind === "module") map.modules.set(target.key.replace(/^module\n/, ""), to);
      else if (target.kind === "import") map.imports.set(target.key.replace(/^import\n/, ""), to);
      else if (to) map.open.add(target.key);
      else map.open.delete(target.key);
    };
    if (matchesKey(data, Key.up)) move(map.cursor - 1);
    else if (matchesKey(data, Key.down)) move(map.cursor + 1);
    else if (matchesKey(data, Key.enter) || data === " ") toggle(row);
    else if (matchesKey(data, Key.right)) toggle(row, true);
    else if (matchesKey(data, Key.left)) {
      // Open, it closes; closed, the cursor goes up to the module it is in.
      if (row !== undefined && isOpen(row)) toggle(row, false);
      else if (row !== undefined && row.kind !== "module") move(rows.findLastIndex((other, index) => index < map.cursor && other.kind === "module"));
    } else if (data === "o" || data === "c") for (const entry of rows) toggle(entry, data === "o");
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
        const lines = (error instanceof Error ? (error.stack ?? error.message) : String(error)).split("\n").slice(0, rows - 4);
        return [
          truncateToWidth(`${style.heading(map.view === "map" ? "Regeneration" : "Pulses")}${waitingNote()}`, width),
          style.muted("─".repeat(Math.max(1, width))),
          ...lines.map((line, index) => truncateToWidth(index === 0 ? style.error(`could not be drawn: ${line}`) : style.muted(line), width)),
          ...new Array<string>(Math.max(0, rows - 3 - lines.length)).fill(""),
          style.muted(truncateToWidth(`${options.map !== undefined ? "p the other view · " : ""}esc or ${options.key} back to the chat`, width)),
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
