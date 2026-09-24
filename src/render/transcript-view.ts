import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { describeUsage, type TranscriptEntry } from "./activity.ts";
import { styleDiffLine, type DiffStyle } from "./job-panel.ts";
import { formatDuration, type Job } from "./jobs.ts";

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

function entryLines(entry: TranscriptEntry, width: number, style: TranscriptStyle): string[] {
  switch (entry.kind) {
    case "stage":
      return ["", style.heading(`── ${entry.text}`)];
    case "prompt":
      return ["", style.muted("harness ▸"), ...wrap(entry.text, width, "  ").map(style.muted)];
    case "text":
      return ["", style.accent("agent ▸"), ...wrap(entry.text, width, "  ")];
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
export function transcriptLines(job: Job, width: number, style: TranscriptStyle = PLAIN): string[] {
  const change =
    job.diff === undefined
      ? []
      : [
          style.heading("── the spec change"),
          ...job.diff
            .trimEnd()
            .split("\n")
            .map((line) => {
              const clipped = truncateToWidth(line, width);
              const styled = styleDiffLine(clipped, style);
              // Headers and unchanged context are there to place the change; they recede.
              return styled === clipped ? style.muted(clipped) : styled;
            }),
        ];
  if (job.transcript.length === 0) {
    return [...change, ...(change.length > 0 ? [""] : []), style.muted(job.status === "queued" ? "(queued - not started yet)" : "(nothing yet)")];
  }
  return [...change, ...job.transcript.flatMap((entry) => entryLines(entry, width, style))];
}

function header(job: Job): string {
  const spent = describeUsage(job.usage);
  return `${job.summary} · ${job.status}${job.model ? ` · ${job.model}` : ""} · ${formatDuration(job)}${spent ? ` · ${spent}` : ""}  (job ${job.id})`;
}

export interface TranscriptViewOptions {
  job: () => Job | undefined;
  /** Rows the overlay may use. */
  rows: () => number;
  style?: TranscriptStyle;
  /** Back to the conversation, keeping the place. */
  back: () => void;
  /** Close it for good. */
  close: () => void;
}

/** The overlay component. Scrolled by keys; follows the newest line while at the bottom. */
export function createTranscriptView(options: TranscriptViewOptions) {
  const style = options.style ?? PLAIN;
  /** Lines scrolled up from the bottom. Zero: following. */
  let fromBottom = 0;
  let lastBodyHeight = 10;

  return {
    render(width: number): string[] {
      const job = options.job();
      const rows = Math.max(6, options.rows());
      const bodyHeight = rows - 3;
      lastBodyHeight = bodyHeight;
      if (job === undefined) return [style.error("That job is gone."), "", style.muted("x to close")];

      const body = transcriptLines(job, width, style);
      const maxScroll = Math.max(0, body.length - bodyHeight);
      fromBottom = Math.min(fromBottom, maxScroll);
      const end = body.length - fromBottom;
      const visible = body.slice(Math.max(0, end - bodyHeight), end);
      while (visible.length < bodyHeight) visible.push("");

      const where = fromBottom === 0 ? "following" : `${fromBottom} lines up`;
      return [
        style.heading(truncateToWidth(header(job), width)),
        style.muted("─".repeat(Math.max(1, width))),
        ...visible.map((line) => truncateToWidth(line, width)),
        // Where you are first: the keys are the part a narrow terminal can afford to lose.
        style.muted(
          truncateToWidth(`${where}  —  q back to chat (alt+w returns) · g top · G bottom · ↑↓ PgUp PgDn scroll · x close`, width),
        ),
      ];
    },

    handleInput(data: string): void {
      const page = Math.max(1, lastBodyHeight - 1);
      if (matchesKey(data, Key.escape) || data === "q") options.back();
      else if (data === "x") options.close();
      else if (matchesKey(data, Key.up) || data === "k") fromBottom += 1;
      else if (matchesKey(data, Key.down) || data === "j") fromBottom = Math.max(0, fromBottom - 1);
      else if (matchesKey(data, Key.pageUp)) fromBottom += page;
      else if (matchesKey(data, Key.pageDown) || data === " ") fromBottom = Math.max(0, fromBottom - page);
      else if (matchesKey(data, Key.home) || data === "g") fromBottom = Number.MAX_SAFE_INTEGER;
      else if (matchesKey(data, Key.end) || data === "G") fromBottom = 0;
    },

    invalidate(): void {},
  };
}
