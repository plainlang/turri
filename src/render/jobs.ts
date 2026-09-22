import { randomUUID } from "node:crypto";

/**
 * Background jobs for conversation mode.
 *
 * Rendering a functionality takes minutes, and a tool's `execute` blocks the agent loop
 * for as long as it runs - which means the person cannot say anything until it finishes.
 * A job starts the work detached and hands back an id immediately, so the conversation
 * carries on while the agents work.
 */

export type JobStatus = "running" | "succeeded" | "failed";

export interface Job {
  id: string;
  kind: string;
  /** One line describing what was asked for. */
  summary: string;
  status: JobStatus;
  /** Monotonic start order. Two jobs can share a millisecond, so ordering uses this. */
  sequence: number;
  startedAt: number;
  finishedAt?: number;
  /** Tail of the streamed output, bounded so a long run cannot grow without limit. */
  tail: string;
  /** What to tell the agent when it asks how the job went. */
  report?: string;
  error?: string;
  details?: unknown;
}

export interface JobOutcome {
  report: string;
  details?: unknown;
}

export interface StartJobInput {
  kind: string;
  summary: string;
  run: (onDelta: (delta: string) => void) => Promise<JobOutcome>;
}

export interface JobRegistry {
  start(input: StartJobInput): Job;
  get(id: string): Job | undefined;
  list(): Job[];
  /** Resolves when the job settles. Used by callers that asked to wait. */
  wait(id: string): Promise<Job>;
}

const DEFAULT_TAIL_CHARS = 4000;

export function createJobRegistry(options?: {
  onFinish?: (job: Job) => void;
  tailChars?: number;
}): JobRegistry {
  const jobs = new Map<string, Job>();
  const settled = new Map<string, Promise<Job>>();
  const tailChars = options?.tailChars ?? DEFAULT_TAIL_CHARS;
  let sequence = 0;

  return {
    start(input) {
      const job: Job = {
        id: randomUUID().slice(0, 8),
        kind: input.kind,
        summary: input.summary,
        status: "running",
        sequence: (sequence += 1),
        startedAt: Date.now(),
        tail: "",
      };
      jobs.set(job.id, job);

      const promise = input
        .run((delta) => {
          job.tail = (job.tail + delta).slice(-tailChars);
        })
        .then(
          (outcome) => {
            job.status = "succeeded";
            job.report = outcome.report;
            job.details = outcome.details;
            return job;
          },
          (error: unknown) => {
            job.status = "failed";
            job.error = error instanceof Error ? error.message : String(error);
            return job;
          },
        )
        .then((finished) => {
          finished.finishedAt = Date.now();
          // A failing listener must not take the job down with it; the result is
          // already recorded and can still be collected by asking.
          try {
            options?.onFinish?.(finished);
          } catch {
            /* ignore */
          }
          return finished;
        });

      settled.set(job.id, promise);
      return job;
    },

    get(id) {
      return jobs.get(id);
    },

    list() {
      return [...jobs.values()].sort((a, b) => b.sequence - a.sequence);
    },

    async wait(id) {
      const promise = settled.get(id);
      if (promise === undefined) throw new Error(`No such job: ${id}`);
      return promise;
    },
  };
}

export function formatDuration(job: Job): string {
  const seconds = Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** What the agent is told when it checks on a job. */
export function describeJob(job: Job): string {
  const header = `job ${job.id} (${job.kind}): ${job.status}, ${formatDuration(job)} — ${job.summary}`;
  if (job.status === "running") {
    return [header, "", "<latest output>", job.tail.trimEnd() || "(nothing yet)", "</latest output>"].join("\n");
  }
  if (job.status === "failed") return `${header}\n\n${job.error ?? "no error recorded"}`;
  return `${header}\n\n${job.report ?? "(no report)"}`;
}


/**
 * Whether a tool should block rather than hand back a job id.
 *
 * Background only makes sense where the session outlives the turn. In print, json and rpc
 * modes the process ends as soon as the answer is written, taking any detached work with
 * it, so those wait unless told otherwise.
 */
export function shouldWait(mode: string, wait: boolean | undefined): boolean {
  return wait ?? mode !== "tui";
}
