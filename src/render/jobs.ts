import type { TryIt } from "./try-it.ts";
import { randomUUID } from "node:crypto";
import { withVmLease } from "./vm.ts";
import { JobStoppedError, withActivity, type BuildingSpec, type SpecConflict, type TranscriptEntry, type UsageReport } from "./activity.ts";
import { startJobLog, type JobLog } from "./job-log.ts";

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
  /** The spec change a render spec diff job renders, as its diff. Shown while it waits and runs. */
  diff?: string;
  /** "provider/model-id" its agents run on, when known. */
  model?: string;
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
  /** The functional spec it is building now, when it builds one. */
  building?: BuildingSpec;
  /** The most recent things the agents did, newest last. */
  activity: string[];
  /** What is happening right now, and since when. */
  now?: { label: string; since: number };
  /** Every model response its agents have had, added up. */
  usage: UsageReport;
  /** The whole conversation of its agents, oldest dropped first past a size limit. */
  transcript: TranscriptEntry[];
  /** How the person can try what it built, as the harness checked it - once its tests passed. */
  tryIt?: { tryIt: TryIt; buildDir: string };
  /** It failed, and failed again when retried - or a job ahead of it did: the queue behind it fails too. */
  failedForGood?: boolean;
  /** Why it failed for good, and what to do, as the diagnosis found. */
  diagnosis?: string;
  /** What to tell the agent when it asks how the job went. */
  report?: string;
  /** The spec contradicts itself, as its conformance run found: for the person to decide. */
  specConflict?: SpecConflict;
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
  /** For a render spec diff job: the diff, to show in the panel and the transcript. */
  diff?: string;
  /** "provider/model-id" its agents run on, to show where the job is shown. */
  model?: string;
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
  /**
   * How many times a job that fails - its work throws, or reports it did not pass - is run again.
   * Given, a job that fails that many times more fails for good: it is diagnosed, and every job
   * queued behind it fails without running. Not given, a failure is reported and the queue goes on.
   */
  retries?: number;
  /** Why a job failed for good, and what to do: for the person, with both failures. */
  diagnose?: (job: Job, failures: string[], jobLog?: string) => Promise<string | undefined>;
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
        diff: input.diff,
        model: input.model,
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
      /** The job's transcript on disk, from when it starts running - see job-log.ts. */
      let log: JobLog | undefined;
      const sink = {
        signal: controller.signal,
        job: { id, kind: input.kind, summary: input.summary },
        specConflict(conflict: SpecConflict) {
          job.specConflict = conflict;
          this.transcript({ kind: "stage", text: `the spec contradicts itself: functionalities ${conflict.specs.map((spec) => `${spec.module} ${spec.frid}`).join(" and ")} cannot both hold` });
          changed();
        },
        stage(label: string) {
          job.stage = label;
          this.transcript({ kind: "stage", text: label });
          changed();
        },
        spec(spec: BuildingSpec | undefined) {
          // The same functionality going on to its next stage keeps its clock; another starts a new one.
          const since = spec !== undefined && job.building?.label === spec.label ? job.building.since : Date.now();
          job.building = spec === undefined ? undefined : { ...spec, since };
          if (spec !== undefined) this.transcript({ kind: "spec", text: `${spec.label}\n${spec.text}` });
          changed();
        },
        transcript(entry: TranscriptEntry) {
          log?.entry(entry);
          // The screen keeps the clipped text; the log has the whole.
          const { full: _full, ...shown } = entry;
          entry = shown;
          const last = job.transcript.at(-1);
          // Deltas of a running reply join the entry they continue - the same agent's.
          if ((entry.kind === "text" || entry.kind === "thinking") && last?.kind === entry.kind && last.agent?.label === entry.agent?.label) {
            last.text += entry.text;
          } else {
            job.transcript.push({ ...entry });
          }
          transcriptChars += entry.text.length;
          while (transcriptChars > MAX_TRANSCRIPT_CHARS && job.transcript.length > 1) {
            transcriptChars -= job.transcript.shift()!.text.length;
          }
        },
        tryIt(steps: { tryIt: TryIt; buildDir: string }) {
          job.tryIt = steps;
          changed();
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

      // Whether the job ahead succeeded or failed, this one gets its turn: each reports on its own -
      // unless the registry retries, and one ahead of it failed for good: then nothing behind it runs.
      const turn = Promise.allSettled(blockers.map((other) => settled.get(other)));
      const guarded = options?.retries !== undefined;
      const retries = options?.retries ?? 0;
      /** A job's work ran, and did not do what it was asked: it threw, or said it did not pass. */
      const didNotPass = (outcome: JobOutcome) => {
        const details = outcome.details as { passed?: boolean; skipped?: boolean } | undefined;
        return details?.passed === false && details.skipped !== true;
      };
      const runOnce = () =>
        withVmLease(() =>
          withActivity(sink, () =>
            input.run((delta) => {
              job.tail = (job.tail + delta).slice(-tailChars);
            }),
          ),
        );
      const runGuarded = async (): Promise<JobOutcome> => {
        const failures: string[] = [];
        for (let attempt = 0; ; attempt += 1) {
          let outcome: JobOutcome | undefined;
          let error: unknown;
          try {
            outcome = await runOnce();
          } catch (thrown) {
            error = thrown;
          }
          // Asked to stop is not a failure: no retry, and nothing behind it fails for it.
          if (controller.signal.aborted) {
            if (error !== undefined) throw error;
            return outcome!;
          }
          if (error === undefined && !didNotPass(outcome!)) return outcome!;
          failures.push(error !== undefined ? (error instanceof Error ? error.message : String(error)) : outcome!.report);
          if (attempt < retries) {
            sink.stage(`the job failed - trying it once more (${attempt + 1} of ${retries})`);
            continue;
          }
          job.failedForGood = true;
          if (options?.diagnose !== undefined) {
            sink.stage("the job failed again - working out why, and what has to be done");
            job.diagnosis = await withActivity(sink, () => options.diagnose!(job, failures, log?.file)).catch(() => undefined);
          }
          throw new Error(
            [
              `Failed ${failures.length} time${failures.length === 1 ? "" : "s"}, so it and every job queued behind it have stopped.`,
              ...(job.diagnosis !== undefined ? ["", job.diagnosis] : []),
              "",
              "The last attempt ended with:",
              failures.at(-1)!.trim().slice(-4000),
            ].join("\n"),
          );
        }
      };

      const promise = turn
        .then(() => {
          // Stopped while it waited: it never starts.
          if (controller.signal.aborted) throw new JobStoppedError();
          // A job ahead of it failed for good: it does not start, and fails for good too - so does what waits on it.
          const failedAhead = guarded ? blockers.map((other) => jobs.get(other)).find((other) => other?.failedForGood === true) : undefined;
          if (failedAhead !== undefined) {
            job.failedForGood = true;
            throw new Error(
              `Not run: job ${failedAhead.id} ahead of it in the queue (${failedAhead.summary}) failed twice, so nothing queued behind it runs.` +
                (failedAhead.diagnosis !== undefined ? `\n\n${failedAhead.diagnosis}` : ""),
            );
          }
          if (job.status === "queued") {
            job.status = "running";
            job.startedAt = Date.now();
            job.waitingOn = [];
            changed();
          }
          log = startJobLog(job, claimed);
          if (log !== undefined) sink.activity(`job log: ${log.file}`);
          // The job holds the VMs it uses until it ends, and no longer.
          return guarded ? runGuarded() : runOnce();
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
          log?.end(finished.status === "succeeded" ? "finished" : finished.status === "stopped" ? "stopped" : "finished - failed", finished.announce ?? finished.report ?? finished.error);
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
  return formatElapsed((job.finishedAt ?? Date.now()) - job.startedAt);
}

/** "42s", "3m 12s", "1h 5m": how long something has run. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
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
      ...(job.building ? ["", `building ${job.building.label}:`, job.building.text] : []),
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
