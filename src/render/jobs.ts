import { randomUUID } from "node:crypto";
import { JobStoppedError, withActivity, type TranscriptEntry, type UsageReport } from "./activity.ts";

/**
 * Background jobs for conversation mode.
 *
 * Rendering a functionality takes minutes, and a tool's `execute` blocks the agent loop
 * for as long as it runs - which means the person cannot say anything until it finishes.
 * A job starts the work detached and hands back an id immediately, so the conversation
 * carries on while the agents work.
 */

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "stopped";

export interface Job {
  id: string;
  kind: string;
  /** One line describing what was asked for. */
  summary: string;
  status: JobStatus;
  /** Monotonic start order. Two jobs can share a millisecond, so ordering uses this. */
  sequence: number;
  queuedAt: number;
  /** When the work itself began - after any wait in the queue. */
  startedAt: number;
  /** While queued: the jobs it is waiting for. */
  waitingOn: string[];
  finishedAt?: number;
  /** Tail of the streamed output, bounded so a long run cannot grow without limit. */
  tail: string;
  /** The stage the work is at, as the work itself last reported it. */
  stage?: string;
  /** The most recent things the agents did, newest last. */
  activity: string[];
  /** What is happening right now, and since when. */
  now?: { label: string; since: number };
  /** Every model response its agents have had, added up. */
  usage: UsageReport;
  /** The whole conversation of its agents, oldest dropped first past a size limit. */
  transcript: TranscriptEntry[];
  /** What to tell the agent when it asks how the job went. */
  report?: string;
  /** What to tell the person when it lands, if shorter than the report. */
  announce?: string;
  error?: string;
  details?: unknown;
}

export interface JobOutcome {
  report: string;
  /**
   * What the person is shown when the job lands. The report is written for the agent and
   * can carry detail it needs and the person does not; omitted, the report is shown.
   */
  announce?: string;
  details?: unknown;
}

export interface StartJobInput {
  kind: string;
  summary: string;
  /**
   * What the job writes, e.g. a module's directory. Two jobs sharing a lane never run at
   * the same time: the later one queues until the earlier one settles, whatever started
   * them. Jobs with no lanes in common run side by side.
   */
  lanes?: string[];
  run: (onDelta: (delta: string) => void) => Promise<JobOutcome>;
}

export interface JobRegistry {
  start(input: StartJobInput): Job;
  /**
   * Stop a job. A queued one never starts; a running one has its agent's turn aborted and
   * ends as stopped. Returns the job, or undefined when there is no such job or it has
   * already finished.
   */
  stop(id: string): Job | undefined;
  get(id: string): Job | undefined;
  list(): Job[];
  /** Resolves when the job settles. Used by callers that asked to wait. */
  wait(id: string): Promise<Job>;
}

const DEFAULT_TAIL_CHARS = 4000;

const ACTIVITY_LINES = 6;
/** A long render's full transcript is kept, up to about this much text. */
const MAX_TRANSCRIPT_CHARS = 600_000;


