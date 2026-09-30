import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { describeUsage } from "./activity.ts";
import { summarizeDiff } from "./job-panel.ts";
import { formatDuration, type Job } from "./jobs.ts";
import { diffLines, type TranscriptStyle } from "./transcript-view.ts";

/**
 * The side panel's Jobs view: the queue as a tree, read one job at a time.
 *
 * Three sections - running, queued, finished - each opened and closed on its own, and under them one line per job:
 * what it is and what it changes. A job opened shows all of what it builds - the diff, or the spec - and, running,
 * what it is doing. So what is planned can be read without every diff on the screen at once.
 *
 * A cursor moves over the sections and the jobs; it stays on its row, whatever moves under it - a job that finishes
 * leaves its row to the one after it. A job opened stays open while it stays where it is: moving to another section
 * it closes, and turns up there collapsed. The state is the conversation's, kept while the panel is closed.
 */

export type JobSection = "running" | "queued" | "finished";

export const SECTIONS: JobSection[] = ["running", "queued", "finished"];

export interface JobsTreeState {
  /** Which sections are open. */
  open: Record<JobSection, boolean>;
  /** The jobs opened, by id, and the section each was opened in. */
  openJobs: Map<string, JobSection>;
  /** The row the cursor is on. */
  cursor: number;
  /** The first line shown. */
  top: number;
}

export function createJobsTreeState(): JobsTreeState {
  return { open: { running: true, queued: true, finished: false }, openJobs: new Map(), cursor: 0, top: 0 };
}

export function sectionOf(job: Job): JobSection {
  return job.status === "running" ? "running" : job.status === "queued" ? "queued" : "finished";
}

export type TreeRow = { kind: "section"; section: JobSection; count: number } | { kind: "job"; section: JobSection; job: Job };

/** Whether a job is open where it is now: one opened in another section, it closed when it left it. */
function isOpen(state: JobsTreeState, job: Job): boolean {
  const opened = state.openJobs.get(job.id);
  if (opened === undefined) return false;
  if (opened === sectionOf(job)) return true;
  state.openJobs.delete(job.id);
  return false;
}

/** The rows, top to bottom: each section's header, and its jobs when it is open - finished ones newest first. */
export function jobsTreeRows(jobs: Job[], state: JobsTreeState): TreeRow[] {
  const bySequence = [...jobs].sort((a, b) => a.sequence - b.sequence);
  const of = (section: JobSection) => {
    const inSection = bySequence.filter((job) => sectionOf(job) === section);
    return section === "finished" ? inSection.sort((a, b) => (b.finishedAt ?? b.sequence) - (a.finishedAt ?? a.sequence) || b.sequence - a.sequence) : inSection;
  };
  // Forget what is open for jobs that moved on - they close as they leave.
  for (const job of jobs) isOpen(state, job);
  return SECTIONS.flatMap((section) => {
    const inSection = of(section);
    return [{ kind: "section" as const, section, count: inSection.length }, ...(state.open[section] ? inSection.map((job) => ({ kind: "job" as const, section, job })) : [])];
  });
}

const MARK: Record<string, string> = { running: "▶", queued: "·", succeeded: "✓", failed: "✗", stopped: "■" };

/** What a job changes, in a line: its diff summed up, or what it builds. */
export function changeLine(job: Job): string {
  if (job.diff !== undefined && job.diff.trim() !== "") return summarizeDiff(job.diff);
  if (job.building !== undefined) return `${job.building.label}: ${job.building.text.split("\n").find((line) => line.trim() !== "")?.trim() ?? ""}`;
  if (job.follows !== undefined) return `the conformance tests of job ${job.follows}`;
  return "";
}

function wrap(text: string, width: number, indent: string, colour: (text: string) => string = (t) => t): string[] {
  return text
    .trimEnd()
    .split("\n")
    .flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, Math.max(10, width - indent.length))))
    .map((line) => colour(`${indent}${line}`));
}

