import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatDuration, type Job } from "./jobs.ts";

/**
 * The live panel above the editor while background work runs.
 *
 * One block per running job: what it is and how long it has been going, the stage it is
 * at, what is happening this second, and the last things its agents did. Queued jobs follow.
 * It disappears when nothing is running or waiting - the finished job announces itself in
 * the transcript instead.
 *
 * It is drawn as a component rather than handed over as lines, because pi cuts a list of
 * lines off at ten, and a panel that silently drops the end of the queue is worse than
 * none. Instead it sizes itself: compact by default, so the whole queue is always
 * accounted for even when it is only counted, and in full while tool output is expanded -
 * pi's own ctrl+o, which the person already uses to see more of what the agent did.
 */

export const JOB_PANEL_KEY = "plainwright-jobs";
const TICK_MS = 1000;
/** Tool-call progress arrives many times a second; the screen does not need to. */
const REDRAW_MS = 100;
/** Activity lines per running job while compact. */
const COMPACT_ACTIVITY = 2;

/**
 * A spinner rather than a disclosure arrow: a `▸` promises something opens when you pick
 * it. The frame follows the clock, so it moves on every redraw, including the tick.
 */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function spinner(now: number): string {
  return SPINNER[Math.floor(now / 1000) % SPINNER.length]!;
}

export interface PanelOptions {
  /** Everything, rather than the compact view. */
  expanded?: boolean;
  now?: number;
}

export function jobPanelLines(jobs: Job[], options: PanelOptions = {}): string[] {
  const now = options.now ?? Date.now();
  const expanded = options.expanded === true;
  const inOrder = [...jobs].sort((a, b) => a.sequence - b.sequence);
  const running = inOrder.filter((job) => job.status === "running");
  const queued = inOrder.filter((job) => job.status === "queued");
  if (running.length === 0 && queued.length === 0) return [];

  const lines: string[] = [];
  let hidden = false;

  for (const job of running) {
    if (lines.length > 0) lines.push("");
    lines.push(`${spinner(now)} ${job.summary} · ${formatDuration(job)}  (job ${job.id})`);
    lines.push(`    ${job.stage ?? "starting"}`);
    const activity = expanded ? job.activity : job.activity.slice(-COMPACT_ACTIVITY);
    if (activity.length < job.activity.length) hidden = true;
    for (const line of activity) lines.push(`      ${line}`);
    if (job.now !== undefined) {
      const seconds = Math.max(0, Math.round((now - job.now.since) / 1000));
      lines.push(`      … ${job.now.label} · ${seconds}s`);
    }
  }

  if (queued.length > 0) {
    if (lines.length > 0) lines.push("");
    if (expanded || queued.length === 1) {
      for (const job of queued) {
        lines.push(`  queued  ${job.summary}  (job ${job.id}, after ${job.waitingOn.join(", ")})`);
      }
    } else {
      // Counted, then named in order - so however narrow the line gets, the number is there.
      lines.push(`  queued (${queued.length}): ${queued.map((job) => job.summary).join(" → ")}`);
      hidden = true;
    }
  }

  if (expanded) lines.push("  ctrl+o to collapse · /jobs lists everything");
  else if (hidden) lines.push("  ctrl+o for the full queue and activity · /jobs lists everything");
  return lines;
}

interface Redrawable {
  requestRender(): void;
}

/** The parts of pi's TUI the panel needs: enough to draw, redraw, and ask about ctrl+o. */
export interface PanelUI {
  setWidget(
    key: string,
    content: ((tui: Redrawable, theme: never) => { render(width: number): string[]; invalidate(): void }) | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  getToolsExpanded(): boolean;
}

export interface JobPanel {
  /** Where to draw. Until this is set there is no UI, and the panel does nothing. */
  attach(ui: PanelUI): void;
  /** Redraw soon, e.g. because a job changed. */
  refresh(): void;
}

export function createJobPanel(list: () => Job[]): JobPanel {
  let ui: PanelUI | undefined;
  let tui: Redrawable | undefined;
  let mounted = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;

  const active = () => list().some((job) => job.status === "running" || job.status === "queued");

  const draw = () => {
    if (ui === undefined) return;
    const target = ui;
    try {
      if (active() && !mounted) {
        mounted = true;
        target.setWidget(
          JOB_PANEL_KEY,
          (next) => {
            tui = next;
            return {
              // Laid out on every render, so ctrl+o takes effect on the very next frame.
              render: (width) =>
                jobPanelLines(list(), { expanded: target.getToolsExpanded() }).map((line) =>
                  truncateToWidth(line, width),
                ),
              invalidate() {},
            };
          },
          { placement: "aboveEditor" },
        );
      } else if (!active() && mounted) {
        mounted = false;
        tui = undefined;
        target.setWidget(JOB_PANEL_KEY, undefined);
      } else {
        tui?.requestRender();
      }
    } catch {
      // The panel is a convenience; losing it must not fail the work it shows.
    }

    // The elapsed time moves even when the agents are quiet - a long model call is exactly
    // when someone looks to see whether anything is happening.
    if (mounted && timer === undefined) {
      timer = setInterval(draw, TICK_MS);
      timer.unref?.();
    } else if (!mounted && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  return {
    attach(next) {
      // A new session starts with pi's widgets cleared, so whatever was mounted is gone.
      ui = next;
      mounted = false;
      tui = undefined;
      draw();
    },
    refresh() {
      if (pending !== undefined) return;
      pending = setTimeout(() => {
        pending = undefined;
        draw();
      }, REDRAW_MS);
      pending.unref?.();
    },
  };
}
