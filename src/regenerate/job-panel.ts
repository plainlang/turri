import { type Color, foregroundAnsi, mixColors, type TerminalColorMode, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatDuration, formatElapsed, pulseName, type Job } from "./jobs.ts";

/**
 * The live panel above the editor while background work runs.
 *
 * One block per running job: what it is and how long it has been going, the stage it is
 * at, what is happening this second, and the last things its agents did. What waits is not
 * in it - the side panel lists the queue. It disappears when nothing is running - the finished
 * job announces itself in the transcript instead.
 *
 * It is drawn as a component rather than handed over as lines, because pi cuts a list of
 * lines off at ten. Instead it sizes itself: compact by default, and the agents' trace in full
 * while tool output is expanded - pi's own ctrl+o, which the person already uses to see more of
 * what the agent did. What finished stays counted either way: the side panel lists it.
 */

export const JOB_PANEL_KEY = "turri-jobs";

/**
 * The key that opens the side panel on its jobs, and goes back to it. Not ctrl+j: a terminal without the Kitty keyboard
 * protocol sends ctrl+j as a line feed - what it sends for shift+enter too, and what a dialog reads as enter - so it
 * would answer a question, and take a new line from the editor. ctrl+h is the byte old terminals sent for backspace;
 * every terminal now sends backspace as DEL, which pi never takes for ctrl+h, so it is free - in pi, and in a dialog.
 */
export const PANEL_KEY = "ctrl+h";

const TICK_MS = 1000;

/**
 * Each key in the line under the panel - ctrl+o, ctrl+h - breathes until it is first pressed: fully there, a little
 * faint, and back, so it reads as something to press, not as text. Once every BREATH_MS, redrawn every BREATH_TICK_MS
 * while the panel shows and a key still breathes, at most BREATH_FADE of the way from the text's colour to the dim one.
 * Pressed once, it stays still for the rest of the process; the other breathes on.
 */
export const BREATH_MS = 2400;
const BREATH_TICK_MS = 100;
const BREATH_FADE = 0.6;

/** The keys of the line, by what they do: pressed once, each stops breathing. */
export type PanelKey = "trace" | "peek";
const pressed = new Set<PanelKey>();

/** A key of the line was pressed - ctrl+o, or the side panel opened: it stops breathing. */
export function keyPressed(key: PanelKey): void {
  pressed.add(key);
}

export function breathes(key: PanelKey): boolean {
  return !pressed.has(key);
}

/** For tests: every key breathing again. */
export function resetKeysForTests(): void {
  pressed.clear();
}

/** How faint a breathing key is at `now`: 0, fully there, at the start of each breath, BREATH_FADE halfway through. */
export function breath(now: number): number {
  const phase = (now % BREATH_MS) / BREATH_MS;
  return BREATH_FADE * (0.5 - 0.5 * Math.cos(2 * Math.PI * phase));
}
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

/** A finished pulse in its module's line: its mark, number and kind - `✓ 3 regenerate`. What it regenerated is in the side panel. */
function finishedItem(job: Job, marks: MarkPaint): string {
  if (job.module === undefined || job.pulse === undefined) return `${finishedMark(job, marks)} ${pulseName(job)}`;
  return `${finishedMark(job, marks)} ${job.pulse} ${job.kind}`;
}

/**
 * What finished, a line a module - its name, then its pulses oldest first - fitted to `width` from the left: the
 * newest that fit, the rest counted as earlier. The side panel lists every one.
 */
export function finishedLines(finished: Job[], width: number | undefined, marks: MarkPaint = PLAIN_MARKS): string[] {
  const byModule = new Map<string, Job[]>();
  for (const job of [...finished].sort((a, b) => a.sequence - b.sequence)) {
    const key = job.module ?? job.kind;
    byModule.set(key, [...(byModule.get(key) ?? []), job]);
  }
  const pad = Math.max(...[...byModule.keys()].map((name) => visibleWidth(name)));
  return [...byModule].map(([name, jobs]) => {
    const head = `  ${name}${" ".repeat(pad - visibleWidth(name))}  `;
    const items = jobs.map((job) => finishedItem(job, marks));
    const lineOf = (from: number) => `${head}${from > 0 ? `… ${from} earlier · ` : ""}${items.slice(from).join(" · ")}`;
    let from = 0;
    while (width !== undefined && from < items.length - 1 && visibleWidth(lineOf(from)) > width) from += 1;
    return lineOf(from);
  });
}

