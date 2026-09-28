import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { describeUsage } from "./activity.ts";
import { describeTryIt } from "./delivery.ts";
import { jobPanelLines } from "./job-panel.ts";
import { formatDuration, type Job } from "./jobs.ts";
import { agentsOf, diffLines, roleOf, transcriptLines, type TranscriptStyle } from "./transcript-view.ts";

/**
 * The side panel: what the jobs are doing, beside the conversation rather than instead of it.
 *
 * Three views. Jobs: the whole queue - what runs, what waits and on what, what finished. Try it:
 * how to try what a job built, as the harness checked it. Trace: a job's agents at work - every
 * prompt, reply, thought and tool call, each agent's turn headed by who it is - all of them, or one
 * agent at a time. It scrolls on its own, by keys and by the wheel, and follows the newest line while
 * at the bottom.
 */

export type PanelView = "jobs" | "tryit" | "trace";

const VIEWS: Array<{ view: PanelView; title: string }> = [
  { view: "jobs", title: "Jobs" },
  { view: "tryit", title: "Try it" },
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
}

/** A job as a conformance job names the render it follows: what it was, and its id. */
function followed(jobs: Job[], id: string): string {
  const render = jobs.find((job) => job.id === id);
  return render !== undefined ? `${render.summary} (job ${id}, ${render.status})` : `job ${id}`;
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

/**
 * The Try it view: how to try what each job built, as the harness checked it - every job that has
 * steps, newest first, each under what it built. A render or a spec change works them out once its
 * tests pass; conformance jobs never do.
 */
export function tryItLines(jobs: Job[], width: number, style: TranscriptStyle): string[] {
  const withSteps = newestFirst(jobs).filter((job) => job.tryIt !== undefined);
  const lines = withSteps.flatMap((job, index) => [
    ...(index > 0 ? [""] : []),
    style.heading(`── ${job.summary}  (job ${job.id})`),
    ...describeTryIt(job.tryIt!.tryIt, job.tryIt!.buildDir)
      .slice(2)
      .flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, Math.max(10, width)))),
  ]);
  const coming = newestFirst(jobs).filter((job) => job.tryIt === undefined && (job.status === "running" || job.status === "queued") && /render|regenerate/.test(job.kind) && !/conformance/.test(job.kind));
  const pending = coming.map((job) => style.muted(`  ${job.summary} - ${job.status === "queued" ? "not started yet" : `still at: ${job.stage ?? "starting"}`}; its steps come once its tests pass`));
  if (lines.length === 0 && pending.length === 0) {
    return [style.muted("(no try-it steps yet: a render or a spec change works them out once its tests pass)")];
  }
  return [...lines, ...(pending.length > 0 ? [...(lines.length > 0 ? [""] : []), style.muted("── still to come"), ...pending] : [])];
}

export function createSidePanel(options: SidePanelOptions) {
  const style = options.style;
  let view: PanelView = options.jobId !== undefined ? "trace" : "jobs";
  let jobId = options.jobId;
  /** The agent the trace follows, or every agent. */
  let agent: string | undefined;
  /** Lines scrolled up from the bottom, per view. Zero: following. */
  const fromBottom: Record<PanelView, number> = { jobs: 0, tryit: 0, trace: 0 };
  let lastBodyHeight = 10;

  const current = () => pick(options.jobs(), jobId);

  const body = (width: number): string[] => {
    const job = current();
    if (view === "jobs") {
      const jobs = options.jobs();
      if (jobs.length === 0) return [style.muted("(no jobs yet)")];
      const live = jobPanelLines(jobs, { expanded: true, diffStyle: style });
      const finished = newestFirst(jobs)
        .filter((item) => item.status !== "running" && item.status !== "queued")
        .flatMap((item) => [
          `  ${item.status.padEnd(9)} ${item.summary} · ${formatDuration(item)}${describeUsage(item.usage) ? ` · ${describeUsage(item.usage)}` : ""}  (job ${item.id})`,
          // The render it is the conformance of, for a conformance job.
          ...(item.follows !== undefined ? [style.muted(`            the conformance of ${followed(jobs, item.follows)}`)] : []),
          // What it was about, whole: the spec change it rendered, or the functional spec it built.
          ...(item.diff !== undefined
            ? diffLines(item.diff, Math.max(10, width - 12), style).map((line) => `            ${line}`)
            : item.building !== undefined
              ? [
                  style.muted(`            ${item.building.label}:`),
                  ...item.building.text
                    .trimEnd()
                    .split("\n")
                    .flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, Math.max(10, width - 14))))
                    .map((line) => style.accent(`              ${line}`)),
                ]
              : []),
          "",
        ]);
      return [...live, ...(finished.length > 0 ? ["", style.heading("── finished"), ...finished] : [])];
    }
    if (view === "tryit") return tryItLines(options.jobs(), width, style);
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
        view === "jobs" || view === "tryit"
          ? ""
          : job === undefined
            ? ""
            : `${job.summary} · ${job.status} · ${formatDuration(job)}${view === "trace" ? ` · ${agent !== undefined ? roleOf(agent) : "every agent"}` : ""}`;

      const lines = body(width);
      const maxScroll = Math.max(0, lines.length - bodyHeight);
      fromBottom[view] = Math.min(fromBottom[view], maxScroll);
      const end = lines.length - fromBottom[view];
      const visible = lines.slice(Math.max(0, end - bodyHeight), end);
      while (visible.length < bodyHeight) visible.push("");

      const where = fromBottom[view] === 0 ? "following" : `${fromBottom[view]} lines up`;
      const keys = ["tab view", ...(view === "trace" ? ["a agent", "j job"] : []), "↑↓ pgup pgdn scroll", "esc chat", `${options.key} close`];
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
      else if (data === "a" && view === "trace") {
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
        fromBottom.tryit = 0;
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
      scroll(-event.wheelDelta * 3);
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
