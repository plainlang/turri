import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { basename, dirname } from "node:path";
import { plainFileParser, withParseCache } from "../plain/parser.ts";
import { pendingFrids, staleFrids } from "./state.ts";
import { describeDelivery, withTryItLine } from "./delivery.ts";
import { defaultBuildDir, modulesRoot, projectDirOf } from "./paths.ts";
import { resolveTemplateDirs } from "./render.ts";
import { configForSpec } from "../config.ts";
import { findTestScripts, projectRootFor, withoutConformance } from "./test-scripts.ts";
import { renderFunctionality, type PinnedSpec } from "./render.ts";
import { describeChainStop, ensureRegressionPasses, regenerateFunctionality, describeRegenerationStop, renderChain } from "./module.ts";
import { getFrids, getInheritedFunctionalSpecs } from "../plain/spec.ts";
import { moduleLanes } from "./lanes.ts";
import { findCodebaseTip, newlyRequired, resolveRequiresChain, type ChainEntry } from "./requires.ts";
import type { RenderWork } from "./models.ts";
import { describeStop, type StopPoint } from "./stop-report.ts";
import { describeSpecDiff, renderSpecDiff, specFilesOf, wholeSpecDiff, type SpecSnapshot } from "./spec-change.ts";
import { splitSpecDiff, type SpecDiffPart } from "./spec-diff-parts.ts";
import { diffSpecText, layoutOf, sameSpec, serializeTree } from "./spec-steps.ts";
import { listFiles } from "./testing.ts";
import { describeSpecDiffConformance, renderSpecDiffConformance } from "./spec-change-conformance.ts";
import { describeConformanceSuite, renderConformanceSuite, type ConformanceSuiteOptions } from "./conformance-suite.ts";
import { sectionsOf } from "./state.ts";
import { FUNCTIONAL_REQUIREMENTS, TEST_REQUIREMENTS } from "../plain/spec.ts";
import type { Job, JobRegistry } from "./jobs.ts";
import { reportStage, unitOf } from "./activity.ts";
import { summarizeDiff } from "./job-panel.ts";
import { abandonWork, markWork, resetToLastCommit, type WorkStart } from "./history.ts";
import { llmQueueMaster, netChanges, propose, reworkQueue, stepsOf, untouched, type MasterInput, type MasterPlan, type QueueMasterAgent, type Steering } from "./queue-master.ts";
import { llmChunkAgents, planChunks, type ChunkAgents } from "./chunk-plan.ts";
import { withActivity, type ActivitySink } from "./activity.ts";
import { inheritedTree, readBuiltTree, withBuiltFunctionality } from "./state.ts";
import type { MarshalledPlainSource } from "../plain/spec.ts";

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
  /**
   * The spec as it was when the render was queued - set by the queue. The render builds and records
   * that, not the file as it is when its turn comes: changes written after it are queued after it.
   */
  pinned?: PinnedSpec;
  /** The specification changed after this functionality was already built. */
  regenerate?: boolean;
  /** "provider/model-id" to render it on, settled when it was queued. */
  model?: string;
  /** How whoever queued it wants the queue planned: a strong preference, for every plan of its codebase while it waits. */
  guidance?: string;
  /** Its conformance tests follow as a job of their own - set by the queue: a regeneration lands on its unit tests. */
  conformanceLater?: boolean;
}

export interface QueuedRender extends RenderRequest {
  jobId: string;
  position: number;
  /** The conformance job right behind it, when its conformance tests follow as a job of their own. */
  conformanceJobId?: string;
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
  enqueueSpecDiff(request: SpecDiffRequest): QueuedSpecDiff;
  /**
   * Bring the conformance tests in line with a spec change, as a job of its own. With `after`, it
   * is the conformance half of that render: it runs only if the render landed and left it to run.
   */
  enqueueSpecDiffConformance(request: Omit<SpecDiffRequest, "conformance"> & { after?: string }): { jobId: string; position: number };
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
  /**
   * Bring the queue up to the spec as the .plain files have it now - for the module and every module it
   * requires, bottom first: from what the queue leaves each (what is built, and the jobs queued for it), one
   * spec diff for everything not built or queued yet, which the queue then plans into jobs from its functional
   * specs outward (chunk-plan.ts). Rendering a module is this, and so is being told the spec changed: the queue
   * master reviews the plan, as around any change. Says what it queued.
   */
  bringUpTo(plainFile: string, options?: { to?: string; only?: boolean; model?: string; guidance?: string }): BroughtUp;
  /** The entry for a functionality that is queued or building right now, if there is one. */
  inFlight(plainFile: string, frid: string): QueuedRender | undefined;
  /** What has been queued, in order, with each job's current state. */
  /** Everything queued - functionalities and spec diffs - in order, with each job's current state. */
  status(): QueueEntry[];
  /** Resolves when everything queued so far has finished. */
  drain(): Promise<void>;
  /**
   * Have the queue master rework the spec diffs waiting for a spec's codebase as the person asks -
   * reorder, merge, split, rewrite - held, as always, to ending on the spec as the .plain files have
   * it. Says what it did, and the queue it left.
   */
  rework(plainFile: string, instruction: string): Promise<string>;
  /**
   * Once the queue master's turn for a newly queued spec diff is over - or the wait runs out - what
   * it did to the queue: whether that job still runs, what it took out and rewrote, the queue it left.
   * Nothing when it left the queue as it was.
   */
  afterRework(jobId: string, timeoutMs?: number): Promise<string | undefined>;
}

/** Whether all that `after` adds to `built` is its functional spec `frid` - nothing changed, removed or added besides. */
export function addsOnlyFunctionality(built: MarshalledPlainSource | null, after: MarshalledPlainSource, frid: string): boolean {
  const changes = netChanges(built ?? {}, after);
  return changes.length === 1 && changes[0]!.kind === "add" && changes[0]!.section === FUNCTIONAL_REQUIREMENTS && changes[0]!.position === Number(frid);
}

/** What bringing the queue up to the spec queued, module by module: nothing, when it already ends there. */
export interface BroughtUp {
  modules: Array<{ module: string; specDiff?: string; renders: Array<{ frid: string; jobId: string }>; upToDate: boolean }>;
  /** Every job it queued, spec diffs and renders, in the order they run. */
  jobIds: string[];
}

/** What bringing the queue up to a spec queued, module by module, for the conversation to report. */
export function describeBroughtUp(brought: BroughtUp, file: string): string {
  if (brought.jobIds.length === 0) return `${file}: everything is built from the spec as it is - nothing to queue.`;
  const lines = [`Queued ${brought.jobIds.length} job${brought.jobIds.length === 1 ? "" : "s"} for ${file}, in the order they run:`];
  for (const module of brought.modules) {
    if (module.upToDate) {
      lines.push(`- ${module.module}: built from the spec as it is - nothing to do.`);
      continue;
    }
    if (module.specDiff !== undefined) lines.push(`- ${module.module}: job ${module.specDiff} builds what is not built yet - before it starts, the queue cuts it into jobs from its functional specs outward, each with the definitions and reqs it uses.`);
    if (module.renders.length > 0) {
      const frids = module.renders.map((render) => render.frid);
      lines.push(
        `- ${module.module}: functionalit${frids.length === 1 ? "y" : "ies"} ${frids.length === 1 ? frids[0] : `${frids[0]} to ${frids.at(-1)}`}, one job each - ${module.renders.map((render) => render.jobId).join(", ")}.`,
      );
    }
  }
  lines.push("", "The queue master sees these like any queued job: a spec changed while they run is worked in around them.");
  return lines.join("\n");
}

/**
 * The functional specs at the start of `now` that the code will have been built from once the queue ahead lands -
 * its tree `ahead` - however they are worded now: every one up to the last that `ahead` has word for word, or, when
 * none is, as many as `ahead` has.
 */
export function coveredPrefix(ahead: MarshalledPlainSource | null, now: MarshalledPlainSource): number {
  const specs = (tree: MarshalledPlainSource | null) => ((tree?.[FUNCTIONAL_REQUIREMENTS] as Array<{ markdown: string }> | undefined) ?? []).map((item) => item.markdown.trim());
  const had = specs(ahead);
  const has = specs(now);
  if (had.length === 0) return 0;
  const known = new Set(had);
  let last = -1;
  has.forEach((spec, index) => {
    if (known.has(spec)) last = index;
  });
  return last >= 0 ? last + 1 : Math.min(had.length, has.length);
}

/**
 * What a spec diff was queued as: a job per codebase it lands in, bottom of the chain first - the
 * first of them in `jobId`. Each renders its part, records a restructuring that has nothing to
 * render, or - the specs split into a module the code was not built on - builds that module and
 * the codebase again from scratch on it.
 */
export interface QueuedSpecDiff {
  jobId: string;
  position: number;
  conformanceJobId?: string;
  parts: QueuedSpecDiffPart[];
}

export interface QueuedSpecDiffPart {
  jobId: string;
  what: "render" | "restructure" | "rebuild";
  /** The codebase it lands in: its module. */
  module: string;
  /** The .plain files of the diff it has. */
  files: string[];
  /** The codebase holds nothing yet: it is given the whole spec as the change. */
  fromNothing: boolean;
  conformanceJobId?: string;
  /** For a rebuild: the modules now required that the code was not built on. */
  newlyRequired?: string[];
}