/** A pulse that ran to its end and whose build did not pass - stopped at a gate - is not a success. */
export function didNotPass(job: Job): boolean {
  return job.status === "succeeded" && (job.details as { passed?: unknown } | undefined)?.passed === false;
}

/** How a finished pulse's mark is coloured: green it passed, red it failed or did not pass, amber it was stopped. */
export interface MarkPaint {
  success(text: string): string;
  error(text: string): string;
  warning(text: string): string;
}

const PLAIN_MARKS: MarkPaint = { success: (text) => text, error: (text) => text, warning: (text) => text };

/** A finished pulse's mark, in the colour of how it ended. */
export function finishedMark(job: Job, paint: MarkPaint = PLAIN_MARKS): string {
  if (didNotPass(job) || job.status === "failed") return paint.error("✗");
  if (job.status === "stopped") return paint.warning("■");
  return paint.success("✓");
}

/** What a pulse cost, as its line says it: " · $0.12", or nothing when the price is not known. */
export function pulseCost(job: Job): string {
  return job.usage.cost > 0 ? ` · $${job.usage.cost.toFixed(2)}` : "";
}

/**
 * Jobs whose tool draws its own progress widget, which already shows the functional spec being
 * built: the panel leaves it out, so it is not written twice.
 */
const SPEC_SHOWN_BY_WIDGET = new Set(["regenerate"]);

/** Spec lines shown per running job while expanded. */
const EXPANDED_SPEC_LINES = 30;

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
export interface PanelOptions {
  /** Everything, rather than the compact view. */
  expanded?: boolean;
  now?: number;
  width?: number;
  /** The lines of help about ctrl+o and the side panel - left out where they do not apply, as in the side panel itself. */
  hints?: boolean;
  /** How the finished pulses' marks are coloured. */
  marks?: MarkPaint;
  /** How each key of the line is painted - breathing until it is pressed, in the TUI. */
  keys?: (key: PanelKey, text: string) => string;
}

export function jobPanelLines(jobs: Job[], options: PanelOptions = {}): string[] {
  const now = options.now ?? Date.now();
  const expanded = options.expanded === true;
  const inOrder = [...jobs].sort((a, b) => a.sequence - b.sequence);
  const running = inOrder.filter((job) => job.status === "running");
  // A module whose work is being planned: the planner is an agent, and takes a while - shown at once, as work going on.
  const planning = inOrder.filter((job) => job.status === "queued" && job.planning !== undefined);
  // Nothing running or being planned: no panel - what waits and what finished are in the side panel.
  if (running.length === 0 && planning.length === 0) return [];
  const finished = inOrder.filter((job) => (job.status === "succeeded" || job.status === "failed" || job.status === "stopped") && job.replacedBy === undefined);

  const lines: string[] = [];

  // What finished, on top - a line a module, oldest first - and a rule under it: what runs now is below, by the input.
  if (finished.length > 0) {
    lines.push(...finishedLines(finished, options.width, options.marks ?? PLAIN_MARKS));
    lines.push(`  ${"─".repeat(Math.max(10, (options.width ?? 80) - 4))}`);
  }

  for (const [index, job] of running.entries()) {
    if (index > 0) lines.push("");
    // Its module, how long and what it has cost: what it is doing follows.
    lines.push(`${spinner(now)} ${pulseName(job)} · ${formatDuration(job)}${pulseCost(job)}`);
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
      } else {
        lines.push(`    ${job.building.label}${onIt}:`);
        for (const line of text.slice(0, EXPANDED_SPEC_LINES)) lines.push(`      │ ${line}`);
        if (text.length > EXPANDED_SPEC_LINES) lines.push(`      │ … ${text.length - EXPANDED_SPEC_LINES} more lines - ${PANEL_KEY} shows it all`);
      }
    }
    const activity = expanded ? job.activity : job.activity.slice(-COMPACT_ACTIVITY);
    for (const line of activity) lines.push(`      ${line}`);
    if (job.now !== undefined) {
      const seconds = Math.max(0, Math.round((now - job.now.since) / 1000));
      lines.push(`      … ${job.now.label} · ${seconds}s`);
    }
  }

  for (const job of planning) {
    if (lines.length > 0 && running.length > 0) lines.push("");
    lines.push(`${spinner(now)} ${job.module ?? job.summary} · planning the pulses · ${formatElapsed(now - job.planning!.since)}`);
    lines.push("    the planner is cutting the work into pulses - the first starts once it is done");
  }

  // Always a line of help: how to see more here, and how to inspect the jobs in the side panel.
  if (options.hints === false) {
    // The side panel shows it all already, and says its own keys.
  } else {
    // Set apart from the trace above it.
    lines.push("");
    const key = options.keys ?? ((_key: PanelKey, text: string) => text);
    lines.push(`  ${key("trace", `ctrl+o to ${expanded ? "collapse" : "expand"} the trace`)} · ${key("peek", `${PANEL_KEY} to peek at regen`)}`);
  }
  return lines;
}

