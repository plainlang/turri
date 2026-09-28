import { join, resolve } from "node:path";
import { basename } from "node:path";
import { plainFileParser } from "../plain/parser.ts";
import { pendingFrids, staleFrids } from "./state.ts";
import { describeDelivery } from "./delivery.ts";
import { defaultBuildDir, modulesRoot, projectDirOf } from "./paths.ts";
import { resolveTemplateDirs } from "./render.ts";
import { readProjectConfig } from "../config.ts";
import { findTestScripts, projectRootFor, withoutConformance } from "./test-scripts.ts";
import { renderFunctionality } from "./render.ts";
import { ensureRegressionPasses, regenerateFunctionality, describeRegenerationStop } from "./module.ts";
import { getFrids, getInheritedFunctionalSpecs } from "../plain/spec.ts";
import { moduleLanes } from "./lanes.ts";
import { findCodebaseTip } from "./requires.ts";
import type { RenderWork } from "./models.ts";
import { describeStop, type StopPoint } from "./stop-report.ts";
import { describeSpecDiff, renderSpecDiff, type SpecSnapshot } from "./spec-change.ts";
import { describeSpecDiffConformance, renderSpecDiffConformance } from "./spec-change-conformance.ts";
import { describeConformanceSuite, renderConformanceSuite, type ConformanceSuiteOptions } from "./conformance-suite.ts";
import { sectionsOf } from "./state.ts";
import { TEST_REQUIREMENTS } from "../plain/spec.ts";
import { randomUUID } from "node:crypto";
import type { Job, JobRegistry } from "./jobs.ts";
import { reportStage, unitOf } from "./activity.ts";
import { summarizeDiff } from "./job-panel.ts";
import { markWork } from "./history.ts";

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

/** One line of the queue, as shown: what the job builds, and how it is doing. */
export interface QueueEntry {
  position: number;
  jobId: string;
  /** "functionality 3", "functionality 3 (rebuild)", or "spec diff: <what it changes>". */
  what: string;
  /** For a functionality's render. */
  frid?: string;
  status: Job["status"];
}

export interface RenderQueue {
  enqueue(request: RenderRequest): QueuedRender;
  /**
   * Render a spec change, given as a git diff, in the order it was asked for - behind every
   * render queued before it, and never alongside another job on the same modules.
   */
  enqueueSpecDiff(request: SpecDiffRequest): { jobId: string; position: number; conformanceJobId?: string };
  /**
   * Bring the conformance tests in line with a spec change, as a job of its own. With `after`, it
   * is the conformance half of that render: it runs only if the render landed and left it to run.
   */
  enqueueSpecDiffConformance(request: Omit<SpecDiffRequest, "tryIt" | "conformance"> & { after?: string }): { jobId: string; position: number };
  /**
   * Write and run conformance tests for functionalities that are built, as a job of its own. With
   * `after`, it is the conformance half of that render, run only if the render landed.
   */
  enqueueConformance(request: ConformanceRequest): { jobId: string; position: number };
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
  /** Everything queued - functionalities and spec diffs - in order, with each job's current state. */
  status(): QueueEntry[];
  /** Resolves when everything queued so far has finished. */
  drain(): Promise<void>;
}

/** A spec change to render: the diff, and the spec as parsed with it in. */
export interface SpecDiffRequest {
  plainFile: string;
  diff: string;
  /** How putting the diff in went, when it was written. */
  applied: "applied" | "already applied";
  spec: SpecSnapshot;
  /** Where the diff's paths are relative to. Default: the queue's. */
  cwd?: string;
  /** The codebase to render in, when modules built on this one branch. */
  inModule?: string;
  /** Default: the queue's model for spec changes. */
  model?: string;
  /** Work out and check how to try it. Default true: queued from an interview, the person is there. */
  tryIt?: boolean;
  /** false: no conformance tests for it, and no conformance job after it. */
  conformance?: false;
}