/** Build a codebase again, from scratch, on a module it now requires. Injectable so the queue can be tested. */
export type RebuildRunner = (
  request: { plainFile: string; model?: string; conformance?: false },
  onDelta: (delta: string) => void,
) => Promise<{ report: string; details?: unknown }>;

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
  /** false: no conformance tests for it, and no conformance job after it. */
  conformance?: false;
  /** How whoever queued it wants the queue planned: a strong preference, for every plan of its codebase while it waits. */
  guidance?: string;
  /**
   * A part that lands in a codebase holding nothing yet, with nothing queued for it before, is
   * given the whole spec of its module as the change - what was written before, as well as this.
   */
  wholeIfUnbuilt?: boolean;
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
  /** The queue master: an agent that reworks the queued spec diffs around each new change. false: none. Default: the LLM one. */
  queueMaster?: QueueMasterAgent | false;
  /**
   * The agents that cut the queue's work into jobs (chunk-plan.ts). Default: on the queue master's model, unless the
   * master is a stand-in or off - then the plan is a functional spec a job, and no model is asked.
   */
  chunkAgents?: ChunkAgents;
  /**
   * How the queue of a spec's codebase is to be planned, for every plan: the conversation's steering, and what the
   * project's AGENTS.md says of it. Read afresh each plan.
   */
  steering?: (plainFile: string) => Steering[];
  /** The queue master's model. Default: the model the spec change renders on. */
  masterModel?: string;
  /** How the queue master asks the person, when it is not sure. */
  askPerson?: (question: string) => Promise<string | undefined>;
  /** Told what the queue master did, each time it reworks a queue - for the person, in the TUI. */
  onRework?: (report: string) => void;
  /** Builds a codebase again from scratch. Defaults to rendering its chain. */
  rebuild?: RebuildRunner;
}): RenderQueue {
  const modelOf = (work: RenderWork, plainFile?: string) => (options.modelFor ? options.modelFor(work, plainFile) : options.model);
  const runRender: RenderRunner = options.run ?? defaultRunner(options);
  const queued: QueuedRender[] = [];
  // Everything asked for, in order: a spec diff's render is not a functionality's, but it waits its turn all the same.
  const shown: Array<Omit<QueueEntry, "position" | "status">> = [];
  const jobs = new Map<string, Job>();

  // Ordering is the registry's, by the module lanes: jobs on the same codebase - or on modules of one
  // requires chain - run one at a time in the order they were asked for, whether queued here or started
  // some other way; jobs on modules that share nothing run side by side. Every order the queue needs is
  // one of those: functionality N after N-1, a conformance job after its render, the upper part of a
  // split spec diff after the lower one - each on lanes the other claims too.
  /** The lanes each functionality render claims: what the queue master waits for on a codebase. */
  const renderLanes = new Map<string, string[]>();

  const renderLanesOf = (plainFile: string) => [...moduleLanes(plainFile, options.buildDir)];

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

  // Every spec diff this queue renders, by job: what it renders, which the queue master may rewrite
  // until it starts. And per codebase, the queue master's work in progress - no spec diff of that
  // codebase starts until it is done - and the spec as it last saw it.
  const works = new Map<string, SpecDiffWork>();
  const masters = new Map<string, Promise<void>>();
  const lastSeen = new Map<string, MarshalledPlainSource>();
  const gateOf = (codebase: string) => masters.get(codebase) ?? Promise.resolve();
  /**
   * Where each render and spec diff started - its module's commit before it - so the conformance job behind
   * it can take it back: a change counts as built only once its conformance tests pass.
   */
  const landStarts = new Map<string, WorkStart>();
  /**
   * A conformance job that follows a render or a spec diff: when it fails for good, what that render landed
   * is undone too - code, tests and the record of what the code is built from - before anything behind it
   * could run. Its functionality, or its change, is not built.
   */
  const undoWhenConformanceFails = (conformanceJobId: string, after: string) => {
    void options.registry.wait(conformanceJobId).then((settled) => {
      if (settled.status !== "failed") return;
      const start = landStarts.get(after);
      if (start === undefined) return;
      const render = options.registry.get(after);
      abandonWork(start, render?.summary ?? after, `its conformance tests do not pass (job ${conformanceJobId})`);
      if (render !== undefined) {
        render.note = `${render.note !== undefined ? `${render.note} ` : ""}Undone: its conformance tests (job ${conformanceJobId}) did not pass, so what it built was taken back - it counts as not built.`;
        render.details = { ...(render.details as object | undefined), landed: false };
      }
    });
  };
  // Every conformance job, by id: the spec it is for, so a config that turns conformance off reaches it while it waits.
  const conformanceJobs = new Map<string, string>();
  const offNote = "Not run: conformance tests are off in the project's config (conformance-tests: false) - turned off after it was queued. Turn them on again and render, and they are written again.";
  // Per codebase, the queue master's turns that changed the queue: how many, and what the last one did.
  const turns = new Map<string, { count: number; summary: string; by: string; taken: string[]; rewritten: string[] }>();
  // The codebases being built again from scratch, by job: the queue master leaves their spec diffs alone.
  const rebuilds: Array<{ jobId: string; codebase: string; part: QueuedSpecDiffPart }> = [];
  const rebuildRunner: RebuildRunner = options.rebuild ?? defaultRebuild;

  /** Render what a work says, as a spec diff: its change, from what the code is built from, to the spec it leaves. */
  const renderWork = async (work: SpecDiffWork, onDelta: (delta: string) => void) => {
    rebaseIfBehind(work, work.jobId!);
    // The config as it is now: conformance turned off since it was queued holds for it too.
    if (!work.off && conformanceOff(work.plainFile)) {
      work.off = true;
      work.conformanceLater = false;
    }
    // write_spec_diff applied it, and parsed the spec, when it was written; later changes
    // may be on top of it in the files now.
    const result = await renderSpecDiff({
      plainFile: work.plainFile,
      diff: work.diff,
      cwd: work.cwd ?? options.cwd,
      inModule: work.inModule,
      conformance: work.off ? false : undefined,
      conformanceLater: work.conformanceLater,
      model: work.model,
      applied: work.applied,
      spec: work.spec,
      onDelta,
    });
    // The change as its agents were shown it: its conformance job shows theirs the same.
    if (result.change !== undefined) work.changeText = result.change;
    return {
      // Landed code, it can be tried - once its conformance job, when one follows, has passed too.
      report: withTryItLine(describeSpecDiff(result), result.passed && result.conformanceLater !== true && result.restructured !== true),
      details: { passed: result.passed, stoppedAt: result.stoppedAt, landed: result.passed, conformanceLater: result.conformanceLater === true },
    };
  };

  /** Start a spec diff's render job - and its conformance job, when it leaves them to one - for what `work` says. */
  const startSpecDiff = (work: SpecDiffWork): { jobId: string; position: number; conformanceJobId?: string } => {
    const job = options.registry.start({
      kind: "render_spec_diff",
      summary: `${basename(work.plainFile)} render spec diff`,
      diff: work.diff,
      model: work.model,
      lanes: [...moduleLanes(codebaseOf(work.plainFile), options.buildDir)],
      run: async (onDelta) => {
        // Its turn: the modules below it have landed, so the work of this codebase is planned now.
        if (work.planLater === true) {
          for (const other of works.values()) if (other.codebase === work.codebase) other.planLater = false;
          // No longer waiting: what it is now comes from its plan.
          const job = options.registry.get(work.jobId!);
          if (job !== undefined) job.note = undefined;
          triggerMaster(work);
        }
        // The queue master may still be reworking the queue: it decides what this job renders, or whether it runs at all.
        await gateOf(work.codebase);
        if (work.superseded !== undefined) return { report: work.superseded, details: { passed: false, skipped: true, landed: false } };
        work.started = true;
        landStarts.set(work.jobId!, markWork([work.codebase]));
        return renderWork(work, onDelta);
      },
    });
    jobs.set(job.id, job);
    works.set(job.id, work);
    work.jobId = job.id;
    shown.push({ jobId: job.id, what: `spec diff: ${work.title}` });
    const position = shown.length;
    const conformanceJobId = work.conformanceLater
      ? queue.enqueueSpecDiffConformance({ plainFile: work.plainFile, diff: work.diff, applied: "already applied", spec: work.spec, cwd: work.cwd, inModule: work.inModule, model: work.requestModel, after: job.id }).jobId
      : undefined;
    return { jobId: job.id, position, conformanceJobId };
  };

  /**
   * A spec diff about to start whose job ahead did not land - stopped, or failed - would render only
   * its own change and then record the spec as built with the other's in it too: code and record
   * would disagree. So its diff is taken again, from what the code is built from to the spec it
   * leaves, and it says so. Nothing built yet is the empty spec: a first build's job ahead that did not
   * land - the scaffold of a new project - leaves the one behind it to build all of it, not only its own.
   */
  const rebaseIfBehind = (work: SpecDiffWork, jobId: string) => {
    if (work.before === undefined) return;
    // Nothing built here yet: what it starts from is the code of the module it requires, copied up when it renders.
    const built = readBuiltTree(work.codebase) ?? startsFrom(work.spec.chain, work.spec.tree) ?? {};
    const before = work.before ?? {};
    // Functional specs it would record as built that nothing builds: not built, and not in its own change - queued
    // behind a module build that stopped before them, say, which the queue does not follow.
    const carried = unbuiltNotInDiff(work, built);
    if (carried.length === 0 && (serializeTree(built) === serializeTree(before) || sameSpec(built, before))) return;
    let layout;
    try {
      layout = layoutOf(readFileSync(work.plainFile, "utf8"));
    } catch {
      /* the layout is only for how the diff reads */
    }
    const diff = diffSpecText(serializeTree(built), serializeTree(work.spec.tree), relative(work.cwd ?? options.cwd, work.plainFile), layout);
    if (diff.trim() === "") return;
    work.diff = diff;
    const job = options.registry.get(jobId);
    if (job !== undefined) {
      job.diff = diff;
      job.note =
        `${job.note !== undefined ? `${job.note} ` : ""}` +
        (carried.length > 0
          ? `Rebased when it started: its spec holds ${carried.length === 1 ? "a functional spec" : `${carried.length} functional specs`} not built and not in its change - ${carried.map((spec) => `"${spec.slice(0, 60)}"`).join(", ")} - so it renders everything from what the code is built from to its spec, ${carried.length === 1 ? "that one" : "those"} as well.`
          : "Rebased when it started: the job ahead of it did not land, so it renders everything from what the code is built from to its spec - that job's change as well.");
    }
  };

  /**
   * The functional specs a spec diff's pinned spec holds that the code is not built from and its own change does not
   * bring: it would record them as built, and nothing would have built them. Their first lines.
   */
  const unbuiltNotInDiff = (work: SpecDiffWork, built: MarshalledPlainSource): string[] => {
    const specs = (tree: MarshalledPlainSource) => ((tree[FUNCTIONAL_REQUIREMENTS] as Array<{ markdown: string }> | undefined) ?? []).map((item) => item.markdown.trim());
    const have = new Set(specs(built));
    const changed = work.diff.split("\n").filter((line) => line.startsWith("+")).map((line) => line.slice(1).trim()).join("\n");
    return specs(work.spec.tree)
      .filter((spec) => !have.has(spec))
      .map((spec) => spec.split("\n")[0]!.replace(/^- /, "").trim())
      .filter((first) => first !== "" && !changed.includes(first));
  };

  /** How a spec diff's conformance tests are run: by its conformance job, still to run; in its own render; or not at all. */
  const conformanceOf = (work: SpecDiffWork): "job" | "render" | "off" => {
    if (work.conformanceJobId !== undefined && isPending(options.registry.get(work.conformanceJobId)?.status)) return "job";
    if (!work.off && !work.conformanceLater && hasTestReqs(work.spec) && !conformanceOff(work.plainFile)) return "render";
    return "off";
  };

  /** A queued spec diff as the queue shows it, with how its conformance tests run. */
  const queueLine = (work: SpecDiffWork) => {
    const how = conformanceOf(work);
    const conformance = how === "job" ? `conformance tests: job ${work.conformanceJobId}` : how === "render" ? "conformance tests: in its own render" : "no conformance tests";
    return `- job ${work.jobId} · ${work.title} · ${conformance}${work.started ? " (running)" : ""}`;
  };

  /** Rework the queue around a new change: after whatever the queue master was already doing for that codebase. */
  const triggerMaster = (work: SpecDiffWork) => {
    // Built on a module whose own work has not landed yet: what it starts from is not known, so it is planned when
    // its turn comes - when its first job can start - not now, beside the modules below it.
    const waitsOn = belowPending(work);
    if (waitsOn !== undefined) {
      work.planLater = true;
      labelWaiting(work, waitsOn);
      return;
    }
    const previous = gateOf(work.codebase);
    masters.set(work.codebase, previous.then(() => runMaster(work.codebase)).then(() => {}).catch(() => {}));
  };

  /**
   * The queue master's turn: the spec diffs queued for the codebase - none of them started - reworked
   * around the new change, or as the person asked, as `reworkQueue` checks it. The running one stays
   * as it is; so does the queue when something other than spec diffs is queued for the codebase,
   * since those change what the code is built from in ways the master does not see. Says why it did
   * nothing, when it did nothing.
   */
  /**
   * Planning the queue, said where the person looks: its stages and what its agents do go on the jobs that wait
   * for it - the first of them shows each stage, all of them that they wait for the plan - and what it costs is
   * counted on the first. So a queue being planned is never a silence that looks like a hang.
   */
  const withPlanningShown = async <T,>(waiting: SpecDiffWork[], run: () => Promise<T>): Promise<T> => {
    const shownOn = waiting.map((work) => options.registry.get(work.jobId!)).filter((job): job is Job => job !== undefined);
    const first = shownOn[0];
    const say = (label: string) => {
      for (const job of shownOn) job.stage = job === first ? label : `waiting for the queue to be planned - ${label}`;
    };
    say("planning the queue: cutting the work into jobs");
    const sink: ActivitySink = {
      stage: say,
      activity(line) {
        if (first !== undefined) first.activity = [...first.activity, line].slice(-20);
      },
      now(label) {
        if (first !== undefined) first.now = label === undefined ? undefined : { label, since: Date.now() };
      },
      usage(spent) {
        if (first === undefined) return;
        first.usage = {
          input: first.usage.input + spent.input,
          output: first.usage.output + spent.output,
          cacheRead: first.usage.cacheRead + spent.cacheRead,
          cacheWrite: first.usage.cacheWrite + spent.cacheWrite,
          cost: first.usage.cost + spent.cost,
        };
      },
      transcript() {},
    };
    try {
      return await withActivity(sink, run);
    } finally {
      for (const job of shownOn) {
        if (job.stage?.includes("planned") || job.stage?.startsWith("planning the queue") || job.stage === "the queue master reviews the plan") job.stage = undefined;
        job.now = undefined;
      }
    }
  };

  const runMaster = async (codebase: string, instruction?: string): Promise<{ plan?: MasterPlan; why?: string }> => {
    const mine = [...works.values()].filter((work) => work.codebase === codebase && work.jobId !== undefined);
    const waiting = mine.filter(
      (work) => !work.started && !work.restructure && work.superseded === undefined && isPending(options.registry.get(work.jobId!)?.status),
    );
    // The queue as it is now - changes submitted since this turn was asked for included: the newest is the spec now.
    const latest = waiting.at(-1);
    if (latest === undefined) return { why: "no spec diff is waiting for this codebase - a running one is not reworked" };
    const seenSpec = lastSeen.get(codebase);
    // Already reworked around this spec, by an earlier turn that saw the same queue - compared as text: a rework rewrites the trees.
    if (instruction === undefined && seenSpec !== undefined && serializeTree(seenSpec) === serializeTree(latest.spec.tree)) return { why: "already reworked around this spec" };
    // Asked by the person, there is no new change: the spec before is the spec now.
    const previousSpec = instruction !== undefined ? latest.spec.tree : (seenSpec ?? waiting.at(-2)?.spec.tree);
    lastSeen.set(codebase, latest.spec.tree);
    // The spec diff rendering now: the master may stop it, so one waiting job beside it is a queue to rework.
    const running = mine.find((work) => work.started && work.superseded === undefined && options.registry.get(work.jobId!)?.status === "running");

    // A functionality render of this codebase - one on its lanes - changes what its code is built from; one of another module does not.
    const codebaseLanes = new Set(moduleLanes(codebaseOf(latest.plainFile), options.buildDir));
    // Functionality renders are in the queue it reworks; one it cannot see - its spec did not parse - it waits for.
    const otherWork =
      queued.some((entry) => !works.has(entry.jobId) && isPending(options.registry.get(entry.jobId)?.status) && (renderLanes.get(entry.jobId) ?? []).some((lane) => codebaseLanes.has(lane))) ||
      rebuilds.some((rebuild) => rebuild.codebase === codebase && isPending(options.registry.get(rebuild.jobId)?.status));
    if (otherWork) return { why: "functionality renders or a rebuild are queued for this codebase too - they change what the code is built from, so the spec diffs are left as they are" };
    const built = readBuiltTree(codebase);
    // Code with no record of the spec it was built from: what is built is not known, so the work cannot be planned
    // from it - the queue stays as it was queued, each change on top of the code as it is.
    if (built === null && running === undefined && instruction === undefined && listFiles(codebase).length > 0) return { why: "what the code is built from is not recorded, so the queue is left as it was queued" };
    // Nothing built yet: the work is from what the module it requires leaves, as it inherits it - or, requiring none, from nothing.
    const base = running?.spec.tree ?? built ?? startsFrom(latest.spec.chain, latest.spec.tree) ?? {};

    const specFile = relative(options.cwd, latest.plainFile);
    let specText = "";
    try {
      specText = readFileSync(latest.plainFile, "utf8");
    } catch {
      /* the layout is only for how the diffs read */
    }
    const input: MasterInput = {
      base,
      previous: previousSpec ?? base,
      current: latest.spec.tree,
      queued: waiting.map((work) => ({
        jobId: work.jobId!,
        title: work.title,
        tree: work.spec.tree,
        textDiff: work.diff,
        conformance: conformanceOf(work) !== "off",
        ...(conformanceOf(work) === "job" ? { conformanceJobId: work.conformanceJobId } : {}),
      })),
      specFile,
      specText,
      conformanceAvailable: !conformanceOff(latest.plainFile) && hasTestReqs(latest.spec),
      ...(instruction !== undefined ? { instruction } : {}),
      steering: steeringFor(latest.plainFile, waiting),
      ...(running !== undefined
        ? {
            running: {
              jobId: running.jobId!,
              title: running.title,
              tree: running.spec.tree,
              textDiff: running.diff,
              conformance: conformanceOf(running) !== "off",
              ...(conformanceOf(running) === "job" ? { conformanceJobId: running.conformanceJobId } : {}),
            },
            // Nothing built yet is the empty spec, so a first build can be stopped and started again too.
            built: built ?? {},
          }
        : {}),
    };
    // The work not started, cut into jobs from its functional specs outward - whatever the master then makes of it.
    // Said on the jobs that wait for it, so the queue is not a silence while it is planned.
    const plan = await withPlanningShown(waiting, async (): Promise<MasterPlan | undefined> => {
      const agents =
        options.chunkAgents ??
        (options.queueMaster === false || typeof options.queueMaster === "function" ? undefined : llmChunkAgents({ cwd: options.cwd, model: options.masterModel ?? latest.model, label: `${basename(latest.plainFile)} queue planner` }));
      const proposal = await planChunks(input, agents);
      // Only added on top, planned as it was queued - or no master: the plan is the queue, with no agent to ask.
      const asQueued = JSON.stringify(propose(input).filter((job) => job.changes.length > 0).map((job) => job.changes)) === JSON.stringify(proposal.map((job) => job.changes));
      if (options.queueMaster === false || (instruction === undefined && untouched(input) && asQueued)) {
        return proposal.length > 0 ? { jobs: stepsOf(input, proposal), summary: "The queue's work, cut into jobs from its functional specs.", by: "proposal", base: input.base } : undefined;
      }
      reportStage("the queue master reviews the plan");
      return reworkQueue({
        input,
        agent: options.queueMaster ?? llmQueueMaster({ cwd: options.cwd, model: options.masterModel ?? latest.model, label: `${basename(latest.plainFile)} queue master` }),
        askPerson: options.askPerson,
        proposal,
      });
    });
    if (plan === undefined) return { why: "there is nothing to build" };
    // Stopped by the master: it ends, its work so far is rolled back - before any queued job starts, since they wait
    // for this turn - and its change is in the plan's jobs now.
    if (plan.stopRunning !== undefined && running !== undefined) await stopRunningWork(running, plan);
    // Starting jobs reads their chains: once per file for all of them.
    withParseCache(() => applyPlan(waiting, plan, plan.base, plan.stopRunning !== undefined ? running : undefined));
    return { plan };
  };

  /** Stop the running spec diff and its conformance job, wait for it to end, and put its module back at its last commit. */
  const stopRunningWork = async (running: SpecDiffWork, plan: MasterPlan) => {
    running.superseded = `Stopped while running, by the queue master: ${plan.stopRunning!.reason}.`;
    options.registry.stop(running.jobId!);
    if (running.conformanceJobId !== undefined) {
      options.registry.stop(running.conformanceJobId);
      const conformance = options.registry.get(running.conformanceJobId);
      if (conformance !== undefined) {
        conformance.note = `Not run: the spec diff it follows, job ${running.jobId}, was stopped by the queue master.`;
        conformance.error = conformance.note;
      }
    }
    try {
      await options.registry.wait(running.jobId!);
    } catch {
      // Stopped is what it was asked to be.
    }
    // Finished just as it was stopped, it landed: the next job starts from what it built, and takes its diff again from there.
    const details = options.registry.get(running.jobId!)?.details as { landed?: boolean } | undefined;
    running.landedAnyway = details?.landed === true;
    // What it wrote and never committed is gone: the code, its tests and the record agree again.
    resetToLastCommit(running.codebase);
  };

  /**
   * Make the queue what the plan says. A planned job runs as the queued job it came from where the
   * order allows - that job keeps its place and its id - and otherwise in the place of one the plan
   * left out; what is left over goes on after them, as new jobs. The queued jobs no planned one runs
   * as are stopped, saying where their change went.
   */
  /**
   * Queue again, at the back, the jobs not started of every module built on `codebase` - so they come after the jobs
   * just added for it, as the modules they are built on have to. Each is planned again when its turn comes.
   */
  const requeueAbove = (codebase: string) => {
    const above = [...works.values()]
      .filter((work) => !work.started && work.superseded === undefined && work.jobId !== undefined && isPending(options.registry.get(work.jobId)?.status))
      .filter((work) => work.spec.chain.slice(0, -1).some((entry) => entry.buildDir === codebase))
      .sort((a, b) => (options.registry.get(a.jobId!)?.sequence ?? 0) - (options.registry.get(b.jobId!)?.sequence ?? 0));
    for (const work of above) {
      const previous = { jobId: work.jobId!, conformanceJobId: work.conformanceJobId };
      const again: SpecDiffWork = { ...work, jobId: undefined, conformanceJobId: undefined, planLater: true };
      const { jobId } = startSpecDiff(again);
      labelWaiting(again, belowPending(again) ?? basename(dirname(codebase)));
      const note = `Queued again as job ${jobId}: the module it is built on was planned into more jobs, and it comes after them.`;
      work.superseded = note;
      for (const id of [previous.jobId, previous.conformanceJobId]) {
        if (id === undefined) continue;
        // Marked first, so it is not announced as stopped when the stop settles.
        const job = options.registry.get(id);
        if (job !== undefined) {
          job.replacedBy = id === previous.jobId ? jobId : again.conformanceJobId ?? jobId;
          job.note = note;
          job.error = note;
        }
        options.registry.stop(id);
      }
    }
  };

  /** A planned job's name: its file, the functional specs it adds - "fs 3-5" - and its title. */
  const planName = (plainFile: string, before: MarshalledPlainSource, after: MarshalledPlainSource, title: string) => {
    const count = (tree: MarshalledPlainSource) => ((tree[FUNCTIONAL_REQUIREMENTS] as unknown[] | undefined) ?? []).length;
    const from = count(before) + 1;
    const to = count(after);
    const specs = to >= from ? (to === from ? `fs ${from}` : `fs ${from}-${to}`) : "spec diff";
    return `${basename(plainFile)} ${specs}: ${title.slice(0, 70)}`;
  };

  const applyPlan = (waiting: SpecDiffWork[], plan: MasterPlan, base: MarshalledPlainSource, stoppedRunning?: SpecDiffWork) => {
    const by = plan.by === "master" ? "the queue master" : "the harness";
    const claimed = new Map(plan.jobs.map((planned, index) => [planned.jobId, index] as const).filter(([id]) => id !== undefined));
    const slotOf = (id: string | undefined) => waiting.findIndex((work) => work.jobId === id);
    const placed: Array<{ planned: MasterPlan["jobs"][number]; work?: SpecDiffWork }> = [];
    let next = 0;
    plan.jobs.forEach((planned, index) => {
      const own = slotOf(planned.jobId);
      if (own >= next) {
        placed.push({ planned, work: waiting[own] });
        next = own + 1;
        return;
      }
      // A place no later planned job runs as, before the next one that keeps its own - else the next place there is.
      const nextOwn = plan.jobs.slice(index + 1).map((later) => slotOf(later.jobId)).find((slot) => slot >= next) ?? waiting.length;
      let free = -1;
      for (let slot = next; slot < nextOwn; slot += 1) {
        const wanted = claimed.get(waiting[slot]!.jobId);
        if (wanted === undefined || wanted < index) {
          free = slot;
          break;
        }
      }
      const at = free !== -1 ? free : next < waiting.length ? next : -1;
      placed.push({ planned, work: at === -1 ? undefined : waiting[at] });
      if (at !== -1) next = at + 1;
    });

    const used = new Set(placed.map((entry) => entry.work).filter((work): work is SpecDiffWork => work !== undefined));
    const taken: string[] = stoppedRunning !== undefined ? [stoppedRunning.jobId!] : [];
    // The planned jobs that went on after the queue as new jobs, and their ids.
    const started = new Map<MasterPlan["jobs"][number], string>();
    const rewritten: string[] = [];
    let before = base;
    for (const { planned, work } of placed) {
      const step = planned.step;
      const from = planned.jobId !== undefined && planned.jobId !== work?.jobId ? ` - the change job ${planned.jobId} was queued with` : "";
      if (work === undefined) {
        // More jobs than there are places: they go on after them, in order.
        const withTests = planned.conformance === true && hasTestReqs(waiting.at(-1)!.spec) && !conformanceOff(waiting.at(-1)!.plainFile);
        const extra: SpecDiffWork = { ...waiting.at(-1)!, render: undefined, title: planned.title, diff: step.textDiff, applied: "already applied", spec: { ...waiting.at(-1)!.spec, tree: step.tree }, started: false, jobId: undefined, conformanceJobId: undefined, superseded: undefined, before, off: !withTests, conformanceLater: withTests };
        const { jobId } = startSpecDiff(extra);
        rewritten.push(jobId);
        started.set(planned, jobId);
        const job = options.registry.get(jobId);
        if (job !== undefined) {
          job.note = `${from === "" ? "Inserted" : "Moved here"} by ${by}: ${planned.title}${from}.`;
          job.summary = planName(extra.plainFile, before, step.tree, planned.title);
        }
        before = step.tree;
        continue;
      }
      // Changed is what it builds: from another spec, or to another. Its diff as text is no measure - the one the
      // plan rebuilds from the trees reads differently from the one it was queued with, for the same change.
      const sameTree = (a: MarshalledPlainSource | null | undefined, b: MarshalledPlainSource | null | undefined) => serializeTree(a ?? {}) === serializeTree(b ?? {});
      const changed = !sameTree(work.spec.tree, step.tree) || (work.before !== undefined && !sameTree(work.before, before));
      if (changed) rewritten.push(work.jobId!);
      // Not renamed by the master: named for what it now renders, not for what it was queued with.
      work.title = planned.title === work.title && changed ? summarizeDiff(step.textDiff) : planned.title;
      // Unchanged, it keeps the diff it was queued with.
      if (changed) work.diff = step.textDiff;
      work.applied = "already applied";
      work.spec = { ...work.spec, tree: step.tree };
      const namedFrom = before;
      work.before = before;
      before = step.tree;
      const job = options.registry.get(work.jobId!);
      if (job !== undefined) {
        job.diff = work.diff;
        job.summary = planName(work.plainFile, namedFrom, step.tree, work.title);
        // What it renders now, in a line of its own: what the whole turn did is said once, in the conversation.
        if (from !== "") job.note = `Now renders "${planned.title}"${from}, by ${by}.`;
        else if (changed) job.note = `Reworked by ${by} - it now renders ${work.title}.`;
        // A functionality render moved in the list - one before it taken out - is named by where it is now.
        if (work.render !== undefined) {
          const position = ((step.tree[FUNCTIONAL_REQUIREMENTS] as unknown[] | undefined) ?? []).length;
          if (position > 0 && String(position) !== work.render.frid) job.summary = `${basename(work.plainFile)} fs ${position} (was ${work.render.frid})`;
        }
      }
      if (work.conformanceJobId !== undefined) {
        const conformance = options.registry.get(work.conformanceJobId);
        if (conformance !== undefined) conformance.diff = work.diff;
      }
      // Its conformance tests, as the plan has them: a conformance job cancelled, or the tests written in its own render.
      const how = conformanceOf(work);
      if (planned.conformance !== true && how !== "off") {
        if (how === "job") {
          const cancelled = `Cancelled by ${by}: its spec diff, job ${work.jobId}, renders on its unit tests alone. ${plan.summary}`;
          options.registry.stop(work.conformanceJobId!);
          const conformance = options.registry.get(work.conformanceJobId!);
          if (conformance !== undefined) {
            conformance.note = cancelled;
            conformance.error = cancelled;
          }
          taken.push(work.conformanceJobId!);
        }
        work.off = true;
        work.conformanceLater = false;
        if (!rewritten.includes(work.jobId!)) rewritten.push(work.jobId!);
        if (job !== undefined) job.note = `${job.note !== undefined ? `${job.note} ` : ""}Conformance tests off, by ${by}: it renders on its unit tests alone.`;
      } else if (planned.conformance === true && how === "off" && hasTestReqs(work.spec) && !conformanceOff(work.plainFile)) {
        work.off = false;
        work.conformanceLater = false;
        if (!rewritten.includes(work.jobId!)) rewritten.push(work.jobId!);
        if (job !== undefined) job.note = `${job.note !== undefined ? `${job.note} ` : ""}Conformance tests on, by ${by}: it writes and runs them in its own render.`;
      }
    }
    // Jobs added for this codebase run after everything queued so far - the modules built on it too, which have to
    // wait for them: those not started are queued again, behind them.
    if (started.size > 0) requeueAbove(waiting[0]!.codebase);
    // The queued jobs no planned job runs as: their change is undone, or runs in another job.
    const where = new Map(placed.map((entry) => [entry.planned.jobId, entry.work?.jobId ?? started.get(entry.planned)]));
    for (const work of waiting) {
      if (used.has(work)) continue;
      const moved = where.get(work.jobId);
      const into = moved !== undefined
        ? `its change runs as job ${moved}, moved there by ${by}`
        : plan.jobs.length > 0
          ? `taken out by ${by}: its change is undone by a later one, or is part of ${[...used].map((kept) => kept.jobId).join(", ")}`
          : `cancelled by ${by}: the queued changes together change nothing the code is not already built from`;
      work.superseded = `Not run - ${into}. ${plan.summary}`;
      taken.push(work.jobId!);
      for (const id of [work.jobId, work.conformanceJobId]) {
        if (id === undefined) continue;
        options.registry.stop(id);
        const job = options.registry.get(id);
        if (job !== undefined) {
          job.note = work.superseded;
          job.error = work.superseded;
        }
      }
    }
    // The running job it stopped: where its change went.
    if (stoppedRunning !== undefined) {
      const into = where.get(stoppedRunning.jobId);
      const note = stoppedRunning.landedAnyway === true
        ? `Stopped while running, by ${by}: ${plan.stopRunning?.reason ?? ""}. It finished before the stop took, and landed: the next job renders from what it built. ${plan.summary}`
        : `Stopped while running, by ${by}: ${plan.stopRunning?.reason ?? ""}. What it had done is rolled back; ${into !== undefined ? `its change runs as job ${into}` : "its change is undone by a later one"}. ${plan.summary}`;
      stoppedRunning.superseded = note;
      const job = options.registry.get(stoppedRunning.jobId!);
      if (job !== undefined) {
        job.note = note;
        job.error = note;
      }
    }
    // A turn that changed the queue is told: to the tool that queued the change, and to the person.
    if (taken.length > 0 || rewritten.length > 0) {
      const codebase = waiting[0]!.codebase;
      turns.set(codebase, { count: (turns.get(codebase)?.count ?? 0) + 1, summary: plan.summary, by, taken, rewritten });
      const report = describeTurn(codebase);
      if (report !== undefined) options.onRework?.(report);
    }
  };

  /** What a queue master's turn did to a codebase's queue, in a few lines - for the tool that queued the change, and the person. */
  const describeTurn = (codebase: string, jobId?: string): string | undefined => {
    const turn = turns.get(codebase);
    if (turn === undefined) return undefined;
    const work = jobId !== undefined ? works.get(jobId) : undefined;
    const now = [...works.values()]
      .filter((item) => item.codebase === codebase && item.jobId !== undefined && item.superseded === undefined && isPending(options.registry.get(item.jobId)?.status))
      .map(queueLine);
    const own =
      work === undefined
        ? []
        : work.superseded !== undefined
          ? [`Job ${jobId}, this change, does not run as a job of its own: ${work.superseded.replace(/^Not run - /, "")}`]
          : turn.rewritten.includes(jobId!)
            ? [`Job ${jobId}, this change, was reworked: ${options.registry.get(jobId!)?.note ?? turn.summary}`]
            : [`Job ${jobId}, this change, runs as it was queued.`];
    const others = turn.taken.filter((id) => id !== jobId);
    const changed = turn.rewritten.filter((id) => id !== jobId);
    return [
      `The queue master reworked the queue${turn.by === "the harness" ? " (the harness's plan, the master's did not check)" : ""}: ${turn.summary}`,
      ...own,
      ...(others.length > 0 ? [`Taken out, never to run: ${others.map((id) => `job ${id}`).join(", ")}.`] : []),
      ...(changed.length > 0 ? [`Rewritten to render the change as it now is: ${changed.map((id) => `job ${id}`).join(", ")}.`] : []),
      now.length > 0 ? `The spec diffs queued for it now, in the order they run:\n${now.join("\n")}` : "No spec diff is queued for it now.",
    ].join("\n");
  };

  /** Whether a spec as parsed has test reqs, which conformance tests are written from. */
  const hasTestReqs = (spec: SpecSnapshot) => (sectionsOf(spec.tree)[TEST_REQUIREMENTS] ?? []).length > 0;

  /** The tree a codebase is built from once what is queued for it has landed: the last spec diff's, else what is built. */
  const treeAhead = (codebase: string): MarshalledPlainSource | null => {
    // The last job still to land on the codebase - a spec diff, or a functionality render - by the order they were queued.
    const pending = (jobId: string | undefined) => jobId !== undefined && isPending(options.registry.get(jobId)?.status);
    const candidates = [...works.values()]
      .filter((work) => work.codebase === codebase && work.superseded === undefined && pending(work.jobId))
      .map((work) => ({ jobId: work.jobId!, tree: work.spec.tree }));
    const last = candidates.sort((a, b) => (options.registry.get(a.jobId)?.sequence ?? 0) - (options.registry.get(b.jobId)?.sequence ?? 0)).at(-1);
    return last?.tree ?? readBuiltTree(codebase);
  };

  /**
   * What a module nothing is built of starts from: the code of the module it requires, copied up, and so what that
   * module leaves - its queued work, or what is built - as it inherits it: that module's functional specs, and every
   * definition and req of its own spec that code already implements. Null when it requires none, or that one is not
   * built or queued either.
   */
  const startsFrom = (chain: ChainEntry[], spec: MarshalledPlainSource): MarshalledPlainSource | null => {
    const tip = chain.at(-1);
    if (tip === undefined || tip.requires === null) return null;
    const source = chain.find((entry) => entry.moduleName === tip.requires);
    if (source === undefined) return null;
    const left = treeAhead(source.buildDir);
    return left === null ? null : inheritedTree(left, source.moduleName, spec);
  };

  /**
   * The steering a plan of this codebase follows: the conversation's and AGENTS.md's, then what each job waiting in it
   * was queued with - once each.
   */
  const steeringFor = (plainFile: string, waiting: SpecDiffWork[]): Steering[] => {
    let given: Steering[] = [];
    try {
      given = options.steering?.(plainFile) ?? [];
    } catch {
      // Steering that cannot be read is no steering: the plan goes on without it.
    }
    const requested = waiting
      .filter((work) => work.guidance !== undefined)
      .map((work) => ({ source: `the request that queued job ${work.jobId}`, text: work.guidance! }));
    const seen = new Set<string>();
    return [...given, ...requested].filter((entry) => {
      const key = entry.text.trim();
      if (key === "" || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  /**
   * Say on a job not planned yet what it is: one job with the module's whole diff, until it is planned, would read as
   * the module built at once.
   */
  const labelWaiting = (work: SpecDiffWork, waitsOn: string) => {
    const job = work.jobId !== undefined ? options.registry.get(work.jobId) : undefined;
    if (job === undefined) return;
    job.summary = `${basename(work.plainFile)} - planned into jobs once ${waitsOn} has landed`;
    job.note = `Not planned yet: this is everything not built of ${work.spec.moduleName}, as one change. It is cut into jobs of one to three functional specs when its turn comes - once ${waitsOn}, the module it is built on, has landed - from what that module's code implements.`;
  };

  /** The nearest module below this one in the chain with work still to land, if any: this one's work is planned once it has. */
  const belowPending = (work: SpecDiffWork): string | undefined => {
    const below = work.spec.chain.slice(0, -1);
    const pending = new Set(
      [...works.values()]
        .filter((other) => other.superseded === undefined && other.jobId !== undefined && isPending(options.registry.get(other.jobId)?.status))
        .map((other) => other.codebase),
    );
    return [...below].reverse().find((entry) => pending.has(entry.buildDir))?.moduleName;
  };

  /** A functionality render as a work: its change - that functionality added - from what the code will be built from by then. */
  const renderAsWork = (request: RenderRequest & { plainFile: string; model?: string }, pinned: PinnedSpec, codebase: string, model: string | undefined): SpecDiffWork | undefined => {
    let after: MarshalledPlainSource;
    let chain: ChainEntry[];
    try {
      const before = treeAhead(codebase);
      after = withBuiltFunctionality(before, pinned.tree, request.frid);
      chain = request.regenerate ? findCodebaseTip(request.plainFile).chain : resolveRequiresChain(request.plainFile, [], options.buildDir);
      let layout;
      try {
        layout = layoutOf(readFileSync(request.plainFile, "utf8"));
      } catch {
        /* the layout is only for how the diff reads */
      }
      const diff = diffSpecText(serializeTree(before ?? {}), serializeTree(after), relative(options.cwd, request.plainFile), layout);
      const spec = (pinned.tree[FUNCTIONAL_REQUIREMENTS] as Array<{ markdown: string }> | undefined)?.[Number(request.frid) - 1]?.markdown ?? "";
      const off = conformanceOff(request.plainFile);
      return {
        plainFile: request.plainFile,
        title: `functionality ${request.frid}${request.regenerate ? " (rebuild)" : ""}: ${spec.replace(/^- /, "").split("\n")[0]!.slice(0, 80)}`,
        diff,
        applied: "already applied",
        spec: { moduleName: pinned.moduleName, plainFile: request.plainFile, tree: after, chain },
        model,
        requestModel: request.model,
        off,
        conformanceLater: false,
        codebase,
        started: false,
        before,
        turnAt: turns.get(codebase)?.count ?? 0,
        render: { original: serializeTree(after), off, frid: request.frid },
        ...(request.guidance !== undefined && request.guidance.trim() !== "" ? { guidance: request.guidance.trim() } : {}),
      };
    } catch {
      // A functionality the pinned spec does not have fails in the render, with its own error.
      return undefined;
    }
  };

  /** One codebase's part of a spec diff: a render, a restructuring to record, or a rebuild from scratch. */
  const enqueuePart = (request: SpecDiffRequest, part: SpecDiffPart, index: number, count: number): QueuedSpecDiffPart => {
    const tip = part.spec.chain.at(-1)!;
    const codebase = tip.buildDir;
    const off = request.conformance === false || conformanceOff(part.plainFile);
    const split = count > 1 ? `Part ${index + 1} of ${count} of one spec diff - the part that lands in ${tip.moduleName}'s codebase (${part.files.join(", ")}).` : undefined;

    // Specs split into a module the code was not built on: no change to the code brings that in.
    const fresh = newlyRequired(part.spec.chain);
    if (fresh !== undefined) return enqueueRebuild(request, part, tip, fresh, off, split);

    // Nothing but a new layout of the same spec - definitions moved to a common module, say: nothing to render.
    const before = treeAhead(codebase);
    const restructure = before !== null && sameSpec(before, part.spec.tree);
    let diff = part.diff;
    let fromNothing = false;
    if (!restructure && request.wholeIfUnbuilt === true && listFiles(codebase).length === 0 && readBuiltTree(codebase) === null && ![...works.values()].some((work) => work.codebase === codebase)) {
      // The files the modules below it read are built there already, and come with their code.
      const below = part.spec.chain.slice(0, -1).flatMap((entry) => specFilesOf(entry.plainFile));
      const whole = wholeSpecDiff(tip.plainFile, request.cwd ?? options.cwd, [], below);
      if (whole.trim() !== "") {
        diff = whole;
        fromNothing = true;
      }
    }
    const model = request.model ?? modelOf("spec_changes", part.plainFile);
    const work: SpecDiffWork = {
      plainFile: part.plainFile,
      title: summarizeDiff(diff),
      diff,
      applied: request.applied,
      spec: part.spec,
      cwd: request.cwd,
      inModule: request.inModule,
      model,
      requestModel: request.model,
      off,
      // A restructuring changes nothing its tests check.
      conformanceLater: !off && !restructure && hasTestReqs(part.spec),
      codebase,
      started: false,
      restructure,
      before,
      turnAt: turns.get(codebase)?.count ?? 0,
      ...(request.guidance !== undefined && request.guidance.trim() !== "" ? { guidance: request.guidance.trim() } : {}),
    };
    const started = startSpecDiff(work);
    const job = options.registry.get(started.jobId);
    if (job !== undefined) {
      if (restructure) job.summary = `${basename(part.plainFile)} spec restructured - nothing to render`;
      const notes = [
        ...(split !== undefined ? [split] : []),
        ...(restructure ? ["The specs are only laid out differently - the code is built from the same spec - so nothing is rendered: the spec is recorded as it is now laid out."] : []),
      ];
      if (notes.length > 0) job.note = notes.join(" ");
    }
    // A new change: the queue master reworks what is queued for this codebase around it, before any of it starts.
    if (!restructure) triggerMaster(work);
    return { jobId: started.jobId, what: restructure ? "restructure" : "render", module: tip.moduleName, files: part.files, fromNothing, conformanceJobId: started.conformanceJobId };
  };

  /** Build the codebase again from scratch, on the module it now requires - once, however many changes ask for it before it starts. */
  const enqueueRebuild = (request: SpecDiffRequest, part: SpecDiffPart, tip: ChainEntry, fresh: { modules: string[]; rebuild: ChainEntry[] }, off: boolean, split: string | undefined): QueuedSpecDiffPart => {
    const waiting = rebuilds.find((rebuild) => rebuild.codebase === tip.buildDir && options.registry.get(rebuild.jobId)?.status === "queued");
    // Built from the files as they are when it starts, so this change is in it.
    if (waiting !== undefined) return { ...waiting.part, files: part.files };
    const model = request.model ?? modelOf("functionalities", tip.plainFile);
    const again = fresh.rebuild.map((entry) => entry.moduleName).join(", ");
    const job = options.registry.start({
      kind: "render_module",
      summary: `${basename(tip.plainFile)} from scratch - it now requires ${fresh.modules.join(", ")}`,
      model,
      lanes: [...moduleLanes(tip.plainFile, options.buildDir)],
      run: (onDelta) => rebuildRunner({ plainFile: tip.plainFile, model, ...(off ? { conformance: false as const } : {}) }, onDelta),
    });
    job.note = [
      ...(split !== undefined ? [split] : []),
      `Not a spec diff: ${tip.moduleName} now requires ${fresh.modules.join(", ")}, which its code was not built on. ${fresh.modules.join(", ")} is built first, then ${again} again from scratch on it.`,
    ].join(" ");
    jobs.set(job.id, job);
    shown.push({ jobId: job.id, what: `${tip.moduleName} from scratch, on ${fresh.modules.join(", ")}` });
    const queuedPart: QueuedSpecDiffPart = { jobId: job.id, what: "rebuild", module: tip.moduleName, files: part.files, fromNothing: false, newlyRequired: fresh.modules };
    rebuilds.push({ jobId: job.id, codebase: tip.buildDir, part: queuedPart });
    return queuedPart;
  };

  const queue: RenderQueue = {
    enqueueSpecDiff(request) {
      const plainFile = resolve(options.cwd, request.plainFile);
      const cwd = resolve(request.cwd ?? options.cwd);
      // One job per codebase the change lands in, bottom of the chain first - unless the codebase was named.
      const parts: SpecDiffPart[] =
        request.inModule !== undefined
          ? [{ plainFile, diff: request.diff, spec: request.spec, files: [] }]
          : splitSpecDiff({ plainFile, diff: request.diff, spec: request.spec, cwd });
      const queuedParts = parts.map((part, index) => enqueuePart(request, { ...part, plainFile: resolve(cwd, part.plainFile) }, index, parts.length));
      const first = queuedParts[0]!;
      return { jobId: first.jobId, position: shown.findIndex((entry) => entry.jobId === first.jobId) + 1, conformanceJobId: first.conformanceJobId, parts: queuedParts };
    },

    enqueueSpecDiffConformance(request) {
      const plainFile = resolve(options.cwd, request.plainFile);
      const model = request.model ?? modelOf("spec_changes", plainFile);
      // Following a spec diff this queue renders: its diff and spec are that render's, as the queue master leaves them.
      const follows = request.after !== undefined ? works.get(request.after) : undefined;
      const job = options.registry.start({
        kind: "render_spec_diff_conformance",
        summary: `${basename(plainFile)} spec diff conformance`,
        diff: request.diff,
        model,
        follows: request.after,
        lanes: [...moduleLanes(codebaseOf(plainFile), options.buildDir)],
        run: async (onDelta) => {
          if (follows !== undefined) await gateOf(follows.codebase);
          if (follows?.superseded !== undefined) return { report: follows.superseded, details: { passed: false, skipped: true } };
          if (conformanceOff(plainFile)) return { report: offNote, details: { passed: false, skipped: true } };
          const skipped = notFollowing(request.after);
          if (skipped !== undefined) return { report: skipped, details: { passed: false, skipped: true } };
          const result = await renderSpecDiffConformance({
            plainFile,
            diff: follows?.diff ?? request.diff,
            ...(follows?.changeText !== undefined ? { change: follows.changeText } : {}),
            cwd: request.cwd ?? options.cwd,
            inModule: request.inModule,
            applied: follows !== undefined ? "already applied" : request.applied,
            spec: follows?.spec ?? request.spec,
            model,
            onDelta,
          });
          return { report: withTryItLine(describeSpecDiffConformance(result), result.passed), details: { passed: result.passed, stoppedAt: result.stoppedAt } };
        },
      });
      jobs.set(job.id, job);
      conformanceJobs.set(job.id, plainFile);
      if (follows !== undefined) follows.conformanceJobId = job.id;
      if (request.after !== undefined) undoWhenConformanceFails(job.id, request.after);
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
        lanes: [...moduleLanes(suite.buildDir === undefined ? codebaseOf(plainFile) : plainFile, suite.buildDir ?? options.buildDir)],
        run: async (onDelta) => {
          const skipped = notFollowing(after);
          if (skipped !== undefined) return { report: skipped, details: { passed: false, skipped: true } };
          if (conformanceOff(plainFile)) return { report: offNote, details: { passed: false, skipped: true } };
          const result = await renderConformanceSuite({ ...suite, plainFile, model, onDelta });
          return { report: withTryItLine(describeConformanceSuite(result), result.passed), details: { passed: result.passed } };
        },
      });
      jobs.set(job.id, job);
      conformanceJobs.set(job.id, plainFile);
      if (after !== undefined) undoWhenConformanceFails(job.id, after);
      shown.push({ jobId: job.id, what: `conformance: ${scope}` });
      return { jobId: job.id, position: shown.length };
    },

    enqueue(request) {
      const plainFile = resolve(options.cwd, request.plainFile);
      const model = request.model ?? modelOf("functionalities", plainFile);
      // The spec as it is now, with this render asked for: what it builds, whatever is written after it.
      const pinned = request.pinned ?? pinSpec(plainFile);
      const codebase = request.regenerate ? codebaseDirOf(plainFile) : ownBuildDir(plainFile, pinned);

      // Its conformance tests are a job of their own, right behind it - when the project has them on and the
      // module has the test reqs they are written from. A regeneration's bring its tests in line and run the whole suite.
      const withConformance = !conformanceOff(plainFile) && moduleHasTestReqs(plainFile);
      const asRequested = { ...request, plainFile, model, conformanceLater: withConformance, ...(pinned !== undefined ? { pinned } : {}) };
      const jobRef = { id: "" };
      // The render as the queue master sees it: the work of adding its functionality, from what the code will be built
      // from when its turn comes to the pinned spec's - which the master may rework like any spec diff.
      const work = pinned !== undefined && codebase !== undefined ? renderAsWork(asRequested, pinned, codebase, model) : undefined;
      const job = options.registry.start({
        kind: request.regenerate ? "regenerate" : "render",
        model,
        // Short enough to read in a one-line queue: the file's name, not its path.
        summary: `${basename(plainFile)} fs ${request.frid}${request.regenerate ? " (rebuild)" : ""}`,
        lanes: renderLanesOf(request.regenerate ? codebaseOf(plainFile) : plainFile),
        // What it builds, as a diff - from what the code will be built from by its turn to the spec with it in - so a
        // queued render shows what it adds, not only its number. The queue master's reworks keep it current.
        ...(work !== undefined ? { diff: work.diff } : {}),
        run: async (onDelta) => {
          // Where it started, for its conformance job to take it back to.
          const landsIn = work?.codebase ?? codebase;
          if (landsIn !== undefined) landStarts.set(jobRef.id, markWork([landsIn]));
          if (work === undefined) return runRender(asRequested, onDelta);
          // The queue master may be reworking the queue: it decides what this job renders, or whether it runs at all.
          await gateOf(work.codebase);
          if (work.superseded !== undefined) return { report: work.superseded, details: { passed: false, skipped: true, landed: false } };
          work.started = true;
          // As queued: the render it was asked for. A render is a spec diff that adds one functionality: reworked onto
          // another spec - a req changed ahead of it - but still only adding its own functionality to what is built, it
          // is still that render, on the spec as it now is. Anything more, and it renders as a spec diff, and writes its
          // conformance tests itself.
          if (serializeTree(work.spec.tree) === work.render!.original && work.off === work.render!.off) return runRender(asRequested, onDelta);
          if (work.off === work.render!.off && addsOnlyFunctionality(readBuiltTree(work.codebase), work.spec.tree, request.frid)) {
            return runRender({ ...asRequested, pinned: { moduleName: asRequested.pinned?.moduleName ?? work.spec.moduleName, tree: work.spec.tree } }, onDelta);
          }
          if (work.conformanceJobId !== undefined && isPending(options.registry.get(work.conformanceJobId)?.status)) {
            const note = `Not run: the render it follows, job ${work.jobId}, was reworked into a spec diff, which writes its conformance tests itself.`;
            options.registry.stop(work.conformanceJobId);
            const conformance = options.registry.get(work.conformanceJobId);
            if (conformance !== undefined) {
              conformance.note = note;
              conformance.error = note;
            }
          }
          work.conformanceLater = false;
          return renderWork(work, onDelta);
        },
      });
      jobRef.id = job.id;
      renderLanes.set(job.id, renderLanesOf(request.regenerate ? codebaseOf(plainFile) : plainFile));
      if (work !== undefined) {
        work.jobId = job.id;
        works.set(job.id, work);
      }

      jobs.set(job.id, job);

      // Stored resolved, so the same file named two ways is recognised as one.
      shown.push({ jobId: job.id, what: `functionality ${request.frid}${request.regenerate ? " (rebuild)" : ""}`, frid: request.frid });
      const entry: QueuedRender = { ...request, plainFile, jobId: job.id, position: shown.length };
      queued.push(entry);

      if (withConformance) {
        const conformance = queue.enqueueConformance({
          plainFile,
          frids: [request.frid],
          scope: `functionality ${request.frid}${request.regenerate ? " (rebuild)" : ""}`,
          model: request.model,
          buildDir: options.buildDir,
          after: job.id,
          // A regeneration ran no suite of its own: its tests, brought in line with the new spec, and then the whole suite.
          ...(request.regenerate === true ? { regression: true } : {}),
          ...(pinned !== undefined ? { pinned } : {}),
        });
        if (work !== undefined) work.conformanceJobId = conformance.jobId;
        entry.conformanceJobId = conformance.jobId;
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

    bringUpTo(plainFile, bring = {}) {
      const file = resolve(options.cwd, plainFile);
      const chain = resolveRequiresChain(file, [], options.buildDir, { allowNoFunctionalities: true });
      const entries = bring.only === true ? chain.slice(-1) : chain;
      const brought: BroughtUp = { modules: [], jobIds: [] };
      for (const entry of entries) {
        const pinned = pinSpec(entry.plainFile);
        if (pinned === undefined) continue;
        const codebase = entry.buildDir;
        const ahead = treeAhead(codebase);
        const now = pinned.tree;
        const covered = coveredPrefix(ahead, now);
        const nowSpecs = (now[FUNCTIONAL_REQUIREMENTS] as unknown[] | undefined) ?? [];
        const module: BroughtUp["modules"][number] = { module: entry.moduleName, renders: [], upToDate: false };
        // Everything from what is built or queued to the spec as it is now - up to `to` - as one spec diff: the queue
        // cuts it into jobs from its functional specs outward (chunk-plan.ts), per codebase it lands in.
        const last = bring.to !== undefined && entry === entries.at(-1) ? Math.min(Number(bring.to), nowSpecs.length) : nowSpecs.length;
        const target = { ...now, [FUNCTIONAL_REQUIREMENTS]: nowSpecs.slice(0, Math.max(covered, last)) } as MarshalledPlainSource;
        const from = ahead ?? startsFrom(chain.slice(0, chain.indexOf(entry) + 1), target) ?? {};
        if (serializeTree(target) !== serializeTree(from) && (ahead === null || !sameSpec(ahead, target))) {
          let layout;
          try {
            layout = layoutOf(readFileSync(entry.plainFile, "utf8"));
          } catch {
            /* the layout is only for how the diff reads */
          }
          const diff = diffSpecText(serializeTree(from), serializeTree(target), relative(options.cwd, entry.plainFile), layout);
          const queuedDiff = queue.enqueueSpecDiff({
            plainFile: entry.plainFile,
            diff,
            applied: "already applied",
            spec: { moduleName: entry.moduleName, plainFile: entry.plainFile, tree: target, chain: chain.slice(0, chain.indexOf(entry) + 1) },
            ...(bring.model !== undefined ? { model: bring.model } : {}),
            ...(bring.guidance !== undefined ? { guidance: bring.guidance } : {}),
          });
          module.specDiff = queuedDiff.jobId;
          brought.jobIds.push(...queuedDiff.parts.map((part) => part.jobId));
        }
        module.upToDate = module.specDiff === undefined && module.renders.length === 0;
        brought.modules.push(module);
      }
      return brought;
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
      // Every job queued so far - side by side, the last queued is not the last to finish - and any the queue master added while they ran.
      for (let seen = 0; seen < jobs.size; ) {
        const ids = [...jobs.keys()];
        seen = ids.length;
        await Promise.all(ids.map((id) => options.registry.wait(id)));
      }
    },

    async afterRework(jobId, timeoutMs = 120_000) {
      const work = works.get(jobId);
      if (work === undefined || options.queueMaster === false) return undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        gateOf(work.codebase).then(() => false),
        new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(true), timeoutMs))),
      ]);
      clearTimeout(timer);
      if (timedOut) return `The queue master is still reworking the queue for this change; the jobs it takes out or rewrites say so in the Jobs view (ctrl+j).`;
      if ((turns.get(work.codebase)?.count ?? 0) <= (work.turnAt ?? 0)) return undefined;
      return describeTurn(work.codebase, jobId);
    },

    async rework(plainFile, instruction) {
      if (options.queueMaster === false) return "The queue master is off for this queue: nothing was reworked.";
      const file = resolve(options.cwd, plainFile);
      // The codebase the spec's queued spec diffs render in - or, with none queued, where its changes land.
      let codebase = [...works.values()].reverse().find((work) => work.plainFile === file)?.codebase;
      if (codebase === undefined) {
        try {
          codebase = findCodebaseTip(file).tip.buildDir;
        } catch (error) {
          return `Nothing was reworked: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      const target = codebase;
      // After whatever the master is already doing for this codebase; the spec diffs wait for it.
      const turnsBefore = turns.get(target)?.count ?? 0;
      const turn = gateOf(target).then(() => runMaster(target, instruction));
      masters.set(target, turn.then(() => {}).catch(() => {}));
      const { plan, why } = await turn;
      if (plan === undefined) return `The queue master did nothing: ${why}.`;
      // What the turn changed - spec diffs and conformance jobs taken out or rewritten - and the queue it left.
      if ((turns.get(target)?.count ?? 0) > turnsBefore) return describeTurn(target) ?? plan.summary;
      const now = [...works.values()]
        .filter((work) => work.codebase === target && work.jobId !== undefined && work.superseded === undefined && isPending(options.registry.get(work.jobId)?.status))
        .map(queueLine);
      const stopped = [...works.values()].filter((work) => work.codebase === target && work.superseded !== undefined && options.registry.get(work.jobId!)?.status === "stopped");
      return [
        `${plan.by === "master" ? "The queue master" : "The harness"}: ${plan.summary}`,
        "",
        now.length > 0 ? `The spec diffs queued for it now, in the order they run:\n${now.join("\n")}` : "No spec diff is queued for it now.",
        ...(stopped.length > 0 ? ["", `Taken out: ${stopped.map((work) => `job ${work.jobId}`).join(", ")}.`] : []),
      ].join("\n");
    },
  };
  // One parse per file for the whole of a call: each module's lanes, codebase and chain, and each job's, ask for the
  // same .plain files - on a long chain of requires, thousands of times.
  const bringUpTo = queue.bringUpTo.bind(queue);
  queue.bringUpTo = (plainFile, bring) => withParseCache(() => bringUpTo(plainFile, bring));
  const enqueueSpecDiff = queue.enqueueSpecDiff.bind(queue);
  queue.enqueueSpecDiff = (request) => withParseCache(() => enqueueSpecDiff(request));

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

/** A module's spec as it is now, to pin a render to - or nothing, when it does not parse: the render says why. */
function pinSpec(plainFile: string): PinnedSpec | undefined {
  try {
    const [moduleName, tree] = plainFileParser(basename(plainFile), resolveTemplateDirs(plainFile));
    return { moduleName, tree };
  } catch {
    return undefined;
  }
}

/** The build folder of the codebase a spec's changes land in: the tip built on it, or its own. */
function codebaseDirOf(plainFile: string): string | undefined {
  try {
    return findCodebaseTip(plainFile).tip.buildDir;
  } catch {
    return undefined;
  }
}

/** A module's own build folder, where a render of one of its functionalities lands. */
function ownBuildDir(plainFile: string, pinned: PinnedSpec | undefined): string | undefined {
  return pinned !== undefined ? defaultBuildDir(pinned.moduleName, projectDirOf(plainFile)) : undefined;
}

/** What a spec diff job renders - which the queue master may rewrite until it starts. */
interface SpecDiffWork {
  plainFile: string;
  title: string;
  diff: string;
  applied: "applied" | "already applied";
  spec: SpecSnapshot;
  cwd?: string;
  inModule?: string;
  model?: string;
  /** The model the request named, for its conformance job. */
  requestModel?: string;
  off: boolean;
  conformanceLater: boolean;
  /** The codebase it renders into: its build folder. */
  codebase: string;
  jobId?: string;
  conformanceJobId?: string;
  /** It started rendering: the queue master no longer touches it. */
  started: boolean;
  /** Why it does not run, when the queue master took its work elsewhere or undid it. */
  superseded?: string;
  /** Only a new layout of the spec the codebase is built from: nothing to render, and the queue master leaves it be. */
  restructure?: boolean;
  /**
   * The spec the code is to be built from when it starts: what the job ahead of it leaves. Built
   * from anything else - that job stopped or failed - its diff is taken again from what is built.
   */
  before?: MarshalledPlainSource | null;
  /** The change section by section, as its render's agents were shown it - for its conformance job. */
  changeText?: string;
  /** How many turns of the queue master had changed its codebase's queue when it was queued. */
  turnAt?: number;
  /** Stopped by the queue master while running, it finished before the stop took, and landed. */
  landedAnyway?: boolean;
  /** Built on a module with work still to land: planned when its turn comes, not when it was queued. */
  planLater?: boolean;
  /** How whoever queued it wants the queue planned. */
  guidance?: string;
  /**
   * A functionality render, not a spec diff: the spec it leaves as queued, and whether conformance was off. Left as
   * it was, it runs as the render it was asked for; reworked, it runs as a spec diff.
   */
  render?: { original: string; off: boolean; frid: string };
}

/** Build a chain again: the module now required, then the ones above it from scratch - `renderChain` sees to that. */
const defaultRebuild: RebuildRunner = async (request, onDelta) => {
  const result = await renderChain({ plainFile: request.plainFile, model: request.model, conformance: request.conformance, onDelta });
  const modules = result.chain.map((entry) => entry.moduleName).join(" → ");
  return {
    report: describeChainStop(result) ?? (result.passed ? withTryItLine(`Built ${modules}, the codebase again from scratch on the module it now requires.`, true) : `The rebuild of ${modules} did not finish.`),
    details: { passed: result.passed, landed: result.passed },
  };
};

function isPending(status: Job["status"] | undefined): boolean {
  return status === "queued" || status === "running";
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

function conformanceOff(plainFile: string): boolean {
  return configForSpec(plainFile).conformanceTests === false;
}

function defaultRunner(options: { buildDir?: string; model?: string; cwd: string }): RenderRunner {
  return async (request, onDelta) => {
    // Off when the project's config.yaml turns conformance off - read for each build, so an edit
    // to the file holds for the next one.
    const off = conformanceOff(resolve(options.cwd, request.plainFile));
    const common = {
      plainFile: request.plainFile,
      frid: request.frid,
      buildDir: options.buildDir,
      model: request.model ?? options.model,
      ...(off ? { conformance: false } : {}),
      // The spec as it was when it was queued: what it builds and records.
      ...(request.pinned !== undefined ? { pinned: request.pinned } : {}),
      onDelta,
    };

    if (request.regenerate === true) {
      const result = await regenerateFunctionality({ ...common, conformanceLater: request.conformanceLater === true });
      return {
        report: result.passed
          ? result.conformanceLater === true
            ? `Regenerated functionality ${result.frid} on its unit tests; its conformance tests and the whole suite follow as a job of their own.`
            : `Regenerated functionality ${result.frid}; the conformance suite passes.`
          : (describeRegenerationStop(result) ?? `Regeneration of functionality ${result.frid} stopped at ${result.stoppedAt}.`),
        details: { passed: result.passed, landed: result.passed, conformanceLater: result.conformanceLater === true },
      };
    }

    // Functionality N is rendered as built on 1 to N-1, so any of those that was never built -
    // its job stopped, or never queued - is built first, in order. Otherwise the render would
    // be told they are implemented when they are not.
    const [moduleName, tree] =
      request.pinned !== undefined ? [request.pinned.moduleName, request.pinned.tree] : plainFileParser(basename(request.plainFile), resolveTemplateDirs(request.plainFile));
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
    // Its conformance tests follow as a job of their own: it can be tried once that job passes, and that job says so.
    const later = request.conformanceLater === true;
    const result = await renderFunctionality(common);

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
            ? withoutConformance(findTestScripts(projectRootFor(request.plainFile, result.buildDir), request.plainFile, result.buildDir))
            : findTestScripts(projectRootFor(request.plainFile, result.buildDir), request.plainFile, result.buildDir),
          model: options.model,
          onDelta,
        })
      : undefined;
    if (regression !== undefined && !regression.passed) {
      // Said in full by the stop report below.
    } else if (regression !== undefined && regression.repairs.length > 0) {
      prerequisites.push(`${regression.repairs.length} regression repair(s) changed the code so the existing conformance tests pass.`);
    }
    // A build that stopped says where, why and what to do; one that landed, that it can be tried.
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
            offerTry: !later,
          });
    return {
      report: prerequisites.length > 0 ? `${delivery}\n\n${prerequisites.map((p) => `Note: ${p}`).join("\n")}` : delivery,
      details: {
        passed: result.passed,
        landed: stopped === undefined,
        files: result.files,
        prerequisites: missing.map((entry) => entry.frid),
      },
    };
  };
}
