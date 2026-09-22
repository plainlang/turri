import { resolve } from "node:path";
import { renderFunctionality } from "./render.ts";
import { regenerateFunctionality } from "./module.ts";
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

  // The chain is the whole mechanism: each render is appended to the previous one's
  // promise, so they run one at a time in the order they were asked for.
  let chain: Promise<unknown> = Promise.resolve();

  return {
    enqueue(request) {
      const plainFile = resolve(options.cwd, request.plainFile);
      const previous = chain;

      const job = options.registry.start({
        kind: request.regenerate ? "regenerate" : "render",
        summary: `${request.plainFile} functionality ${request.frid}`,
        run: async (onDelta) => {
          await previous.catch(() => {
            // A failed render must not cancel the ones behind it; each reports on its own.
          });
          return runner({ ...request, plainFile }, onDelta);
        },
      });

      jobs.set(job.id, job);
      chain = options.registry.wait(job.id);

      const entry: QueuedRender = { ...request, jobId: job.id, position: queued.length + 1 };
      queued.push(entry);
      return entry;
    },

    status() {
      return queued.map((entry) => ({
        ...entry,
        status: jobs.get(entry.jobId)?.status ?? "running",
      }));
    },

    async drain() {
      await chain.catch(() => {});
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
      report: result.passed
        ? `Built functionality ${result.frid} in ${result.buildDir}; unit tests pass.`
        : `Built functionality ${result.frid}, but its unit tests are NOT passing.`,
      details: { passed: result.passed, files: result.files },
    };
  };
}
