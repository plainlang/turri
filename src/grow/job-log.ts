import { appendFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import type { TranscriptEntry } from "./activity.ts";
import { ensureInScratch, MODULES_DIR, projectRootOf, scratchDir } from "./paths.ts";

/**
 * A job's whole transcript - what `/watch` shows - streamed to a file as it happens: the harness's
 * stages, the functional spec or the diff it builds, and every one of its agents, in order - what it
 * was asked, what it thought and wrote, each tool call and its result, whole, not clipped as the
 * screen clips them - and how the job ended.
 *
 * In `.turri/jobs/` in the project, one file per job, beside the per-agent logs in
 * `.turri/debug/`. Outside `plain_modules`, so no agent reads it. A log that cannot be
 * written is given up on, never allowed to fail the job.
 */

export interface JobLog {
  readonly file: string;
  entry(entry: TranscriptEntry): void;
  /** `agents`: a line per agent - its turns, compactions and cost. */
  end(status: string, report: string | undefined, agents?: string[]): void;
}

/** The folder a job's log goes in: the project of the first module it writes, from its lanes. */
export function jobLogDir(lanes: string[]): string | undefined {
  const lane = lanes.find((candidate) => isAbsolute(candidate) && candidate.split(sep).includes(MODULES_DIR));
  if (lane === undefined) return undefined;
  return join(scratchDir(join(projectRootOf(lane), MODULES_DIR)), "jobs");
}

export function startJobLog(job: { id: string; kind: string; summary: string; model?: string; diff?: string }, lanes: string[]): JobLog | undefined {
  const dir = jobLogDir(lanes);
  if (dir === undefined) return undefined;
  let file: string;
  try {
    ensureInScratch(dirname(dir), dir);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    file = join(dir, `${stamp}-${job.id}-${job.kind}.log`);
    for (let n = 2; existsSync(file); n += 1) file = join(dir, `${stamp}-${job.id}-${job.kind}-${n}.log`);
    appendFileSync(
      file,
      [
        `turri job ${job.id} · ${job.kind} · ${job.summary}`,
        `started   ${new Date().toISOString()}`,
        ...(job.model !== undefined ? [`model     ${job.model}`] : []),
        ...(job.diff !== undefined ? ["", "── the spec change", job.diff.trimEnd()] : []),
        "",
      ].join("\n"),
      { flag: "wx" },
    );
  } catch {
    return undefined;
  }

  let broken = false;
  const write = (text: string) => {
    if (broken) return;
    try {
      appendFileSync(file, text);
    } catch {
      broken = true;
    }
  };
  /** The kind of the entry written last: deltas of a reply join it, as they do on screen. */
  let last: TranscriptEntry["kind"] | undefined;

  return {
    file,
    entry(entry) {
      const text = entry.full ?? entry.text;
      if ((entry.kind === "text" || entry.kind === "thinking") && last === entry.kind) {
        write(text);
        return;
      }
      last = entry.kind;
      const at = stamp();
      switch (entry.kind) {
        case "stage":
          write(`\n\n${at} ── ${text}\n`);
          break;
        case "spec": {
          const [label, ...rest] = text.split("\n");
          write(`\n\n${at} ── building ${label}\n${rest.map((line) => `  │ ${line}`).join("\n")}\n`);
          break;
        }
        case "diff":
          write(`\n\n${at} ── the spec change\n${text.trimEnd()}\n`);
          break;
        case "prompt":
          write(`\n\n${at} harness ▸\n${text.trimEnd()}\n`);
          break;
        case "text":
          write(`\n\n${at} agent ▸\n${text}`);
          break;
        case "thinking":
          write(`\n\n${at} thinking ▸\n${text}`);
          break;
        case "tool":
          write(`\n\n${at} ⚙ ${text}\n`);
          break;
        case "result":
          write(`${at} ${entry.error ? "✗" : "↳"}\n${text === "" ? "    (no output)" : text.replace(/\n+$/, "").split("\n").map((line) => `    ${line}`).join("\n")}\n`);
          break;
      }
    },
    end(status, report, agents = []) {
      last = undefined;
      write(`\n\n${stamp()} ── ${status}\n${(report ?? "").trimEnd()}\n`);
      if (agents.length > 0) write(`\n── its agents\n${agents.map((line) => `  ${line}`).join("\n")}\n`);
    },
  };
}

function stamp(): string {
  const now = new Date();
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `[${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}]`;
}
