import { diffView, PLAIN_PAINT, type DiffPaint } from "./diff-view.ts";
import { plainPaint } from "./plain-palette.ts";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatDuration, formatElapsed, type Job } from "./jobs.ts";

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

export const JOB_PANEL_KEY = "turri-jobs";

/**
 * The key that opens the side panel on its jobs, and goes back to it. Not ctrl+j: a terminal without the Kitty keyboard
 * protocol sends ctrl+j as a line feed - what it sends for shift+enter too, and what a dialog reads as enter - so it
 * would answer a question, and take a new line from the editor. ctrl+h is the byte old terminals sent for backspace;
 * every terminal now sends backspace as DEL, which pi never takes for ctrl+h, so it is free - in pi, and in a dialog.
 */
export const PANEL_KEY = "ctrl+h";

/** How the side panel is found your way around, as the job panel says it. */
export const PANEL_HELP =
  `in the side panel: ↑↓ move over the pulses · enter opens one - what it builds, whole · o/c open or close them all · esc back to the chat · ${PANEL_KEY} closes it`;
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

export function spinner(now: number): string {
  return SPINNER[Math.floor(now / 1000) % SPINNER.length]!;
}

/** What a pulse is listed as: its module - and that it writes the conformance tests, when it does - or what was asked for. */
export function pulseName(job: Job): string {
  if (job.module === undefined) return job.summary;
  return job.kind === "bind" ? `${job.module} conformance` : job.module;
}

/** What a pulse cost, as its line says it: " · $0.12", or nothing when the price is not known. */
export function pulseCost(job: Job): string {
  return job.usage.cost > 0 ? ` · $${job.usage.cost.toFixed(2)}` : "";
}

/**
 * Jobs whose tool draws its own progress widget, which already shows the functional spec being
 * built: the panel leaves it out, so it is not written twice.
 */
const SPEC_SHOWN_BY_WIDGET = new Set(["regrow"]);

/** Spec lines shown per running job while expanded. */
const EXPANDED_SPEC_LINES = 30;

/** Diff lines shown per running job while expanded. */
const EXPANDED_DIFF_LINES = 20;

/**
 * One line saying what a spec change does: the files, the lines added and removed, and the
 * first line it adds - usually the concept or the functional spec it is about.
 */
/** How a diff is coloured: added lines green, removed lines red. Plain when there is no theme. */
export interface DiffStyle {
  added(text: string): string;
  removed(text: string): string;
}

const PLAIN_DIFF: DiffStyle = { added: (text) => text, removed: (text) => text };

export function summarizeDiff(diff: string, style: DiffStyle = PLAIN_DIFF): string {
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  let first: string | undefined;
  let firstRemoved: string | undefined;
  for (const line of diff.split("\n")) {
    const file = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (file) {
      if (file[1] !== "/dev/null") files.add(file[1]!.split("/").pop()!);
      continue;
    }
    if (line.startsWith("---") || line.startsWith("diff --git") || line.startsWith("index ")) continue;
    if (line.startsWith("+")) {
      added += 1;
      const text = line.slice(1).replace(/^- /, "").trim();
      if (first === undefined && text !== "" && !/^\*\*\*.*\*\*\*$/.test(text)) first = text;
    } else if (line.startsWith("-")) {
      removed += 1;
      const text = line.slice(1).replace(/^- /, "").trim();
      if (firstRemoved === undefined && text !== "" && !/^\*\*\*.*\*\*\*$/.test(text)) firstRemoved = text;
    }
  }
  // What it adds, when it adds anything; what it takes out, when that is all it does.
  const what = first !== undefined ? ` · ${first}` : firstRemoved !== undefined ? ` · removes: ${firstRemoved}` : "";
  return `${[...files].join(", ")} ${style.added(`+${added}`)} ${style.removed(`−${removed}`)}${what}`;
}

/** The lines of a diff worth reading in a panel: the hunks, not the headers. */
/**
 * A line of the panel wrapped to its width, its continuations under its text: indented as far as it is,
 * and past the rule of a diff box when it is in one.
 */
export function wrapKeepingIndent(line: string, width: number): string[] {
  if (visibleWidth(line) <= width) return [line];
  const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
  const indent = /^(\s*(?:│ )?)/.exec(plain)?.[1] ?? "";
  // Inside a diff box its rule goes on down the continuations; elsewhere, blanks.
  const lead = indent;
  const inner = Math.max(10, width - indent.length);
  const [first = "", ...rest] = wrapTextWithAnsi(line, width);
  return [first, ...rest.flatMap((part) => wrapTextWithAnsi(part, inner)).map((part) => `${lead}${part}`)];
}

/** A diff's colours for the +/- alone, when there is nothing to highlight with. */
const paintOf = (style: DiffStyle): DiffPaint => ({ ...PLAIN_PAINT, added: style.added, removed: style.removed });

export interface PanelOptions {
  /** Everything, rather than the compact view. */
  expanded?: boolean;
  now?: number;
  /** Colours for the diffs of render spec diff jobs. */
  diffStyle?: DiffStyle;
  /** How the expanded diff is painted - ***plain highlighted, added and removed lines banded - and how wide. */
  diffPaint?: DiffPaint;
  width?: number;
  /** The lines of help about ctrl+o and the side panel - left out where they do not apply, as in the side panel itself. */
  hints?: boolean;
}

