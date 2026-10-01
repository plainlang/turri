import { diffView, PLAIN_PAINT, type DiffPaint, type DiffWhere } from "./diff-view.ts";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TranscriptEntry } from "./activity.ts";
import type { DiffStyle } from "./job-panel.ts";
import type { Job } from "./jobs.ts";

/**
 * Reading a job's agents at work, as it happens.
 *
 * The panel shows the last few things a job did; this shows all of it - every prompt the
 * harness gave, every reply and thought, every tool call and what came back - on a screen of
 * its own that follows the newest line until the person scrolls away from it, and follows
 * again when they scroll back to the bottom. Leaving it goes back to the conversation and
 * keeps the place, so it can be switched to and from.
 */

/** How the viewer colours things. Plain text when there is no theme, as in tests. */
export interface TranscriptStyle extends DiffStyle {
  heading(text: string): string;
  muted(text: string): string;
  accent(text: string): string;
  error(text: string): string;
  /** How a spec diff is painted - ***plain highlighted, added and removed lines filled (`plain-palette.ts`). Not given: the +/- coloured alone. */
  diff?: DiffPaint;
}

const PLAIN: TranscriptStyle = {
  heading: (text) => text,
  muted: (text) => text,
  accent: (text) => text,
  error: (text) => text,
  added: (text) => text,
  removed: (text) => text,
};

function wrap(text: string, width: number, indent: string): string[] {
  const inner = Math.max(10, width - indent.length);
  return text
    .trimEnd()
    .split("\n")
    .flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, inner)))
    .map((line) => `${indent}${line}`);
}

/**
 * A spec change's diff, whole: what it adds and removes coloured, the rest receding. A line wider
 * than the screen wraps rather than being cut - a spec line changed near its end is the change.
 */
export function diffLines(diff: string, width: number, style: TranscriptStyle, where?: DiffWhere): string[] {
  return diffView(diff, width, style.diff ?? { ...PLAIN_PAINT, added: style.added, removed: style.removed, muted: style.muted }, where);
}

/** "judge" of "app 1 judge", "coding agent" of "app spec change coding agent" - the role, without the unit of work. */
export function roleOf(label: string): string {
  const roles = ["conformance agent", "coding agent", "test reviewer", "failure summarizer", "explorer", "judge", "repair agent"];
  return roles.find((role) => label.endsWith(role)) ?? label.split(" ").at(-1) ?? label;
}

function entryLines(entry: TranscriptEntry, width: number, style: TranscriptStyle): string[] {
  switch (entry.kind) {
    case "stage":
      // The harness's own step - not an agent's: it runs the tests, judges, and hands the work on.
      return ["", style.muted(`── harness · ${entry.text}`)];
    case "spec": {
      // The functional spec being built, whole: its first line says which, the rest is the text.
      const [label, ...text] = entry.text.split("\n");
      return ["", style.heading(`── building ${label}`), ...text.flatMap((line) => wrap(line, width, "  │ ").map(style.accent))];
    }
    case "diff":
      return ["", style.heading("── the spec change"), ...diffLines(entry.text, width, style)];
    case "prompt":
      return ["", style.muted("harness ▸"), ...wrap(entry.text, width, "  ").map(style.muted)];
    case "text":
      return ["", style.accent(`${entry.agent !== undefined ? roleOf(entry.agent.label) : "agent"} ▸`), ...wrap(entry.text, width, "  ")];
    case "thinking":
      return ["", style.muted("thinking ▸"), ...wrap(entry.text, width, "  ").map(style.muted)];
    case "tool":
      return wrap(`⚙ ${entry.text}`, width, "  ").map(style.accent);
    case "result":
      return wrap(entry.text === "" ? "(no output)" : entry.text, width, "    ").map(entry.error ? style.error : style.muted);
  }
}

/**
 * Every line of the job's transcript at this width, oldest first - led, for a render spec diff
 * job, by the change it renders, which is readable before the job has even started.
 */
export function transcriptLines(job: Job, width: number, style: TranscriptStyle = PLAIN, agent?: string): string[] {
  const change = job.diff === undefined ? [] : [style.heading("── the spec change"), ...diffLines(job.diff, width, style, job.diffWhere)];
  if (job.transcript.length === 0) {
    return [...change, ...(change.length > 0 ? [""] : []), style.muted(job.status === "queued" ? "(queued - not started yet)" : "(nothing yet)")];
  }
  // One agent's turns only, when following one - the harness's stages stay, so it is clear where it is.
  const entries = agent === undefined ? job.transcript : job.transcript.filter((entry) => entry.agent === undefined || entry.agent.label === agent);
  // Each agent's turn opens with who it is and what it runs on, whenever the speaker changes.
  let speaking: string | undefined;
  const lines = entries.flatMap((entry) => {
    const header: string[] = [];
    if (entry.agent !== undefined && entry.agent.label !== speaking) {
      speaking = entry.agent.label;
      header.push("", style.heading(`── agent · ${entry.agent.label}${entry.agent.model ? ` · ${entry.agent.model}` : ""}`));
    } else if (entry.agent === undefined && entry.kind === "stage") {
      speaking = undefined;
    }
    return [...header, ...entryLines(entry, width, style)];
  });
  return [...change, ...lines, ...ending(job, width, style)];
}

/** The agents a job has had, in the order they first spoke. */
export function agentsOf(job: Job): string[] {
  return [...new Set(job.transcript.flatMap((entry) => (entry.agent !== undefined ? [entry.agent.label] : [])))];
}

const FINISHED: Partial<Record<Job["status"], string>> = { succeeded: "finished", failed: "finished - failed", stopped: "stopped" };

/**
 * How a job that is over ended, after the last thing its agents did - so a finished job does not
 * look like one still at its last stage.
 */
function ending(job: Job, width: number, style: TranscriptStyle): string[] {
  const finished = FINISHED[job.status];
  if (finished === undefined) return [];
  const said = (job.announce ?? job.report ?? job.error ?? "").trim();
  return [
    "",
    style.heading(`── ${finished}`),
    ...(said === "" ? [] : said.split("\n").flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, width)))),
  ];
}

