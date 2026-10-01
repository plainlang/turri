import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { describeUsage } from "./activity.ts";
import { spinner, summarizeDiff } from "./job-panel.ts";
import { formatDuration, type Job } from "./jobs.ts";
import { diffFiles, fileHeader, PLAIN_PAINT } from "./diff-view.ts";
import type { TranscriptStyle } from "./transcript-view.ts";

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
  /** The files of each job's diff opened or closed by hand, by job and file: the rest as they start - the file being rendered open, the others closed. */
  openFiles: Map<string, Map<string, boolean>>;
  /** The row the cursor is on. */
  cursor: number;
  /** The first line shown. */
  top: number;
}

export function createJobsTreeState(): JobsTreeState {
  return { open: { running: true, queued: true, finished: false }, openJobs: new Map(), openFiles: new Map(), cursor: 0, top: 0 };
}

export function sectionOf(job: Job): JobSection {
  return job.status === "running" ? "running" : job.status === "queued" ? "queued" : "finished";
}

export type TreeRow =
  | { kind: "section"; section: JobSection; count: number }
  | { kind: "job"; section: JobSection; job: Job }
  | { kind: "file"; section: JobSection; job: Job; file: string; first: boolean };

/** The files of a job's diff, in the order they are shown - read once for each diff, not on every frame. */
const filesSeen = new Map<string, { diff: string; files: string[] }>();
function filesOf(job: Job): string[] {
  if (job.diff === undefined || job.diff.trim() === "") return [];
  const seen = filesSeen.get(job.id);
  if (seen !== undefined && seen.diff === job.diff) return seen.files;
  const files = diffFiles(job.diff, 80, undefined, job.diffWhere).map((file) => file.file);
  filesSeen.set(job.id, { diff: job.diff, files });
  return files;
}

/** Whether a file of a job's diff is open: as it was opened or closed, else open when it is the file being rendered - the first. */
function isFileOpen(state: JobsTreeState, row: { job: Job; file: string; first: boolean }): boolean {
  return state.openFiles.get(row.job.id)?.get(row.file) ?? row.first;
}

function setFileOpen(state: JobsTreeState, job: Job, file: string, open: boolean): void {
  const files = state.openFiles.get(job.id) ?? new Map<string, boolean>();
  files.set(file, open);
  state.openFiles.set(job.id, files);
}

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
  // A job queued again as another is that other one: it is not listed apart.
  const bySequence = jobs.filter((job) => job.replacedBy === undefined).sort((a, b) => a.sequence - b.sequence);
  const of = (section: JobSection) => {
    const inSection = bySequence.filter((job) => sectionOf(job) === section);
    return section === "finished" ? inSection.sort((a, b) => (b.finishedAt ?? b.sequence) - (a.finishedAt ?? a.sequence) || b.sequence - a.sequence) : inSection;
  };
  // Forget what is open for jobs that moved on - they close as they leave.
  for (const job of jobs) isOpen(state, job);
  return SECTIONS.flatMap((section) => {
    const inSection = of(section);
    const jobRows = (job: Job): TreeRow[] => [
      { kind: "job", section, job },
      // An open job's diff, a row a file: each opens and closes on its own.
      ...(isOpen(state, job) ? filesOf(job).map((file, index): TreeRow => ({ kind: "file", section, job, file, first: index === 0 })) : []),
    ];
    return [{ kind: "section" as const, section, count: inSection.length }, ...(state.open[section] ? inSection.flatMap(jobRows) : [])];
  });
}

/**
 * A job's status beside its name. Running is the panel's spinner, not a play mark: a `▶` next to the `▸` that opens the
 * job reads as a second arrow to pick.
 */
const MARK: Record<string, (now: number) => string> = { running: spinner, queued: () => "·", succeeded: () => "✓", failed: () => "✗", stopped: () => "■" };

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
  // A diff is shown a file at a time, in rows of their own after these.
  if ((job.diff === undefined || job.diff.trim() === "") && job.building !== undefined) {
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
  return lines.length > 0 || filesOf(job).length > 0 ? lines : [style.muted(`${indent}(nothing more to show)`)];
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
    if (row.kind === "file") {
      const open = isFileOpen(state, row);
      const paint = style.diff ?? { ...PLAIN_PAINT, added: style.added, removed: style.removed, muted: style.muted };
      const shown = diffFiles(row.job.diff!, Math.max(10, width - FILE_INDENT.length), paint, row.job.diffWhere).find((file) => file.file === row.file);
      if (shown === undefined) return;
      const header = `${pointer}${FILE_INDENT.slice(1)}${fileHeader(shown, paint, open)}`;
      lines.push(here ? style.heading(header) : header);
      if (open) lines.push(...shown.rows.map((line) => `${FILE_INDENT}${line}`));
      return;
    }
    const { job } = row;
    const open = isOpen(state, job);
    const spent = describeUsage(job.usage);
    const change = changeLine(job);
    const head = `${pointer}   ${open ? "▾" : "▸"} ${MARK[job.status]?.(Date.now()) ?? "·"} ${job.summary}${change !== "" ? ` · ${change}` : ""} · ${formatDuration(job)}${spent !== "" ? ` · ${spent}` : ""}  (job ${job.id})`;
    const [first = "", ...rest] = wrapTextWithAnsi(head, Math.max(10, width));
    lines.push(here ? style.heading(first) : first, ...rest.map((line) => `        ${line}`));
    // Running, its stage is the one thing wanted at a glance.
    if (job.status === "running") lines.push(style.muted(`        ${job.stage ?? "starting"}`));
    if (open) lines.push(...detailLines(job, jobs, width, style));
  });
  return { lines, rowStarts, rows };
}

/** How far a job's files, and their lines, are indented under it. */
const FILE_INDENT = "        ";

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
      else if (row.kind === "file") setFileOpen(state, row.job, row.file, !isFileOpen(state, row));
      else if (state.openJobs.has(row.job.id)) state.openJobs.delete(row.job.id);
      else state.openJobs.set(row.job.id, row.section);
      return { kind: "handled" };
    case "open":
      if (row === undefined) return { kind: "none" };
      if (row.kind === "section") state.open[row.section] = true;
      else if (row.kind === "file") setFileOpen(state, row.job, row.file, true);
      else state.openJobs.set(row.job.id, row.section);
      return { kind: "handled" };
    case "close":
      if (row === undefined) return { kind: "none" };
      if (row.kind === "section") state.open[row.section] = false;
      else if (row.kind === "file") {
        // Open, it closes; closed, the cursor goes up to its job.
        if (isFileOpen(state, row)) setFileOpen(state, row.job, row.file, false);
        else state.cursor = rows.findLastIndex((other, index) => index < state.cursor && other.kind === "job" && other.job.id === row.job.id);
      } else if (state.openJobs.has(row.job.id)) state.openJobs.delete(row.job.id);
      else state.cursor = rows.findLastIndex((other, index) => index < state.cursor && other.kind === "section");
      return { kind: "handled" };
    case "openAll":
    case "closeAll": {
      if (row === undefined) return { kind: "none" };
      // On a file: every file of its job, to go through them quickly.
      if (row.kind === "file") {
        for (const other of rows) if (other.kind === "file" && other.job.id === row.job.id) setFileOpen(state, other.job, other.file, key === "openAll");
        return { kind: "handled" };
      }
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
      return row?.kind === "job" || row?.kind === "file" ? { kind: "trace", jobId: row.job.id } : { kind: "none" };
  }
}
