import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { basename } from "node:path";
import { plainFileParser } from "../plain/parser.ts";
import { pendingFrids, staleFrids } from "./state.ts";
import { describeDelivery } from "./delivery.ts";
import { defaultBuildDir, modulesRoot, projectDirOf } from "./paths.ts";
import { resolveTemplateDirs } from "./render.ts";
import { configForSpec } from "../config.ts";
import { findTestScripts, projectRootFor, withoutConformance } from "./test-scripts.ts";
import { renderFunctionality } from "./render.ts";
import { describeChainStop, ensureRegressionPasses, regenerateFunctionality, describeRegenerationStop, renderChain } from "./module.ts";
import { getFrids, getInheritedFunctionalSpecs } from "../plain/spec.ts";
import { moduleLanes } from "./lanes.ts";
import { findCodebaseTip, newlyRequired, type ChainEntry } from "./requires.ts";
import type { RenderWork } from "./models.ts";
import { describeStop, type StopPoint } from "./stop-report.ts";
import { describeSpecDiff, renderSpecDiff, specFilesOf, wholeSpecDiff, type SpecSnapshot } from "./spec-change.ts";
import { splitSpecDiff, type SpecDiffPart } from "./spec-diff-parts.ts";
import { diffSpecText, layoutOf, sameSpec, serializeTree } from "./spec-steps.ts";
import { listFiles } from "./testing.ts";
import { describeSpecDiffConformance, renderSpecDiffConformance } from "./spec-change-conformance.ts";
import { describeConformanceSuite, renderConformanceSuite, type ConformanceSuiteOptions } from "./conformance-suite.ts";
import { sectionsOf } from "./state.ts";
import { TEST_REQUIREMENTS } from "../plain/spec.ts";
import { randomUUID } from "node:crypto";
import type { Job, JobRegistry } from "./jobs.ts";
import { reportStage, unitOf } from "./activity.ts";
import { summarizeDiff } from "./job-panel.ts";
import { markWork } from "./history.ts";
import { llmQueueMaster, reworkQueue, type MasterInput, type MasterPlan, type QueueMasterAgent } from "./queue-master.ts";
import { readBuiltTree } from "./state.ts";
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
  enqueueSpecDiff(request: SpecDiffRequest): QueuedSpecDiff;
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
  /** Work out and check how to try it. Default true: queued from an interview, the person is there. */
  tryIt?: boolean;
  /** false: no conformance tests for it, and no conformance job after it. */
  conformance?: false;
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

  // Every spec diff this queue renders, by job: what it renders, which the queue master may rewrite
  // until it starts. And per codebase, the queue master's work in progress - no spec diff of that
  // codebase starts until it is done - and the spec as it last saw it.
  const works = new Map<string, SpecDiffWork>();
  const masters = new Map<string, Promise<void>>();
  const lastSeen = new Map<string, MarshalledPlainSource>();
  const gateOf = (codebase: string) => masters.get(codebase) ?? Promise.resolve();
  // Per codebase, the queue master's turns that changed the queue: how many, and what the last one did.
  const turns = new Map<string, { count: number; summary: string; by: string; taken: string[]; rewritten: string[] }>();
  // The codebases being built again from scratch, by job: the queue master leaves their spec diffs alone.
  const rebuilds: Array<{ jobId: string; codebase: string; part: QueuedSpecDiffPart }> = [];
  const rebuildRunner: RebuildRunner = options.rebuild ?? defaultRebuild;

  /** Start a spec diff's render job - and its conformance job, when it leaves them to one - for what `work` says. */
  const startSpecDiff = (work: SpecDiffWork): { jobId: string; position: number; conformanceJobId?: string } => {
    const job = options.registry.start({
      kind: "render_spec_diff",
      summary: `${basename(work.plainFile)} render spec diff`,
      diff: work.diff,
      model: work.model,
      lanes: [queueLane, ...moduleLanes(codebaseOf(work.plainFile), options.buildDir)],
      run: async (onDelta) => {
        // The queue master may still be reworking the queue: it decides what this job renders, or whether it runs at all.
        await gateOf(work.codebase);
        if (work.superseded !== undefined) return { report: work.superseded, details: { passed: false, skipped: true, landed: false } };
        work.started = true;
        rebaseIfBehind(work, work.jobId!);
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
          // Queued from an interview: the person is there, trying each change as it lands.
          tryIt: work.tryIt ?? true,
          onDelta,
        });
        return {
          report: describeSpecDiff(result),
          details: { passed: result.passed, stoppedAt: result.stoppedAt, landed: result.passed, conformanceLater: result.conformanceLater === true },
        };
      },
    });
    jobs.set(job.id, job);
    works.set(job.id, work);
    work.jobId = job.id;
    last = job.id;
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
   * leaves, and it says so.
   */
  const rebaseIfBehind = (work: SpecDiffWork, jobId: string) => {
    const built = readBuiltTree(work.codebase);
    if (work.before === undefined || work.before === null || built === null) return;
    if (serializeTree(built) === serializeTree(work.before) || sameSpec(built, work.before)) return;
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
      job.note = `${job.note !== undefined ? `${job.note} ` : ""}Rebased when it started: the job ahead of it did not land, so it renders everything from what the code is built from to its spec - that job's change as well.`;
    }
  };

  /** Rework the queue around a new change: after whatever the queue master was already doing for that codebase. */
  const triggerMaster = (work: SpecDiffWork) => {
    if (options.queueMaster === false) return;
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
    if ((instruction === undefined && waiting.length < 2) || previousSpec === undefined) return { why: "only one spec diff is waiting" };
    const otherWork =
      queued.some((entry) => isPending(options.registry.get(entry.jobId)?.status)) ||
      rebuilds.some((rebuild) => rebuild.codebase === codebase && isPending(options.registry.get(rebuild.jobId)?.status));
    if (otherWork) return { why: "functionality renders or a rebuild are queued for this codebase too - they change what the code is built from, so the spec diffs are left as they are" };
    const running = mine.find((work) => work.started && options.registry.get(work.jobId!)?.status === "running");
    const base = running?.spec.tree ?? readBuiltTree(codebase);
    if (base === null) return { why: "nothing is built in this codebase yet" };

    const specFile = relative(options.cwd, latest.plainFile);
    let specText = "";
    try {
      specText = readFileSync(latest.plainFile, "utf8");
    } catch {
      /* the layout is only for how the diffs read */
    }
    const input: MasterInput = {
      base,
      previous: previousSpec,
      current: latest.spec.tree,
      queued: waiting.map((work) => ({ jobId: work.jobId!, title: work.title, tree: work.spec.tree, textDiff: work.diff })),
      specFile,
      specText,
      ...(instruction !== undefined ? { instruction } : {}),
    };
    const plan = await reworkQueue({
      input,
      agent: (options.queueMaster === false ? undefined : options.queueMaster) ?? llmQueueMaster({ cwd: options.cwd, model: options.masterModel ?? latest.model, label: `${basename(latest.plainFile)} queue master` }),
      askPerson: options.askPerson,
    });
    applyPlan(waiting, plan, base);
    return { plan };
  };

  /**
   * Make the queue what the plan says. A planned job runs as the queued job it came from where the
   * order allows - that job keeps its place and its id - and otherwise in the place of one the plan
   * left out; what is left over goes on after them, as new jobs. The queued jobs no planned one runs
   * as are stopped, saying where their change went.
   */
  const applyPlan = (waiting: SpecDiffWork[], plan: MasterPlan, base: MarshalledPlainSource) => {
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
    const taken: string[] = [];
    const rewritten: string[] = [];
    let before = base;
    for (const { planned, work } of placed) {
      const step = planned.step;
      const from = planned.jobId !== undefined && planned.jobId !== work?.jobId ? ` - the change job ${planned.jobId} was queued with` : "";
      if (work === undefined) {
        // More jobs than there are places: they go on after them, in order.
        const extra: SpecDiffWork = { ...waiting.at(-1)!, title: planned.title, diff: step.textDiff, applied: "already applied", spec: { ...waiting.at(-1)!.spec, tree: step.tree }, started: false, jobId: undefined, conformanceJobId: undefined, superseded: undefined, before };
        const { jobId } = startSpecDiff(extra);
        rewritten.push(jobId);
        const job = options.registry.get(jobId);
        if (job !== undefined) job.note = `${from === "" ? "Inserted" : "Moved here"} by ${by}: ${planned.title}${from}. ${plan.summary}`;
        before = step.tree;
        continue;
      }
      const changed = work.diff !== step.textDiff;
      if (changed) rewritten.push(work.jobId!);
      // Not renamed by the master: named for what it now renders, not for what it was queued with.
      work.title = planned.title === work.title && changed ? summarizeDiff(step.textDiff) : planned.title;
      work.diff = step.textDiff;
      work.applied = "already applied";
      work.spec = { ...work.spec, tree: step.tree };
      work.before = before;
      before = step.tree;
      const job = options.registry.get(work.jobId!);
      if (job !== undefined) {
        job.diff = step.textDiff;
        if (from !== "") job.note = `Now renders "${planned.title}"${from}, by ${by}. ${plan.summary}`;
        else if (changed) job.note = `Reworked by ${by}: ${planned.title}. ${plan.summary}`;
      }
      if (work.conformanceJobId !== undefined) {
        const conformance = options.registry.get(work.conformanceJobId);
        if (conformance !== undefined) conformance.diff = step.textDiff;
      }
    }
    // The queued jobs no planned job runs as: their change is undone, or runs in another job.
    const where = new Map(placed.map((entry) => [entry.planned.jobId, entry.work?.jobId]));
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
      .map((item) => `- job ${item.jobId} · ${item.title}${item.started ? " (running)" : ""}`);
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
    const ahead = [...works.values()]
      .reverse()
      .find((work) => work.codebase === codebase && work.superseded === undefined && isPending(options.registry.get(work.jobId!)?.status));
    return ahead?.spec.tree ?? readBuiltTree(codebase);
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
      tryIt: request.tryIt,
      off,
      // A restructuring changes nothing its tests check.
      conformanceLater: !off && !restructure && hasTestReqs(part.spec),
      codebase,
      started: false,
      restructure,
      before,
      turnAt: turns.get(codebase)?.count ?? 0,
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
      lanes: [queueLane, ...moduleLanes(tip.plainFile, options.buildDir)],
      run: (onDelta) => rebuildRunner({ plainFile: tip.plainFile, model, ...(off ? { conformance: false as const } : {}) }, onDelta),
    });
    job.note = [
      ...(split !== undefined ? [split] : []),
      `Not a spec diff: ${tip.moduleName} now requires ${fresh.modules.join(", ")}, which its code was not built on. ${fresh.modules.join(", ")} is built first, then ${again} again from scratch on it.`,
    ].join(" ");
    jobs.set(job.id, job);
    last = job.id;
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
        lanes: [queueLane, ...moduleLanes(codebaseOf(plainFile), options.buildDir)],
        run: async (onDelta) => {
          if (follows !== undefined) await gateOf(follows.codebase);
          if (follows?.superseded !== undefined) return { report: follows.superseded, details: { passed: false, skipped: true } };
          const skipped = notFollowing(request.after);
          if (skipped !== undefined) return { report: skipped, details: { passed: false, skipped: true } };
          const result = await renderSpecDiffConformance({
            plainFile,
            diff: follows?.diff ?? request.diff,
            cwd: request.cwd ?? options.cwd,
            inModule: request.inModule,
            applied: follows !== undefined ? "already applied" : request.applied,
            spec: follows?.spec ?? request.spec,
            model,
            onDelta,
          });
          return { report: describeSpecDiffConformance(result), details: { passed: result.passed, stoppedAt: result.stoppedAt } };
        },
      });
      jobs.set(job.id, job);
      last = job.id;
      if (follows !== undefined) follows.conformanceJobId = job.id;
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
      if (request.regenerate !== true && !conformanceOff(plainFile) && moduleHasTestReqs(plainFile)) {
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
      const turn = gateOf(target).then(() => runMaster(target, instruction));
      masters.set(target, turn.then(() => {}).catch(() => {}));
      const { plan, why } = await turn;
      if (plan === undefined) return `The queue master did nothing: ${why}.`;
      const now = [...works.values()]
        .filter((work) => work.codebase === target && work.jobId !== undefined && work.superseded === undefined && isPending(options.registry.get(work.jobId)?.status))
        .map((work) => `- job ${work.jobId} · ${work.title}${work.started ? " (running)" : ""}`);
      const stopped = [...works.values()].filter((work) => work.codebase === target && work.superseded !== undefined && options.registry.get(work.jobId!)?.status === "stopped");
      return [
        `${plan.by === "master" ? "The queue master" : "The harness"}: ${plan.summary}`,
        "",
        now.length > 0 ? `The spec diffs queued for it now, in the order they run:\n${now.join("\n")}` : "No spec diff is queued for it now.",
        ...(stopped.length > 0 ? ["", `Taken out: ${stopped.map((work) => `job ${work.jobId}`).join(", ")}.`] : []),
      ].join("\n");
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
  tryIt?: boolean;
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
  /** How many turns of the queue master had changed its codebase's queue when it was queued. */
  turnAt?: number;
}

/** Build a chain again: the module now required, then the ones above it from scratch - `renderChain` sees to that. */
const defaultRebuild: RebuildRunner = async (request, onDelta) => {
  const result = await renderChain({ plainFile: request.plainFile, model: request.model, conformance: request.conformance, tryIt: true, onDelta });
  const modules = result.chain.map((entry) => entry.moduleName).join(" → ");
  return {
    report: describeChainStop(result) ?? (result.passed ? `Built ${modules}, the codebase again from scratch on the module it now requires.` : `The rebuild of ${modules} did not finish.`),
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
