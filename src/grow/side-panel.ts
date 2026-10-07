import { Key, matchesKey, truncateToWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Job } from "./jobs.ts";
import { createJobsTreeState, jobsTreeLines, keepCursorInView, scrollTree, treeKey, type JobsTreeState, type TreeRow } from "./jobs-tree.ts";
import type { TranscriptStyle } from "./transcript-view.ts";

/**
 * The side panel: what the jobs are doing, beside the conversation rather than instead of it.
 *
 * The whole queue as a tree - running, queued, finished, each opened and closed on its own, a line per job and all of
 * what it builds once opened (see jobs-tree.ts) - scrolled by keys and by the wheel. What the agents said and did is
 * not shown here: it is in each pulse's log (job-log.ts).
 */

export interface SidePanelOptions {
  /** Every job, oldest first. */
  jobs: () => Job[];
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
  /** The Jobs view's tree - what is open, where the cursor is - kept across openings of the panel. */
  tree?: JobsTreeState;
}

export function createSidePanel(options: SidePanelOptions) {
  const style = options.style;
  let lastBodyHeight = 10;

  /** The tree: kept by the conversation, so it is as it was left when the panel opens again. */
  const tree = options.tree ?? createJobsTreeState();
  /** The tree as last drawn: its rows, and where each starts - what the keys move over. */
  let drawn: { rows: TreeRow[]; rowStarts: number[]; lineCount: number } = { rows: [], rowStarts: [], lineCount: 0 };

  return {
    render(width: number): string[] {
      const rows = Math.max(8, options.rows());
      const bodyHeight = rows - 3;
      lastBodyHeight = bodyHeight;

      // The tree scrolls to keep the cursor in sight, and only that far.
      const tree_ = jobsTreeLines(options.jobs(), tree, width, style);
      drawn = { rows: tree_.rows, rowStarts: tree_.rowStarts, lineCount: tree_.lines.length };
      keepCursorInView(tree, tree_.rowStarts, tree_.lines.length, bodyHeight);
      const visible = tree_.lines.slice(tree.top, tree.top + bodyHeight);
      const where = tree_.lines.length > bodyHeight ? `${tree.top + 1}-${Math.min(tree_.lines.length, tree.top + bodyHeight)} of ${tree_.lines.length}` : "all shown";
      while (visible.length < bodyHeight) visible.push("");

      const keys = ["↑↓ move", "enter open/close", "←→", "o/c all", "pgup pgdn scroll", `esc or ${options.key} back to the chat`];
      // A question asked while it showed waits in the chat, unanswered: the person is told it is there.
      const waiting = options.waiting?.() === true ? `   ${style.warning?.("the chat is waiting for your answer") ?? style.accent("the chat is waiting for your answer")} - ${options.key} to go back` : "";
      return [
        truncateToWidth(`${style.heading("Regeneration")}${waiting}`, width),
        style.muted("─".repeat(Math.max(1, width))),
        ...visible.map((line) => truncateToWidth(line, width)),
        style.muted(truncateToWidth(`${where}  —  ${keys.join(" · ")}`, width)),
      ];
    },

    handleInput(data: string): void {
      const page = Math.max(1, lastBodyHeight - 1);
      if (matchesKey(data, Key.escape)) {
        options.back();
        return;
      }
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
      if (key !== undefined) treeKey(tree, drawn.rows, key);
      else if (matchesKey(data, Key.pageUp)) scrollTree(tree, -page, drawn.rowStarts, drawn.lineCount, lastBodyHeight);
      else if (matchesKey(data, Key.pageDown)) scrollTree(tree, page, drawn.rowStarts, drawn.lineCount, lastBodyHeight);
      else if (matchesKey(data, Key.home) || data === "g") tree.cursor = 0;
      else if (matchesKey(data, Key.end) || data === "G") tree.cursor = Math.max(0, drawn.rows.length - 1);
    },

    /** The wheel scrolls the panel wherever the keyboard is. */
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
      if (event.type !== "wheel" || event.wheelDelta === undefined) return undefined;
      scrollTree(tree, event.wheelDelta * 3, drawn.rowStarts, drawn.lineCount, lastBodyHeight);
      return { handled: true };
    },

    invalidate(): void {},
  };
}