/** The spec diffs a module's render planned and queued, from its details. */
function plannedOf(job: Job): Array<{ title: string; jobId: string }> {
  const planned = (job.details as { planned?: Array<{ title: string; jobId: string }> } | undefined)?.planned;
  return Array.isArray(planned) ? planned : [];
}

/** A job named for the one reading about another: what it was, and its id. */
function named(jobs: Job[], id: string): string {
  const job = jobs.find((other) => other.id === id);
  return job !== undefined ? `${job.summary} (job ${id}, ${job.status})` : `job ${id}`;
}

/** All of a job, opened: what it builds, and - running - what it is doing; waiting, what it waits on; done, how it ended. */
function detailLines(job: Job, jobs: Job[], width: number, style: TranscriptStyle): string[] {
  const indent = "        ";
  const lines: string[] = [];
  if (job.diff !== undefined && job.diff.trim() !== "") {
    lines.push(...diffLines(job.diff, Math.max(10, width - indent.length), style).map((line) => `${indent}${line}`));
  } else if (job.building !== undefined) {
    lines.push(style.muted(`${indent}${job.building.label}:`), ...wrap(job.building.text, width, `${indent}  `, style.accent));
  }
  if (job.follows !== undefined) lines.push(style.muted(`${indent}the conformance of ${named(jobs, job.follows)}`));
  // The job that planned it, for a spec diff a module's render queued; what a planning job planned, in order.
  const planner = jobs.find((other) => plannedOf(other).some((step) => step.jobId === job.id));
  if (planner !== undefined) lines.push(style.muted(`${indent}planned by ${named(jobs, planner.id)}`));
  plannedOf(job).forEach((step, index, all) => {
    if (index === 0) lines.push(style.muted(`${indent}planned ${all.length} spec diff${all.length === 1 ? "" : "s"}:`));
    lines.push(style.muted(`${indent}  ${index + 1}. ${step.title} → ${named(jobs, step.jobId)}`));
  });
  if (job.status === "queued" && job.waitingOn.length > 0) lines.push(style.muted(`${indent}waits for ${job.waitingOn.map((id) => `job ${id}`).join(", ")}`));
  if (job.note !== undefined) lines.push(...wrap(job.note, width, indent, style.accent));
  if (job.status === "running") {
    for (const line of job.activity) lines.push(...wrap(line, width, indent, style.muted));
    if (job.now !== undefined) lines.push(style.muted(`${indent}… ${job.now.label} · ${Math.max(0, Math.round((Date.now() - job.now.since) / 1000))}s`));
  }
  if (job.status === "failed" && job.error !== undefined) lines.push(...wrap(job.error.split("\n").slice(0, 6).join("\n"), width, indent, style.error));
  return lines.length > 0 ? lines : [style.muted(`${indent}(nothing more to show)`)];
}

/** The rows as lines, the cursor's marked, and where each row starts - for scrolling to it. */
export function jobsTreeLines(jobs: Job[], state: JobsTreeState, width: number, style: TranscriptStyle): { lines: string[]; rowStarts: number[]; rows: TreeRow[] } {
  const rows = jobsTreeRows(jobs, state);
  state.cursor = Math.max(0, Math.min(state.cursor, rows.length - 1));
  const lines: string[] = [];
  const rowStarts: number[] = [];
  rows.forEach((row, index) => {
    rowStarts.push(lines.length);
    const here = index === state.cursor;
    const pointer = here ? "›" : " ";
    if (row.kind === "section") {
      if (index > 0) {
        // A blank line between sections, kept off the cursor's row.
        lines.push("");
        rowStarts[index] = lines.length;
      }
      const header = `${pointer} ${state.open[row.section] ? "▾" : "▸"} ${row.section} (${row.count})`;
      lines.push(here ? style.heading(header) : style.muted(header));
      return;
    }
    const { job } = row;
    const open = isOpen(state, job);
    const spent = describeUsage(job.usage);
    const change = changeLine(job);
    const head = `${pointer}   ${open ? "▾" : "▸"} ${MARK[job.status] ?? "·"} ${job.summary}${change !== "" ? ` · ${change}` : ""} · ${formatDuration(job)}${spent !== "" ? ` · ${spent}` : ""}  (job ${job.id})`;
    const [first = "", ...rest] = wrapTextWithAnsi(head, Math.max(10, width));
    lines.push(here ? style.heading(first) : first, ...rest.map((line) => `        ${line}`));
    // Running, its stage is the one thing wanted at a glance.
    if (job.status === "running") lines.push(style.muted(`        ${job.stage ?? "starting"}`));
    if (open) lines.push(...detailLines(job, jobs, width, style));
  });
  return { lines, rowStarts, rows };
}

