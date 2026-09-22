import { join, resolve } from "node:path";
import { basename } from "node:path";
import { plainFileParser } from "../plain/parser.ts";
import { staleFrids } from "./state.ts";
import { describeDelivery } from "./delivery.ts";
import { defaultBuildDir } from "./paths.ts";
import { resolveTemplateDirs } from "./render.ts";
import { renderFunctionality } from "./render.ts";
import { regenerateFunctionality } from "./module.ts";
import { moduleLanes } from "./lanes.ts";
import { randomUUID } from "node:crypto";
import type { Job, JobRegistry } from "./jobs.ts";

/**
 * Renders queued while an interview carries on.
 *
 * Two constraints make this a queue rather than a pile of background jobs. Rendering
 * functionality N expects the ones before it to already exist in the build, so they have
 * to run in order; and two renders writing the same build directory at once would trip
 * over each other. So each render waits for the one before it, while the interview - the
 * thing the person is actually waiting on - never waits for any of them.
 */

export interface RenderRequest {
  plainFile: string;
  frid: string;
  /** The specification changed after this functionality was already built. */
  regenerate?: boolean;
}

export interface QueuedRender extends RenderRequest {
  jobId: string;
  position: number;
}

/** The work a queued entry performs. Injectable so the ordering can be tested. */
export type RenderRunner = (
  request: RenderRequest & { plainFile: string },
  onDelta: (delta: string) => void,
) => Promise<{ report: string; details?: unknown }>;

export interface RenderQueue {
  enqueue(request: RenderRequest): QueuedRender;
  /**
   * Queue a regeneration for every functionality whose built code no longer matches the
   * specification. Returns what it queued, which is nothing when everything still matches.
   */
  requeueStale(plainFile: string, buildDir?: string): QueuedRender[];
  /** The entry for a functionality that is queued or building right now, if there is one. */
  inFlight(plainFile: string, frid: string): QueuedRender | undefined;
  /** What has been queued, in order, with each job's current state. */
  status(): Array<QueuedRender & { status: Job["status"] }>;
  /** Resolves when everything queued so far has finished. */
  drain(): Promise<void>;
}

export function createRenderQueue(options: {
  registry: JobRegistry;
  cwd: string;
  buildDir?: string;
  model?: string;
  /** Defaults to actually rendering. */
  run?: RenderRunner;
}): RenderQueue {
  const runner: RenderRunner = options.run ?? defaultRunner(options);
  const queued: QueuedRender[] = [];
  const jobs = new Map<string, Job>();

  // Ordering is the registry's: every entry claims this queue's own lane, so they run one
  // at a time in the order they were asked for, and the module lanes, so none of them runs
  // alongside a render of the same module that was started some other way.
  const queueLane = `render-queue:${randomUUID()}`;
  let last: string | undefined;

  return {
    enqueue(request) {
      const plainFile = resolve(options.cwd, request.plainFile);

      const job = options.registry.start({
        kind: request.regenerate ? "regenerate" : "render",
        // Short enough to read in a one-line queue: the file's name, not its path.
        summary: `${basename(plainFile)} fs ${request.frid}${request.regenerate ? " (rebuild)" : ""}`,
        lanes: [queueLane, ...moduleLanes(plainFile, options.buildDir)],
        run: (onDelta) => runner({ ...request, plainFile }, onDelta),
      });

      jobs.set(job.id, job);
      last = job.id;

      // Stored resolved, so the same file named two ways is recognised as one.
      const entry: QueuedRender = { ...request, plainFile, jobId: job.id, position: queued.length + 1 };
      queued.push(entry);
      return entry;
    },

    requeueStale(plainFile, buildDir) {
      const file = resolve(options.cwd, plainFile);
      const dirs = resolveTemplateDirs(file);
      let moduleName: string;
      let tree;
      try {
        [moduleName, tree] = plainFileParser(basename(file), dirs);
      } catch {
        // A spec that does not parse has nothing dependable to compare against.
        return [];
      }

      const target = buildDir ?? options.buildDir ?? defaultBuildDir(moduleName, options.cwd);

      // Something already waiting to be built will pick up the current spec when it runs,
      // so re-queueing it would render the same thing twice.
      const inFlight = new Set(
        queued
          .filter((entry) => {
            const status = jobs.get(entry.jobId)?.status;
            return status === "running" || status === "queued";
          })
          .map((entry) => entry.frid),
      );

      return staleFrids(tree, target)
        .filter((entry) => !inFlight.has(entry.frid))
        .map((entry) => this.enqueue({ plainFile, frid: entry.frid, regenerate: true }));
    },

    inFlight(plainFile, frid) {
      const file = resolve(options.cwd, plainFile);
      return queued.find((entry) => {
        if (entry.plainFile !== file || entry.frid !== frid) return false;
        const status = jobs.get(entry.jobId)?.status;
        return status === "running" || status === "queued";
      });
    },

    status() {
      return queued.map((entry) => ({
        ...entry,
        status: jobs.get(entry.jobId)?.status ?? "running",
      }));
    },

    async drain() {
      if (last !== undefined) await options.registry.wait(last);
    },
  };
}


function defaultRunner(options: { buildDir?: string; model?: string }): RenderRunner {
  return async (request, onDelta) => {
    const common = {
      plainFile: request.plainFile,
      frid: request.frid,
      buildDir: options.buildDir,
      model: options.model,
      onDelta,
    };

    if (request.regenerate === true) {
      const result = await regenerateFunctionality(common);
      return {
        report: result.passed
          ? `Regenerated functionality ${result.frid}; the conformance suite passes.`
          : `Regeneration of functionality ${result.frid} stopped at ${result.stoppedAt}.`,
        details: { passed: result.passed },
      };
    }

    const result = await renderFunctionality(common);
    return {
      report: describeDelivery({
        moduleName: result.moduleName,
        frid: result.frid,
        functionality: result.functionality,
        buildDir: result.buildDir,
        added: result.added,
        runs: result.runs,
        passed: result.passed,
        tryIt: result.tryIt,
      }),
      details: { passed: result.passed, files: result.files },
    };
  };
}