export function jobPanelLines(jobs: Job[], options: PanelOptions = {}): string[] {
  const now = options.now ?? Date.now();
  const expanded = options.expanded === true;
  const diffStyle = options.diffStyle ?? PLAIN_DIFF;
  const inOrder = [...jobs].sort((a, b) => a.sequence - b.sequence);
  const running = inOrder.filter((job) => job.status === "running");
  const queued = inOrder.filter((job) => job.status === "queued");
  if (running.length === 0 && queued.length === 0) return [];

  const lines: string[] = [];
  let hidden = false;

  for (const job of running) {
    if (lines.length > 0) lines.push("");
    // Its module, how long and what it has cost: what it is doing follows.
    lines.push(`${spinner(now)} ${pulseName(job)} · ${formatDuration(job)}${pulseCost(job)}`);
    if (job.diff !== undefined) {
      lines.push(`    ${summarizeDiff(job.diff, diffStyle)}`);
      if (expanded) {
        const body = diffView(job.diff, Math.max(10, (options.width ?? 100) - 8), options.diffPaint ?? paintOf(diffStyle), job.diffWhere);
        for (const line of body.slice(0, EXPANDED_DIFF_LINES)) lines.push(`      │ ${line}`);
        if (body.length > EXPANDED_DIFF_LINES) lines.push(`      │ … ${body.length - EXPANDED_DIFF_LINES} more lines - ${PANEL_KEY} shows it all`);
      }
    }
    // What it is on now, and for how long - beside the job's own time, which is the whole of it.
    const onIt = job.building?.since !== undefined ? ` · ${formatElapsed(now - job.building.since)}` : "";
    if (job.building !== undefined && SPEC_SHOWN_BY_WIDGET.has(job.kind)) {
      // The module widget shows its text; the panel, how long it has taken so far.
      lines.push(`    ${job.building.label}${onIt}`);
    } else if (job.building !== undefined) {
      const text = job.building.text.split("\n").filter((line) => line.trim() !== "");
      if (!expanded) {
        const more = text.length > 1 ? `  (+${text.length - 1} line${text.length === 2 ? "" : "s"} · ctrl+o)` : "";
        lines.push(`    ${job.building.label}${onIt}: ${(text[0] ?? "").trim()}${more}`);
        if (text.length > 1) hidden = true;
      } else {
        lines.push(`    ${job.building.label}${onIt}:`);
        for (const line of text.slice(0, EXPANDED_SPEC_LINES)) lines.push(`      │ ${line}`);
        if (text.length > EXPANDED_SPEC_LINES) lines.push(`      │ … ${text.length - EXPANDED_SPEC_LINES} more lines - ${PANEL_KEY} shows it all`);
      }
    }
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
        lines.push(`  queued  ${pulseName(job)}`);
        if (job.diff !== undefined) lines.push(`          ${summarizeDiff(job.diff, diffStyle)}`);
        if (job.note !== undefined) lines.push(`          ${job.note}`);
      }
    } else {
      // Counted, then named in order - so however narrow the line gets, the number is there.
      lines.push(`  queued (${queued.length}): ${queued.map(pulseName).join(" → ")}`);
      hidden = true;
    }
  }

  // Always a line of help: how to see more here, and how to inspect the jobs in the side panel.
  if (options.hints === false) {
    // The side panel shows it all already, and says its own keys.
  } else if (expanded) {
    lines.push(`  ctrl+o collapse · ${PANEL_KEY} to see what each pulse builds`);
    lines.push(`  ${PANEL_HELP}`);
  } else {
    lines.push(`  ctrl+o ${hidden ? "for the full queue and activity" : "expand"} · ${PANEL_KEY} to see what each pulse builds`);
  }
  return lines;
}

interface Redrawable {
  requestRender(): void;
}

/** What of pi's theme the panel paints with: the diff's colours and bands, and ***plain's colours in it. */
interface PanelTheme {
  fg(color: "toolDiffAdded" | "toolDiffRemoved", text: string): string;
  /** Whether it is made for a dark or a light surface, and how many colours the terminal has: the diff's palette. */
  appearance?: "dark" | "light";
  getColorMode?(): string;
}

/** The parts of pi's TUI the panel needs: enough to draw, redraw, and ask about ctrl+o. */
export interface PanelUI {
  setWidget(
    key: string,
    content:
      | ((tui: Redrawable, theme: PanelTheme) => {
          render(width: number): string[];
          invalidate(): void;
        })
      | undefined,
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
          (next, theme) => {
            tui = next;
            const diffStyle: DiffStyle = {
              added: (text) => theme.fg("toolDiffAdded", text),
              removed: (text) => theme.fg("toolDiffRemoved", text),
            };
            const diffPaint: DiffPaint = plainPaint(theme);
            return {
              // Laid out on every render, so ctrl+o takes effect on the very next frame.
              render: (width) => {
                const expanded = target.getToolsExpanded();
                const lines = jobPanelLines(list(), { expanded, diffStyle, diffPaint, width });
                // Opened, nothing is cut off: every line wraps. Closed, a line each - the panel stays short.
                return expanded ? lines.flatMap((line) => wrapKeepingIndent(line, width)) : lines.map((line) => truncateToWidth(line, width));
              },
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