/** Keep the cursor's row in sight: scroll only as far as that takes. */
export function keepCursorInView(state: JobsTreeState, rowStarts: number[], lineCount: number, height: number): void {
  const start = rowStarts[state.cursor] ?? 0;
  const end = rowStarts[state.cursor + 1] ?? lineCount;
  // A line of its row in sight is enough: a job opened longer than the screen is read by scrolling through it.
  const inSight = start < state.top + height && end > state.top;
  if (!inSight && start < state.top) state.top = start;
  if (!inSight && start >= state.top + height) state.top = start - height + 1;
  state.top = Math.max(0, Math.min(state.top, Math.max(0, lineCount - height)));
}

/** Scroll the view by lines, the cursor coming along to the first row in sight. */
export function scrollTree(state: JobsTreeState, by: number, rowStarts: number[], lineCount: number, height: number): void {
  state.top = Math.max(0, Math.min(state.top + by, Math.max(0, lineCount - height)));
  const end = (row: number) => rowStarts[row + 1] ?? lineCount;
  // The cursor's row still has a line in sight - a job opened longer than the screen, read as it scrolls by: it stays.
  if ((rowStarts[state.cursor] ?? 0) < state.top + height && end(state.cursor) > state.top) return;
  // Otherwise onto the first row with a line in sight.
  const first = rowStarts.findIndex((start, row) => start < state.top + height && end(row) > state.top);
  state.cursor = Math.max(0, first);
}

export type TreeAction = { kind: "none" } | { kind: "handled" } | { kind: "trace"; jobId: string };

/** A key in the Jobs view. What it does to the tree, or the job whose trace to open. */
export function treeKey(state: JobsTreeState, rows: TreeRow[], key: "up" | "down" | "toggle" | "open" | "close" | "openAll" | "closeAll" | "trace"): TreeAction {
  const row = rows[state.cursor];
  switch (key) {
    case "up":
      state.cursor = Math.max(0, state.cursor - 1);
      return { kind: "handled" };
    case "down":
      state.cursor = Math.min(rows.length - 1, state.cursor + 1);
      return { kind: "handled" };
    case "toggle":
      if (row === undefined) return { kind: "none" };
      if (row.kind === "section") state.open[row.section] = !state.open[row.section];
      else if (state.openJobs.has(row.job.id)) state.openJobs.delete(row.job.id);
      else state.openJobs.set(row.job.id, row.section);
      return { kind: "handled" };
    case "open":
      if (row === undefined) return { kind: "none" };
      if (row.kind === "section") state.open[row.section] = true;
      else state.openJobs.set(row.job.id, row.section);
      return { kind: "handled" };
    case "close":
      if (row === undefined) return { kind: "none" };
      if (row.kind === "section") state.open[row.section] = false;
      else if (state.openJobs.has(row.job.id)) state.openJobs.delete(row.job.id);
      else state.cursor = rows.findLastIndex((other, index) => index < state.cursor && other.kind === "section");
      return { kind: "handled" };
    case "openAll":
    case "closeAll": {
      if (row === undefined) return { kind: "none" };
      const section = row.section;
      state.open[section] = true;
      for (const other of rows) {
        if (other.kind !== "job" || other.section !== section) continue;
        if (key === "openAll") state.openJobs.set(other.job.id, section);
        else state.openJobs.delete(other.job.id);
      }
      return { kind: "handled" };
    }
    case "trace":
      return row?.kind === "job" ? { kind: "trace", jobId: row.job.id } : { kind: "none" };
  }
}
