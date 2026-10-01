import { Key, matchesKey, truncateToWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { formatDuration, type Job } from "./jobs.ts";
import { createJobsTreeState, jobsTreeLines, keepCursorInView, scrollTree, treeKey, type JobsTreeState, type TreeRow } from "./jobs-tree.ts";
import { agentsOf, roleOf, transcriptLines, type TranscriptStyle } from "./transcript-view.ts";

/**
 * The side panel: what the jobs are doing, beside the conversation rather than instead of it.
 *
 * Two views. Jobs: the whole queue as a tree - running, queued, finished, each opened and closed on its
 * own, a line per job and all of what it builds once opened (see jobs-tree.ts). Trace: a job's agents at
 * work - every prompt, reply, thought and tool call, each agent's turn headed by who it is - all of them,
 * or one agent at a time; it follows the newest line while at the bottom. Both scroll by keys and by the
 * wheel.
 */

export type PanelView = "jobs" | "trace";

const VIEWS: Array<{ view: PanelView; title: string }> = [
  { view: "jobs", title: "Jobs" },
  { view: "trace", title: "Trace" },
];

export interface SidePanelOptions {
  /** Every job, oldest first. */
  jobs: () => Job[];
  /** The job to show first, when opened for one. */
  jobId?: string;
  /** Rows the panel may use. */
  rows: () => number;
  style: TranscriptStyle;
  /** Back to the conversation, the panel staying open. */
  back: () => void;
  /** Close the panel. */
  close: () => void;
  /** The key that opens and closes it, shown in the footer. */
  key: string;
  /** The Jobs view's tree - what is open, where the cursor is - kept across openings of the panel. */
  tree?: JobsTreeState;
}

/** Newest first, whatever order they come in. */
function newestFirst(jobs: Job[]): Job[] {
  return [...jobs].sort((a, b) => b.sequence - a.sequence);
}

/** The job a view is about: the one chosen, else the running one, else the newest. */
function pick(jobs: Job[], id: string | undefined): Job | undefined {
  const ordered = newestFirst(jobs);
  return ordered.find((job) => job.id === id) ?? ordered.find((job) => job.status === "running") ?? ordered[0];
}

export function createSidePanel(options: SidePanelOptions) {
  const style = options.style;
  let view: PanelView = options.jobId !== undefined ? "trace" : "jobs";
  let jobId = options.jobId;
  /** The agent the trace follows, or every agent. */
  let agent: string | undefined;
  /** Lines scrolled up from the bottom, per view. Zero: following. */
  const fromBottom: Record<PanelView, number> = { jobs: 0, trace: 0 };
  let lastBodyHeight = 10;

  const current = () => pick(options.jobs(), jobId);

  /** The Jobs view's tree: kept by the conversation, so it is as it was left when the panel opens again. */
  const tree = options.tree ?? createJobsTreeState();
  /** The Jobs view as last drawn: its rows, and where each starts - what the keys move over. */
  let drawn: { rows: TreeRow[]; rowStarts: number[]; lineCount: number } = { rows: [], rowStarts: [], lineCount: 0 };

  const body = (width: number): string[] => {
    const job = current();
    if (job === undefined) return [style.muted("(no job yet)")];
    return transcriptLines(job, width, style, agent);
  };

  const scroll = (lines: number) => {
    fromBottom[view] = Math.max(0, fromBottom[view] + lines);
  };

  return {
    render(width: number): string[] {
      const rows = Math.max(8, options.rows());
      const bodyHeight = rows - 4;
      lastBodyHeight = bodyHeight;
      const job = current();

      const tabs = VIEWS.map(({ view: item, title }) => (item === view ? style.heading(`[${title}]`) : style.muted(` ${title} `))).join(" ");
      const about =
        view === "jobs"
          ? ""
          : job === undefined
            ? ""
            : `${job.summary} · ${job.status} · ${formatDuration(job)}${view === "trace" ? ` · ${agent !== undefined ? roleOf(agent) : "every agent"}` : ""}`;

      let visible: string[];
      let where: string;
      if (view === "jobs") {
        // The tree scrolls to keep the cursor in sight, and only that far.
        const tree_ = jobsTreeLines(options.jobs(), tree, width, style);
        drawn = { rows: tree_.rows, rowStarts: tree_.rowStarts, lineCount: tree_.lines.length };
        keepCursorInView(tree, tree_.rowStarts, tree_.lines.length, bodyHeight);
        visible = tree_.lines.slice(tree.top, tree.top + bodyHeight);
        where = tree_.lines.length > bodyHeight ? `${tree.top + 1}-${Math.min(tree_.lines.length, tree.top + bodyHeight)} of ${tree_.lines.length}` : "all shown";
      } else {
        const lines = body(width);
        const maxScroll = Math.max(0, lines.length - bodyHeight);
        fromBottom[view] = Math.min(fromBottom[view], maxScroll);
        const end = lines.length - fromBottom[view];
        visible = lines.slice(Math.max(0, end - bodyHeight), end);
        where = fromBottom[view] === 0 ? "following" : `${fromBottom[view]} lines up`;
      }
      while (visible.length < bodyHeight) visible.push("");

      const keys =
        view === "jobs"
          ? ["↑↓ move", "enter open/close", "←→", "o/c all", "t trace", "pgup pgdn scroll", "tab view", "esc chat", `${options.key} close`]
          : ["tab view", "a agent", "j job", "↑↓ pgup pgdn scroll", "esc chat", `${options.key} close`];
      return [
        truncateToWidth(tabs, width),
        style.muted(truncateToWidth(about, width)),
        style.muted("─".repeat(Math.max(1, width))),
        ...visible.map((line) => truncateToWidth(line, width)),
        style.muted(truncateToWidth(`${where}  —  ${keys.join(" · ")}`, width)),
      ];
    },

    handleInput(data: string): void {
      const page = Math.max(1, lastBodyHeight - 1);
      if (matchesKey(data, Key.escape)) options.back();
      else if (matchesKey(data, Key.tab)) view = VIEWS[(VIEWS.findIndex((item) => item.view === view) + 1) % VIEWS.length]!.view;
      else if (matchesKey(data, Key.shift("tab"))) view = VIEWS[(VIEWS.findIndex((item) => item.view === view) + VIEWS.length - 1) % VIEWS.length]!.view;
      else if (view === "jobs") {
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
                      : data === "t"
                        ? "trace"
                        : undefined;
        if (key !== undefined) {
          const action = treeKey(tree, drawn.rows, key);
          if (action.kind === "trace") {
            jobId = action.jobId;
            agent = undefined;
            fromBottom.trace = 0;
            view = "trace";
          }
        } else if (matchesKey(data, Key.pageUp)) scrollTree(tree, -page, drawn.rowStarts, drawn.lineCount, lastBodyHeight);
        else if (matchesKey(data, Key.pageDown)) scrollTree(tree, page, drawn.rowStarts, drawn.lineCount, lastBodyHeight);
        else if (matchesKey(data, Key.home) || data === "g") tree.cursor = 0;
        else if (matchesKey(data, Key.end) || data === "G") tree.cursor = Math.max(0, drawn.rows.length - 1);
      } else if (data === "a" && view === "trace") {
        // Every agent, then each in the order they first spoke, then every agent again.
        const job = current();
        const agents = job !== undefined ? agentsOf(job) : [];
        const at = agent === undefined ? -1 : agents.indexOf(agent);
        agent = at + 1 < agents.length ? agents[at + 1] : undefined;
        fromBottom.trace = 0;
      } else if (data === "j" && view === "trace") {
        const jobs = newestFirst(options.jobs());
        const at = jobs.findIndex((item) => item.id === current()?.id);
        jobId = jobs[(at + 1) % Math.max(1, jobs.length)]?.id;
        agent = undefined;
        fromBottom.trace = 0;
      } else if (matchesKey(data, Key.up)) scroll(1);
      else if (matchesKey(data, Key.down)) scroll(-1);
      else if (matchesKey(data, Key.pageUp)) scroll(page);
      else if (matchesKey(data, Key.pageDown)) scroll(-page);
      else if (matchesKey(data, Key.home) || data === "g") fromBottom[view] = Number.MAX_SAFE_INTEGER;
      else if (matchesKey(data, Key.end) || data === "G") fromBottom[view] = 0;
    },

    /** The wheel scrolls the panel wherever the keyboard is. */
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
      if (event.type !== "wheel" || event.wheelDelta === undefined) return undefined;
      if (view === "jobs") scrollTree(tree, event.wheelDelta * 3, drawn.rowStarts, drawn.lineCount, lastBodyHeight);
      else scroll(-event.wheelDelta * 3);
      return { handled: true };
    },

    /** Show this job, in this view. */
    show(next: { jobId?: string; view?: PanelView }): void {
      if (next.jobId !== undefined) {
        jobId = next.jobId;
        agent = undefined;
      }
      if (next.view !== undefined) view = next.view;
    },

    invalidate(): void {},
  };
}
