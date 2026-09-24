import { join, resolve } from "node:path";
import { basename } from "node:path";
import { plainFileParser } from "../plain/parser.ts";
import { pendingFrids, staleFrids } from "./state.ts";
import { describeDelivery } from "./delivery.ts";
import { defaultBuildDir, modulesRoot } from "./paths.ts";
import { resolveTemplateDirs } from "./render.ts";
import { renderFunctionality } from "./render.ts";
import { ensureRegressionPasses, regenerateFunctionality, describeRegenerationStop } from "./module.ts";
import { getFrids, getInheritedFunctionalSpecs } from "../plain/spec.ts";
import { moduleLanes } from "./lanes.ts";
import { findCodebaseTip } from "./requires.ts";
import type { RenderWork } from "./models.ts";
import { describeStop, type StopPoint } from "./stop-report.ts";
import { describeSpecDiff, renderSpecDiff, type SpecSnapshot } from "./spec-change.ts";
import { randomUUID } from "node:crypto";
import type { Job, JobRegistry } from "./jobs.ts";
import { reportStage } from "./activity.ts";

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
  /** "provider/model-id" to render it on, settled when it was queued. */
  model?: string;
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
   * Render a spec change, given as a git diff, in the order it was asked for - behind every
   * render queued before it, and never alongside another job on the same modules.
   */
  enqueueSpecDiff(request: {
    plainFile: string;
    diff: string;
    /** How putting the diff in went, when it was written. */
    applied: "applied" | "already applied";
    spec: SpecSnapshot;
  }): { jobId: string; position: number };
  /**
   * Queue a regeneration for every functionality whose built code no longer matches the
   * specification. Returns what it queued, which is nothing when everything still matches.
   */
  requeueStale(plainFile: string, buildDir?: string): QueuedRender[];
  /**
   * Queue everything the spec holds that is not built from its current text: changed ones
   * as regenerations first, then ones never built, in order. For a run picked up after a
   * restart, whose queue did not survive it. Returns what it queued.
   */
  catchUp(plainFile: string, buildDir?: string): QueuedRender[];
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
  /** The model when modelFor is not given. */
  model?: string;
  /**
   * The model for a kind of work, asked when a job is queued - so a job keeps the model it was
   * asked with, and one queued after the person chose another model gets that one.
   */
  modelFor?: (work: RenderWork) => string | undefined;
  /** Defaults to actually rendering. */
  run?: RenderRunner;
}): RenderQueue {
  const modelOf = (work: RenderWork) => (options.modelFor ? options.modelFor(work) : options.model);
  const runner: RenderRunner = options.run ?? defaultRunner(options);
  const queued: QueuedRender[] = [];
  const jobs = new Map<string, Job>();

  // Ordering is the registry's: every entry claims this queue's own lane, so they run one
  // at a time in the order they were asked for, and the module lanes, so none of them runs
  // alongside a render of the same module that was started some other way.
  const queueLane = `render-queue:${randomUUID()}`;
  let last: string | undefined;

  return {
    enqueueSpecDiff(request) {
      const plainFile = resolve(options.cwd, request.plainFile);
      const model = modelOf("spec_changes");
      const job = options.registry.start({
        kind: "render_spec_diff",
        summary: `${basename(plainFile)} render spec diff`,
        diff: request.diff,
        model,
        lanes: [queueLane, ...moduleLanes(codebaseOf(plainFile), options.buildDir)],
        run: async (onDelta) => {
          // write_spec_diff applied it, and parsed the spec, when it was written; later changes
          // may be on top of it in the files now.
          const result = await renderSpecDiff({
            plainFile,
            diff: request.diff,
            cwd: options.cwd,
            model,
            applied: request.applied,
            spec: request.spec,
            // Queued from an interview: the person is there, trying each change as it lands.
            tryIt: true,
            onDelta,
          });
          return { report: describeSpecDiff(result), details: { passed: result.passed, stoppedAt: result.stoppedAt } };
        },
      });
      jobs.set(job.id, job);
      last = job.id;
      return { jobId: job.id, position: jobs.size };
    },

    enqueue(request) {
      const plainFile = resolve(options.cwd, request.plainFile);
      const model = request.model ?? modelOf("functionalities");

      const job = options.registry.start({
        kind: request.regenerate ? "regenerate" : "render",
        model,
        // Short enough to read in a one-line queue: the file's name, not its path.
        summary: `${basename(plainFile)} fs ${request.frid}${request.regenerate ? " (rebuild)" : ""}`,
        lanes: [queueLane, ...moduleLanes(request.regenerate ? codebaseOf(plainFile) : plainFile, options.buildDir)],
        run: (onDelta) => runner({ ...request, plainFile, model }, onDelta),
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

    catchUp(plainFile, buildDir) {
      const file = resolve(options.cwd, plainFile);
      let moduleName: string;
      let tree;
      try {
        [moduleName, tree] = plainFileParser(basename(file), resolveTemplateDirs(file));
      } catch {
        // Not a buildable module - an import module, or one that does not parse yet.
        return [];
      }
      const target = buildDir ?? options.buildDir ?? defaultBuildDir(moduleName, options.cwd);
      const regenerated = this.requeueStale(file, buildDir);
      const fresh = pendingFrids(tree, target)
        .filter((entry) => entry.reason === "never built" && this.inFlight(file, entry.frid) === undefined)
        .map((entry) => this.enqueue({ plainFile: file, frid: entry.frid }));
      return [...regenerated, ...fresh];
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


/** The spec whose codebase a regeneration writes: the tip built on this module, or itself. */
function codebaseOf(plainFile: string): string {
  try {
    return findCodebaseTip(plainFile).tip.plainFile;
  } catch {
    return plainFile;
  }
}

function defaultRunner(options: { buildDir?: string; model?: string; cwd: string }): RenderRunner {
  return async (request, onDelta) => {
    const common = {
      plainFile: request.plainFile,
      frid: request.frid,
      buildDir: options.buildDir,
      model: request.model ?? options.model,
      onDelta,
    };

    if (request.regenerate === true) {
      const result = await regenerateFunctionality(common);
      return {
        report: result.passed
          ? `Regenerated functionality ${result.frid}; the conformance suite passes.`
          : (describeRegenerationStop(result) ?? `Regeneration of functionality ${result.frid} stopped at ${result.stoppedAt}.`),
        details: { passed: result.passed },
      };
    }

    // Functionality N is rendered as built on 1 to N-1, so any of those that was never built -
    // its job stopped, or never queued - is built first, in order. Otherwise the render would
    // be told they are implemented when they are not.
    const [moduleName, tree] = plainFileParser(basename(request.plainFile), resolveTemplateDirs(request.plainFile));
    const target = options.buildDir ?? defaultBuildDir(moduleName);
    const missing = pendingFrids(tree, target, request.frid).filter(
      (entry) => entry.reason === "never built" && entry.frid !== request.frid,
    );
    const prerequisites: string[] = [];
    for (const entry of missing) {
      reportStage(`${moduleName}: building functionality ${entry.frid} first - ${request.frid} is built on it`);
      const built = await renderFunctionality({ ...common, frid: entry.frid });
      prerequisites.push(`functionality ${entry.frid} was not built yet, so it was built first${built.passed ? "" : " - its unit tests are NOT passing"}.`);
    }

    // Queued from an interview: the person is there, trying each spec as it lands.
    const result = await renderFunctionality({ ...common, tryIt: true });

    // The conformance tests already in this codebase - its own, and those carried up from
    // the modules below - are kept passing, even though none are written here.
    const regression = result.passed
      ? await ensureRegressionPasses({
          buildDir: result.buildDir,
          conformanceRoot: modulesRoot(options.cwd),
          moduleName,
          frids: [...getFrids(tree)].slice(0, [...getFrids(tree)].indexOf(request.frid) + 1),
          tree,
          required: getInheritedFunctionalSpecs(tree),
          command: null,
          model: options.model,
          onDelta,
        })
      : undefined;
    if (regression !== undefined && !regression.passed) {
      // Said in full by the stop report below.
    } else if (regression !== undefined && regression.repairs.length > 0) {
      prerequisites.push(`${regression.repairs.length} regression repair(s) changed the code so the existing conformance tests pass.`);
    }
    // A build that stopped says where, why and what to do; one that landed, how to try it.
    const stopped: StopPoint | undefined = !result.passed ? "unit tests" : regression !== undefined && !regression.passed ? "regression" : undefined;
    const delivery =
      stopped !== undefined
        ? describeStop({
            moduleName: result.moduleName,
            frid: result.frid,
            at: stopped,
            runs: result.runs,
            repairs: regression?.repairs.length,
          })
        : describeDelivery({
            moduleName: result.moduleName,
            frid: result.frid,
            functionality: result.functionality,
            buildDir: result.buildDir,
            added: result.added,
            runs: result.runs,
            passed: result.passed,
            tryIt: result.tryIt,
          });
    return {
      report: prerequisites.length > 0 ? `${delivery}\n\n${prerequisites.map((p) => `Note: ${p}`).join("\n")}` : delivery,
      details: { passed: result.passed, files: result.files, prerequisites: missing.map((entry) => entry.frid) },
    };
  };
}