/** Conformance tests to write for built functionalities. */
export interface ConformanceRequest extends Omit<ConformanceSuiteOptions, "onDelta" | "onEvent"> {
  /** What the tests are for, for the job's name: "functionality 3", "whole module". */
  scope: string;
  after?: string;
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
  modelFor?: (work: RenderWork, plainFile?: string) => string | undefined;
  /** Defaults to actually rendering. */
  run?: RenderRunner;
}): RenderQueue {
  const modelOf = (work: RenderWork, plainFile?: string) => (options.modelFor ? options.modelFor(work, plainFile) : options.model);
  const runner: RenderRunner = options.run ?? defaultRunner(options);
  const queued: QueuedRender[] = [];
  // Everything asked for, in order: a spec diff's render is not a functionality's, but it waits its turn all the same.
  const shown: Array<Omit<QueueEntry, "position" | "status">> = [];
  const jobs = new Map<string, Job>();

  // Ordering is the registry's: every entry claims this queue's own lane, so they run one
  // at a time in the order they were asked for, and the module lanes, so none of them runs
  // alongside a render of the same module that was started some other way.
  const queueLane = `render-queue:${randomUUID()}`;
  let last: string | undefined;

  /**
   * Why a conformance job that follows a render does not run, or nothing when it should: the
   * render did not land, or wrote no tests of its own to leave to it. Asked when its turn comes,
   * after the render has settled - they share the queue's lane.
   */
  const notFollowing = (after: string | undefined): string | undefined => {
    if (after === undefined) return undefined;
    const ahead = options.registry.get(after);
    const details = ahead?.details as { landed?: boolean; conformanceLater?: boolean } | undefined;
    if (ahead?.status !== "succeeded" || details?.landed !== true) {
      return `Not run: the render it follows (job ${after}) did not land, so there is no code for its conformance tests to check. Render it again, and they are queued behind it again.`;
    }
    if (details.conformanceLater === false) return `Not run: the render it follows (job ${after}) had no conformance tests to leave to it.`;
    return undefined;
  };

  /** Whether a spec as parsed has test reqs, which conformance tests are written from. */
  const hasTestReqs = (spec: SpecSnapshot) => (sectionsOf(spec.tree)[TEST_REQUIREMENTS] ?? []).length > 0;

  const queue: RenderQueue = {
    enqueueSpecDiff(request) {
      const plainFile = resolve(options.cwd, request.plainFile);
      const model = request.model ?? modelOf("spec_changes", plainFile);
      // Off when asked, or when the project's config.yaml turns it off; otherwise as its test reqs
      // say - and then it is a job of its own, right behind this one.
      const off = request.conformance === false || conformanceOff(projectDirOf(plainFile));
      const conformanceLater = !off && hasTestReqs(request.spec);
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
            cwd: request.cwd ?? options.cwd,
            inModule: request.inModule,
            conformance: off ? false : undefined,
            conformanceLater,
            model,
            applied: request.applied,
            spec: request.spec,
            // Queued from an interview: the person is there, trying each change as it lands.
            tryIt: request.tryIt ?? true,
            onDelta,
          });
          return {
            report: describeSpecDiff(result),
            details: { passed: result.passed, stoppedAt: result.stoppedAt, landed: result.passed, conformanceLater: result.conformanceLater === true },
          };
        },
      });
      jobs.set(job.id, job);
      last = job.id;
      shown.push({ jobId: job.id, what: `spec diff: ${summarizeDiff(request.diff)}` });
      const position = shown.length;
      const conformanceJobId = conformanceLater
        ? queue.enqueueSpecDiffConformance({ plainFile, diff: request.diff, applied: "already applied", spec: request.spec, cwd: request.cwd, inModule: request.inModule, model: request.model, after: job.id }).jobId
        : undefined;
      return { jobId: job.id, position, conformanceJobId };
    },

    enqueueSpecDiffConformance(request) {
      const plainFile = resolve(options.cwd, request.plainFile);
      const model = request.model ?? modelOf("spec_changes", plainFile);
      const job = options.registry.start({
        kind: "render_spec_diff_conformance",
        summary: `${basename(plainFile)} spec diff conformance`,
        diff: request.diff,
        model,
        follows: request.after,
        lanes: [queueLane, ...moduleLanes(codebaseOf(plainFile), options.buildDir)],
        run: async (onDelta) => {
          const skipped = notFollowing(request.after);
          if (skipped !== undefined) return { report: skipped, details: { passed: false, skipped: true } };
          const result = await renderSpecDiffConformance({
            plainFile,
            diff: request.diff,
            cwd: request.cwd ?? options.cwd,
            inModule: request.inModule,
            applied: request.applied,
            spec: request.spec,
            model,
            onDelta,
          });
          return { report: describeSpecDiffConformance(result), details: { passed: result.passed, stoppedAt: result.stoppedAt } };
        },
      });
      jobs.set(job.id, job);
      last = job.id;
      shown.push({ jobId: job.id, what: `spec diff conformance: ${summarizeDiff(request.diff)}` });
      return { jobId: job.id, position: shown.length };
    },

    enqueueConformance(request) {
      const { scope, after, ...suite } = request;
      const plainFile = resolve(options.cwd, suite.plainFile);
      const model = suite.model ?? modelOf("functionalities", plainFile);
      const job = options.registry.start({
        kind: "render_functionality_conformance",
        summary: `${basename(plainFile)} conformance, ${scope}`,
        model,
        follows: after,
        lanes: [queueLane, ...moduleLanes(suite.buildDir === undefined ? codebaseOf(plainFile) : plainFile, suite.buildDir ?? options.buildDir)],
        run: async (onDelta) => {
          const skipped = notFollowing(after);
          if (skipped !== undefined) return { report: skipped, details: { passed: false, skipped: true } };
          const result = await renderConformanceSuite({ ...suite, plainFile, model, onDelta });
          return { report: describeConformanceSuite(result), details: { passed: result.passed } };
        },
      });
      jobs.set(job.id, job);
      last = job.id;
      shown.push({ jobId: job.id, what: `conformance: ${scope}` });
      return { jobId: job.id, position: shown.length };
    },

    enqueue(request) {
      const plainFile = resolve(options.cwd, request.plainFile);
      const model = request.model ?? modelOf("functionalities", plainFile);

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
      shown.push({ jobId: job.id, what: `functionality ${request.frid}${request.regenerate ? " (rebuild)" : ""}`, frid: request.frid });
      const entry: QueuedRender = { ...request, plainFile, jobId: job.id, position: shown.length };
      queued.push(entry);

      // Its conformance tests are a job of their own, right behind it - when the project has them
      // on and the module has the test reqs they are written from. A regeneration brings its own
      // tests in line as part of it.
      if (request.regenerate !== true && !conformanceOff(projectDirOf(plainFile)) && moduleHasTestReqs(plainFile)) {
        queue.enqueueConformance({ plainFile, frids: [request.frid], scope: `functionality ${request.frid}`, model: request.model, buildDir: options.buildDir, after: job.id });
      }
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

      const target = buildDir ?? options.buildDir ?? defaultBuildDir(moduleName, projectDirOf(plainFile));

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
      const target = buildDir ?? options.buildDir ?? defaultBuildDir(moduleName, projectDirOf(plainFile));
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
      return shown.map((entry, index) => ({
        ...entry,
        position: index + 1,
        status: jobs.get(entry.jobId)?.status ?? "running",
      }));
    },

    async drain() {
      if (last !== undefined) await options.registry.wait(last);
    },
  };
  return queue;
}