export function createJobRegistry(options?: {
  onFinish?: (job: Job) => void;
  /** A job started, moved to another stage, or did something. */
  onChange?: (job: Job) => void;
  tailChars?: number;
}): JobRegistry {
  const jobs = new Map<string, Job>();
  const settled = new Map<string, Promise<Job>>();
  const tailChars = options?.tailChars ?? DEFAULT_TAIL_CHARS;
  /** The last job to claim each lane. A new job waits for it and becomes the new tail. */
  const lanes = new Map<string, string>();
  const controllers = new Map<string, AbortController>();
  /**
   * Jobs whose work is over. Not the same as a finished status: a queued job that was
   * stopped says "stopped" at once, but still sits in its lanes until the job ahead of it
   * settles - and whatever queues behind it has to wait that long too.
   */
  const done = new Set<string>();
  let sequence = 0;

  return {
    start(input) {
      const id = randomUUID().slice(0, 8);
      const claimed = [...new Set(input.lanes ?? [])];
      const blockers = [
        ...new Set(
          claimed
            .map((lane) => lanes.get(lane))
            .filter((other): other is string => other !== undefined && jobs.has(other) && !done.has(other)),
        ),
      ];
      for (const lane of claimed) lanes.set(lane, id);

      const now = Date.now();
      const job: Job = {
        id,
        kind: input.kind,
        summary: input.summary,
        status: blockers.length > 0 ? "queued" : "running",
        sequence: (sequence += 1),
        queuedAt: now,
        startedAt: now,
        waitingOn: blockers,
        tail: "",
        activity: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        transcript: [],
      };
      jobs.set(job.id, job);
      let transcriptChars = 0;

      const changed = () => {
        // Like onFinish: a display that throws must not take the job down.
        try {
          options?.onChange?.(job);
        } catch {
          /* ignore */
        }
      };
      changed();

      const controller = new AbortController();
      controllers.set(id, controller);
      const sink = {
        signal: controller.signal,
        stage(label: string) {
          job.stage = label;
          this.transcript({ kind: "stage", text: label });
          changed();
        },
        transcript(entry: TranscriptEntry) {
          const last = job.transcript.at(-1);
          // Deltas of a running reply join the entry they continue.
          if ((entry.kind === "text" || entry.kind === "thinking") && last?.kind === entry.kind) {
            last.text += entry.text;
          } else {
            job.transcript.push({ ...entry });
          }
          transcriptChars += entry.text.length;
          while (transcriptChars > MAX_TRANSCRIPT_CHARS && job.transcript.length > 1) {
            transcriptChars -= job.transcript.shift()!.text.length;
          }
        },
        activity(line: string) {
          job.activity = [...job.activity, line].slice(-ACTIVITY_LINES);
          changed();
        },
        usage(spent: UsageReport) {
          job.usage = {
            input: job.usage.input + spent.input,
            output: job.usage.output + spent.output,
            cacheRead: job.usage.cacheRead + spent.cacheRead,
            cacheWrite: job.usage.cacheWrite + spent.cacheWrite,
            cost: job.usage.cost + spent.cost,
          };
          changed();
        },
        now(label: string | undefined, opts?: { keepSince?: boolean }) {
          job.now =
            label === undefined
              ? undefined
              : { label, since: opts?.keepSince && job.now ? job.now.since : Date.now() };
          changed();
        },
      };

      // Whether the job ahead succeeded or failed, this one gets its turn: each reports on
      // its own, and a failure upstream is not a reason to skip what was asked for.
      const turn = Promise.allSettled(blockers.map((other) => settled.get(other)));

      const promise = turn
        .then(() => {
          // Stopped while it waited: it never starts.
          if (controller.signal.aborted) throw new JobStoppedError();
          if (job.status === "queued") {
            job.status = "running";
            job.startedAt = Date.now();
            job.waitingOn = [];
            changed();
          }
          return withActivity(sink, () =>
            input.run((delta) => {
              job.tail = (job.tail + delta).slice(-tailChars);
            }),
          );
        })
        .then(
          (outcome) => {
            job.status = "succeeded";
            job.report = outcome.report;
            job.announce = outcome.announce;
            job.details = outcome.details;
            return job;
          },
          (error: unknown) => {
            // Asked to stop is not a failure, whatever the work threw as it unwound.
            job.status = controller.signal.aborted ? "stopped" : "failed";
            job.error = controller.signal.aborted ? "Stopped on request." : error instanceof Error ? error.message : String(error);
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
      promise.then(() => {
        controllers.delete(id);
        done.add(id);
        // Release the lanes this job still holds, so a later job does not wait on a ghost.
        for (const lane of claimed) if (lanes.get(lane) === id) lanes.delete(lane);
      });
      return job;
    },

    get(id) {
      return jobs.get(id);
    },

    stop(id) {
      const job = jobs.get(id);
      const controller = controllers.get(id);
      if (job === undefined || controller === undefined || done.has(id) || job.status === "stopped") return undefined;
      controller.abort();
      // A queued job is done with at once, so the queue behind it shows it gone; a running
      // one stays running until its agent has actually stopped.
      if (job.status === "queued") {
        job.status = "stopped";
        job.waitingOn = [];
        job.error = "Stopped on request.";
        options?.onChange?.(job);
      }
      return job;
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
  if (job.status === "queued") {
    return `job ${job.id} (${job.kind}): queued behind ${job.waitingOn.map((id) => `job ${id}`).join(" and ")} — ${job.summary}. It starts when that finishes.`;
  }
  const header = `job ${job.id} (${job.kind}): ${job.status}, ${formatDuration(job)} — ${job.summary}`;
  if (job.status === "running") {
    return [
      header,
      ...(job.stage ? ["", `stage: ${job.stage}`] : []),
      ...(job.activity.length > 0 ? ["", "<recent activity>", ...job.activity, "</recent activity>"] : []),
      "",
      "<latest output>",
      job.tail.trimEnd() || "(nothing yet)",
      "</latest output>",
    ].join("\n");
  }
  if (job.status === "failed") return `${header}\n\n${job.error ?? "no error recorded"}`;
  if (job.status === "stopped") return `${header}\n\nStopped on request. Whatever it changed before it stopped is still on disk.`;
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