interface Redrawable {
  requestRender(): void;
}

/** What of pi's theme the panel paints with: the diff's colours and bands, and ***plain's colours in it. */
interface PanelTheme {
  fg(color: "toolDiffAdded" | "toolDiffRemoved" | "success" | "error" | "warning", text: string): string;
  /** Whether it is made for a dark or a light surface, and how many colours the terminal has: the diff's palette. */
  appearance?: "dark" | "light";
  getColorMode?(): string;
  /** Each token's concrete colour - what the line of keys breathes between. */
  colors?: Readonly<Record<string, Color>>;
}

/**
 * The keys of the line, painted at `now`'s breath: one not pressed yet in the text's colour mixed toward the dim one, one
 * pressed as it is. Plain where the theme has no colours to mix.
 */
export function breathing(theme: PanelTheme, now: number): (key: PanelKey, text: string) => string {
  const text = theme.colors?.text;
  const dim = theme.colors?.dim ?? theme.colors?.muted;
  const mode = theme.getColorMode?.();
  if (text === undefined || dim === undefined || (mode !== "truecolor" && mode !== "256color")) return (_key, line) => line;
  const ansi = foregroundAnsi(mixColors(text, dim, breath(now)), mode as TerminalColorMode);
  return (key, line) => (breathes(key) ? `${ansi}${line}\x1b[39m` : line);
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
  /** The keys breathing: a redraw a tick of it, while the panel shows and a key still breathes. */
  let breathTimer: ReturnType<typeof setInterval> | undefined;
  /** Whether the trace was open when the panel was first drawn. */
  let firstExpanded: boolean | undefined;
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
            return {
              // Laid out on every render, so ctrl+o takes effect on the very next frame.
              render: (width) => {
                const expanded = target.getToolsExpanded();
                // ctrl+o turns the trace open or closed: once it is not as it first was, ctrl+o was pressed.
                if (firstExpanded === undefined) firstExpanded = expanded;
                else if (expanded !== firstExpanded) keyPressed("trace");
                const marks: MarkPaint = { success: (text) => theme.fg("success", text), error: (text) => theme.fg("error", text), warning: (text) => theme.fg("warning", text) };
                const lines = jobPanelLines(list(), { expanded, width, marks, keys: breathing(theme, Date.now()) });
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
      breathTimer = setInterval(() => {
        // Both pressed: nothing breathes, and the panel is drawn as often as before.
        if (!breathes("trace") && !breathes("peek")) {
          clearInterval(breathTimer);
          breathTimer = undefined;
          return;
        }
        tui?.requestRender();
      }, BREATH_TICK_MS);
      breathTimer.unref?.();
    } else if (!mounted && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
      if (breathTimer !== undefined) clearInterval(breathTimer);
      breathTimer = undefined;
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