/** The spec whose codebase a regeneration writes: the tip built on this module, or itself. */
function codebaseOf(plainFile: string): string {
  try {
    return findCodebaseTip(plainFile).tip.plainFile;
  } catch {
    return plainFile;
  }
}

/** Whether the project's config.yaml turns conformance off. */
function moduleHasTestReqs(plainFile: string): boolean {
  try {
    const [, tree] = plainFileParser(basename(plainFile), resolveTemplateDirs(plainFile));
    return (sectionsOf(tree)[TEST_REQUIREMENTS] ?? []).length > 0;
  } catch {
    return false;
  }
}

function conformanceOff(cwd: string): boolean {
  return readProjectConfig(cwd).conformanceTests === false;
}

function defaultRunner(options: { buildDir?: string; model?: string; cwd: string }): RenderRunner {
  return async (request, onDelta) => {
    // Off when the project's config.yaml turns conformance off - read for each build, so an edit
    // to the file holds for the next one.
    const off = conformanceOff(projectDirOf(resolve(options.cwd, request.plainFile)));
    const common = {
      plainFile: request.plainFile,
      frid: request.frid,
      buildDir: options.buildDir,
      model: request.model ?? options.model,
      ...(off ? { conformance: false } : {}),
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
    const target = options.buildDir ?? defaultBuildDir(moduleName, projectDirOf(request.plainFile));
    const missing = pendingFrids(tree, target, request.frid).filter(
      (entry) => entry.reason === "never built" && entry.frid !== request.frid,
    );
    const prerequisites: string[] = [];
    for (const entry of missing) {
      reportStage(`${unitOf(moduleName)}: building functionality ${entry.frid} first - ${request.frid} is built on it`);
      const built = await renderFunctionality({ ...common, frid: entry.frid });
      prerequisites.push(`functionality ${entry.frid} was not built yet, so it was built first${built.passed ? "" : " - its unit tests are NOT passing"}.`);
    }

    // Queued from an interview: the person is there, trying each spec as it lands. The
    // functionality and the whole suite passing with it are one unit, undone whole.
    const unit = markWork([target]);
    const result = await renderFunctionality({ ...common, tryIt: true });

    // The conformance tests already in this codebase - its own, and those carried up from
    // the modules below - are kept passing, even though none are written here.
    const regression = result.passed
      ? await ensureRegressionPasses({
          start: unit,
          buildDir: result.buildDir,
          conformanceRoot: modulesRoot(projectDirOf(request.plainFile)),
          moduleName,
          frids: [...getFrids(tree)].slice(0, [...getFrids(tree)].indexOf(request.frid) + 1),
          tree,
          required: getInheritedFunctionalSpecs(tree),
          scripts: off
            ? withoutConformance(findTestScripts(projectRootFor(request.plainFile, result.buildDir)))
            : findTestScripts(projectRootFor(request.plainFile, result.buildDir)),
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
            attempts: result.attempts,
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
      details: { passed: result.passed, landed: stopped === undefined, files: result.files, prerequisites: missing.map((entry) => entry.frid) },
    };
  };
}
