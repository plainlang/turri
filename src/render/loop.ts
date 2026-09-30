import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { plainFileParser, withParseCache } from "../plain/parser.ts";
import { FUNCTIONAL_REQUIREMENTS, REQUIRED_FUNCTIONAL_SPECS, TEST_REQUIREMENTS, type MarshalledPlainSource } from "../plain/spec.ts";
import { reportActivity, reportStage } from "./activity.ts";
import { llmChunkAgents, planChunks, type ChunkAgents } from "./chunk-plan.ts";
import { recordHistory, resetToLastCommit } from "./history.ts";
import type { Job, JobRegistry } from "./jobs.ts";
import { moduleLanes } from "./lanes.ts";
import { stepsOf, type MasterInput, type Steering } from "./queue-master.ts";
import { chainTree, codeTree, conformanceTarget, inheritedRecord, readRecord, RECORD_FILE, writeCodeRecord, writeTestsRecord } from "./records.ts";
import { describeSpecDiffConformance, renderSpecDiffConformance } from "./spec-change-conformance.ts";
import { conformanceDirFor } from "./conformance.ts";
import { modulesRoot } from "./paths.ts";
import { configForSpec } from "../config.ts";
import { describeSpecChange } from "./prompt.ts";
import { resolveTemplateDirs } from "./render.ts";
import { builtTips, copyRequiredCode, newlyRequired, resolveRequiresChain, type ChainEntry } from "./requires.ts";
import { withTryItLine } from "./delivery.ts";
import { describeSpecDiff, renderSpecDiff, specFilesOf, type SpecSnapshot } from "./spec-change.ts";
import { locateDiffLines, type DiffWhere } from "./diff-view.ts";
import { projectDirOf } from "./paths.ts";
import { changesBetween, parseTree, serializeTree, type SpecStep } from "./spec-steps.ts";
import { listFiles } from "./testing.ts";
import { casesOf, codeWork, stillWanted, type JobCases } from "./work.ts";

/**
 * The work loop - see docs/work-model.md.
 *
 * Nothing is queued. For every codebase it has been asked to bring up to its spec, the loop works out
 * what is left to build - from the code record to the spec of the codebase's requires chain, as the
 * .plain files have it now - has the planner cut it into jobs, and runs the first. When a job ends, or
 * the spec changes, it works it out again. A plan is kept only while the spec and the record it was cut
 * from stay as they were.
 *
 * Code accumulates up a requires chain: a module is built on a copy of the code of the one it requires.
 * So the codebase of a chain is its furthest-built module - its tip - and a change to a module below is
 * made there. The codebases below it are left as they were, their records saying what they are built
 * from; one is brought up to its own spec again only when a module not built yet is to start from it.
 *
 * - A module waits while one it is built on has work left, or a job running.
 * - A running job the spec no longer wants - one of its changes is no longer part of the work - is
 *   stopped, and what it did rolled back. Otherwise it finishes, and the next plan starts from what it
 *   landed.
 * - A job that does not land halts its codebase: nothing more runs there until the spec changes or it is
 *   asked for again.
 */

/** A planned job: its title, why, its cases, and its step - its diff and the spec it leaves. */
export interface PlannedJob {
  title: string;
  reason: string;
  cases: JobCases;
  step: SpecStep;
  /** What it builds: the code, or the conformance tests of what the code is built from. */
  track: Track;
}

/** The two things a codebase is brought up in: its code, and - on the code as built - its conformance tests. */
export type Track = "code" | "conformance";

/** What renders a job. Injectable, so the loop can be tested without a model. */
export type JobRunner = (
  job: { plainFile: string; moduleName: string; buildDir: string; spec: SpecSnapshot; planned: PlannedJob; model?: string; cwd: string },
  onDelta: (delta: string) => void,
) => Promise<{ landed: boolean; report: string }>;

/** A codebase as the loop sees it, for the person. */
export interface ModuleStatus {
  module: string;
  plainFile: string;
  /** The job running now, if one is. */
  running?: { jobId: string; title: string };
  /** The jobs planned after it, in order. */
  planned: Array<{ title: string; cases: JobCases; track: Track }>;
  /** Why nothing runs there, when nothing does. */
  why?: string;
}

interface ModuleState {
  /** The module's requires chain, bottom first: the module itself last. */
  chain: ChainEntry[];
  /** The .plain file the person asked for: steering is read for it. */
  askedFile: string;
  model?: string;
  guidance: string[];
  plan?: { specKey: string; from: string; jobs: PlannedJob[] };
  /** The conformance tests' plan, apart from the code's: planned from what they are written for. */
  conformancePlan?: { specKey: string; from: string; jobs: PlannedJob[] };
  running?: { jobId: string; planned: PlannedJob; from: MarshalledPlainSource; after: MarshalledPlainSource; stopping?: boolean };
  /**
   * Conformance tests asked for in the conversation - over a config that has them off - and for which functional
   * specs: none named, every one. Not asked: as the config says.
   */
  conformance?: { chosen?: Set<string> };
  /** The conformance tests halted, the code going on: until the spec or the code changes from `key`, or they are asked for again. */
  conformanceHalted?: { why: string; key: string };
  /** Nothing runs here until the spec changes from `specKey`, or it is asked for again. */
  halted?: { why: string; specKey: string };
  /** Why the last look started nothing here. */
  why?: string;
  /** The module below it that it waits for, while it does: not planned until that one is built. */
  waitsFor?: string;
}

export interface WorkLoop {
  /**
   * Bring a spec's module up to the spec as the .plain files have it now - in the codebases where its
   * code lives, and every module it is built on that has to be built first - planning and starting the
   * first jobs. Asked again, it clears a halt. Also what a spec change is: the loop works out the work
   * again. Says what it planned.
   */
  bringUp(plainFile: string, options?: { model?: string; guidance?: string }): Promise<ModuleStatus[]>;
  /**
   * Build a functional spec of a module again, changed or not: it is taken out of the record of every
   * codebase it is built in - committed, so the record says it is not built - and they are brought up to
   * their spec.
   */
  regenerate(plainFile: string, frid: string, options?: { model?: string }): Promise<ModuleStatus[]>;
  /**
   * Write and run the conformance tests of a spec's module - of the functional specs named, or of every one - on the
   * code as it is built, in the codebases where its code lives: for this session, whatever the config says. Asked
   * again, it clears a halt. Says what it planned.
   */
  conformance(plainFile: string, options?: { frids?: string[]; model?: string }): Promise<ModuleStatus[]>;
  /** Every codebase the loop looks after, bottom of each chain first. */
  status(): ModuleStatus[];
  /**
   * The jobs planned after the running ones, as jobs are listed - queued, each after the one before it -
   * for the job panel and list_jobs. Not started, they are not the registry's: planned again, they change.
   */
  planned(): Job[];
  /** Resolves once nothing runs and nothing more can start. */
  drain(): Promise<void>;
}

const tipOf = (chain: ChainEntry[]): ChainEntry => chain.at(-1)!;

/** Whether a module's codebase has been started: code in it, or a record. */
const started = (entry: ChainEntry) => listFiles(entry.buildDir).length > 0 || readRecord(entry.buildDir) !== null;

/** The spec a codebase is built from, as the .plain files have it now: its whole requires chain's. */
export function chainSpec(chain: ChainEntry[]): SpecSnapshot {
  const trees = chain.map((entry) => ({
    module: entry.moduleName,
    tree: plainFileParser(basename(entry.plainFile), resolveTemplateDirs(entry.plainFile), { allowNoFunctionalities: true })[1],
  }));
  const tip = tipOf(chain);
  return { moduleName: tip.moduleName, plainFile: tip.plainFile, tree: chainTree(trees), chain };
}

/**
 * The chains a request for `plainFile` brings up: where its module's code lives - every built tip whose
 * chain holds it, one per branch - or, with none, its own chain. Each from its furthest-built module on:
 * the codebases below that are left as they are.
 */
function chainsFor(plainFile: string): ChainEntry[][] {
  const tips = builtTips(plainFile);
  return tips.length > 0 ? tips : [resolveRequiresChain(plainFile, [], undefined, { allowNoFunctionalities: true })];
}

/** The modules of a chain to build: its furthest-built one, and those above it - or, none built, all of it. */
function toBuild(chain: ChainEntry[]): ChainEntry[] {
  let from = 0;
  chain.forEach((entry, index) => {
    if (started(entry)) from = index;
  });
  return chain.slice(from);
}

export function createWorkLoop(options: {
  registry: JobRegistry;
  cwd: string;
  buildDir?: string;
  /** The model a job renders on, asked when a module is brought up. */
  modelFor?: (plainFile: string) => string | undefined;
  /** The planner's agents. false: none - a functional spec a job. Default: the LLM ones, on `plannerModel`. */
  planner?: ChunkAgents | false;
  /** The planner's model, read afresh each plan - the chat's, in a conversation. */
  plannerModel?: string | (() => string | undefined);
  /** How the person wants the work cut and ordered, for every plan of a spec's module. */
  steering?: (plainFile: string) => Steering[];
  /** Renders a job. Default: a spec diff render that lands on its unit tests. */
  run?: JobRunner;
  /** Writes and runs a conformance job's tests. Default: a spec diff's conformance run, the whole suite with it. */
  runConformance?: JobRunner;
  /** Whether the config has a module's conformance tests on. Default: its `conformance-tests:`, on unless false. */
  conformanceOn?: (plainFile: string) => boolean;
}): WorkLoop {
  const modules = new Map<string, ModuleState>();
  const order: string[] = [];
  const run: JobRunner = options.run ?? defaultRunner;
  const runConformance: JobRunner = options.runConformance ?? defaultConformanceRunner;
  const configConformance = options.conformanceOn ?? ((plainFile: string) => configForSpec(plainFile).conformanceTests !== false);
  // One tick at a time: each reads the records and the spec, and decides.
  let ticking: Promise<void> = Promise.resolve();

  const tipEntry = (state: ModuleState) => tipOf(state.chain);
  const keyOf = (spec: SpecSnapshot) => serializeTree(codeTree(spec.tree));

  /** What a codebase is built from: its record, or - nothing built - what it starts from, the code of the module it requires. */
  const builtOf = (state: ModuleState): MarshalledPlainSource => {
    const tip = tipEntry(state);
    const record = readRecord(tip.buildDir);
    if (record !== null) return codeTree(record);
    const below = state.chain.find((entry) => entry.moduleName === tip.requires);
    const source = below === undefined ? null : readRecord(below.buildDir);
    return source === null ? {} : codeTree(inheritedRecord(source, below!.moduleName));
  };

  /** Where a codebase's conformance tests are: the module's tests folder. */
  const testsDirOf = (state: ModuleState) => {
    const tip = tipEntry(state);
    return conformanceDirFor(tip.moduleName, modulesRoot(projectDirOf(tip.plainFile)));
  };

  /** What the conformance tests are written for, by their record - nothing, when there is none. */
  const testedOf = (state: ModuleState): MarshalledPlainSource => readRecord(testsDirOf(state)) ?? {};

  /** What the conformance tests are to be written for now: of what the code is built from, what is chosen, with the test reqs as the spec has them. */
  const conformanceOf = (state: ModuleState, spec: SpecSnapshot): MarshalledPlainSource => {
    const chosen = state.conformance?.chosen;
    return conformanceTarget(readRecord(tipEntry(state).buildDir), readRecord(testsDirOf(state)), spec.tree, chosen === undefined ? undefined : (frid) => chosen.has(frid));
  };

  /** Whether a codebase's conformance tests are written: asked for, or on in the config - with test reqs to write them from, and code to test. */
  const conformanceWanted = (state: ModuleState, spec: SpecSnapshot): boolean =>
    (state.conformance !== undefined || configConformance(tipEntry(state).plainFile)) &&
    ((spec.tree[TEST_REQUIREMENTS] as unknown[] | undefined) ?? []).length > 0 &&
    readRecord(tipEntry(state).buildDir) !== null;

  /** The work of a track, from where it is built from to what it is to be. */
  const workOf = (track: Track, from: MarshalledPlainSource, state: ModuleState, spec: SpecSnapshot) =>
    track === "code" ? codeWork(from, spec.tree) : changesBetween(serializeTree(from), serializeTree(conformanceOf(state, spec)));

  /** The codebases brought up in this look: one left behind is never waited for. */
  let looking = new Set<ModuleState>();

  /** The module below this one, to be built first, that still has work left or a job running. */
  const waitingOn = (state: ModuleState): string | undefined => {
    for (const entry of state.chain.slice(0, -1)) {
      const below = modules.get(entry.buildDir);
      if (below === undefined || (!looking.has(below) && below.running === undefined)) continue;
      if (below.running !== undefined) return entry.moduleName;
      if (codeWork(builtOf(below), chainSpec(below.chain).tree).length > 0) return entry.moduleName;
    }
    return undefined;
  };

  const plan = async (state: ModuleState, spec: SpecSnapshot, from: MarshalledPlainSource, track: Track = "code"): Promise<PlannedJob[]> => {
    const tip = tipEntry(state);
    const current = track === "code" ? codeTree(spec.tree) : conformanceOf(state, spec);
    const specFile = relative(options.cwd, tip.plainFile);
    let specText = "";
    try {
      specText = readFileSync(tip.plainFile, "utf8");
    } catch {
      /* the layout is only for how the diffs read */
    }
    const steering = [
      ...(options.steering?.(state.askedFile) ?? []),
      ...state.guidance.map((text) => ({ source: "the request that asked for the work", text })),
    ];
    const input: MasterInput = { base: from, previous: from, current, queued: [], specFile, specText, steering };
    const model = typeof options.plannerModel === "function" ? options.plannerModel() : options.plannerModel;
    const agents = options.planner === false ? undefined : (options.planner ?? llmChunkAgents({ cwd: options.cwd, model: model ?? state.model, label: `${basename(tip.plainFile)} planner` }));
    reportStage(`${tip.moduleName}: planning the ${track === "code" ? "work" : "conformance tests"} into jobs`);
    const draft = await planChunks(input, agents);
    const fresh = tip.requires === null && (track === "code" ? !started(tip) : readRecord(testsDirOf(state)) === null);
    return stepsOf(input, draft).map((job, index) => {
      // Its cases from its own change: the spec before it to the spec after it - the plan's changes are numbered from where the plan starts.
      const cases = casesOf(parseTree(job.step.before), changesBetween(job.step.before, job.step.after), { fresh: fresh && index === 0 });
      return { title: job.title, reason: job.reason, cases, step: job.step, track };
    });
  };

  const startJob = (state: ModuleState, spec: SpecSnapshot, from: MarshalledPlainSource, planned: PlannedJob) => {
    const tip = tipEntry(state);
    const conformance = planned.track === "conformance";
    const job: Job = options.registry.start({
      kind: conformance ? "render_spec_diff_conformance" : "render_spec_diff",
      summary: `${basename(tip.plainFile)} ${conformance ? "conformance: " : ""}${planned.title}`,
      diff: planned.step.textDiff,
      ...(state.model !== undefined ? { model: state.model } : {}),
      lanes: [...moduleLanes(tip.plainFile, options.buildDir)],
      run: async (onDelta) => {
        // Nothing here yet: the codebase starts as a copy of the one it is built on, recorded as what it inherits.
        if (tip.requires !== null && !started(tip)) {
          const below = state.chain.find((entry) => entry.moduleName === tip.requires);
          const source = below === undefined ? null : readRecord(below.buildDir);
          if (below !== undefined && source !== null) {
            copyRequiredCode(below.buildDir, tip.buildDir, tip.moduleName, below.moduleName, undefined, inheritedRecord(source, below.moduleName));
            // Its conformance tests come with the code, the ones below's: none of its own is written yet.
            if (existsSync(join(testsDirOf(state), RECORD_FILE))) writeTestsRecord(testsDirOf(state), {});
          }
        }
        // A conformance job is shown the spec whole - its test reqs and acceptance tests are its to write from.
        const result = await (conformance ? runConformance : run)(
          { plainFile: tip.plainFile, moduleName: tip.moduleName, buildDir: tip.buildDir, spec: conformance ? spec : { ...spec, tree: planned.step.tree }, planned, model: state.model, cwd: options.cwd },
          onDelta,
        );
        return { report: result.report, details: { passed: result.landed, landed: result.landed } };
      },
    });
    // Its lines where they are written: the module's .plain file, those it imports, and those of the modules below it.
    job.diffWhere = whereInFiles(planned.step.textDiff, state.chain);
    state.running = { jobId: job.id, planned, from, after: planned.step.tree };
    void options.registry.wait(job.id).then(
      (settled) => settle(state, settled),
      () => settle(state, undefined),
    );
  };

  const settle = (state: ModuleState, settled: Job | undefined) => {
    const running = state.running;
    state.running = undefined;
    const landed = settled?.status === "succeeded" && (settled.details as { landed?: boolean } | undefined)?.landed === true;
    if (running !== undefined && !landed && running.planned.track === "conformance") {
      // Conformance tests that did not pass - nor the code fixes they made - are gone, and they halt: the code goes on.
      resetToLastCommit(tipEntry(state).buildDir);
      state.conformancePlan = undefined;
      if (running.stopping !== true) {
        const why = settled?.status === "stopped" ? `job ${running.jobId} was stopped` : `conformance job ${running.jobId} ("${running.planned.title}") did not pass`;
        state.conformanceHalted = { why: `${why} - its conformance tests are written again once the spec or the code changes, or they are asked for again`, key: conformanceKey(state) };
      }
    } else if (running !== undefined && !landed) {
      // What it wrote and never committed is gone: code, tests and record agree again.
      resetToLastCommit(tipEntry(state).buildDir);
      state.plan = undefined;
      if (running.stopping !== true) {
        let key = "";
        try {
          key = keyOf(chainSpec(state.chain));
        } catch {
          /* a spec that does not parse halts it all the same */
        }
        const why = settled?.status === "stopped" ? `job ${running.jobId} was stopped` : `job ${running.jobId} ("${running.planned.title}") did not land`;
        state.halted = { why: `${why} - it runs again once the spec changes, or the module is asked for again`, specKey: key };
      }
    } else {
      const own = running?.planned.track === "conformance" ? state.conformancePlan : state.plan;
      if (own !== undefined) {
        own.jobs.shift();
        if (running !== undefined) own.from = serializeTree(running.after);
      }
    }
    void tick();
  };

  /** What a conformance halt holds for: the spec and what the code is built from, as they are. */
  const conformanceKey = (state: ModuleState): string => {
    try {
      return `${serializeTree(chainSpec(state.chain).tree)}\n${serializeTree(readRecord(tipEntry(state).buildDir) ?? {})}`;
    } catch {
      return "";
    }
  };

  /** Look at every codebase once, bottom of each chain first, and start what can start. */
  const tick = (): Promise<void> => {
    ticking = ticking
      .then(() => withParseCache(() => lookAll()))
      .catch((error: unknown) => reportActivity(`  the work loop: ${error instanceof Error ? error.message : String(error)}`));
    return ticking;
  };

  /** The files asked for, each with how: what the loop brings up, worked out again each look. */
  const asked = new Map<string, { model?: string; guidance?: string }>();

  /** The codebases the requests bring up now - where each module's code lives, and what is to be built on it. */
  const active = (): Set<ModuleState> => {
    const states = new Set<ModuleState>();
    for (const [file, request] of asked) {
      let chains: ChainEntry[][];
      try {
        chains = chainsFor(file);
      } catch {
        continue;
      }
      for (const chain of chains) for (const entry of toBuild(chain)) states.add(track(chain.slice(0, chain.indexOf(entry) + 1), file, request));
    }
    return states;
  };

  const lookAll = async () => {
    const now = active();
    looking = now;
    for (const key of order) {
      const state = modules.get(key)!;
      // A codebase left behind - built on since - is not looked at, unless a job of it is still running.
      if (now.has(state) || state.running !== undefined) await look(state);
      else state.why = "left behind: the code is built on further up the chain, where changes to it are made";
    }
  };

  const look = async (state: ModuleState) => {
    const tip = tipEntry(state);
    let spec: SpecSnapshot;
    try {
      spec = chainSpec(state.chain);
    } catch (error) {
      state.why = `its spec does not parse: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    const specKey = keyOf(spec);

    if (state.running !== undefined) {
      if (state.running.stopping === true) return;
      // The stop rule: every change the running job makes is still part of the work, measured from the same record.
      const track = state.running.planned.track;
      const own = changesBetween(serializeTree(state.running.from), serializeTree(state.running.after));
      if (!stillWanted(own, workOf(track, state.running.from, state, spec))) {
        state.running.stopping = true;
        state.why = `job ${state.running.jobId} was stopped: the spec no longer wants what it was building`;
        reportActivity(`  ${tip.moduleName}: ${state.why}`);
        options.registry.stop(state.running.jobId);
        return;
      }
      // Still wanted: what comes after it is planned now, from what it will land - not once it has.
      const planOf = track === "code" ? state.plan : state.conformancePlan;
      if (planOf === undefined || planOf.specKey !== specKey) {
        const running = state.running;
        const rest = workOf(track, running.after, state, spec).length === 0 ? [] : await plan(state, spec, running.after, track);
        const next = { specKey, from: serializeTree(running.from), jobs: [running.planned, ...rest] };
        if (state.running === running) {
          if (track === "code") state.plan = next;
          else state.conformancePlan = next;
        }
      }
      return;
    }
    if (state.halted !== undefined) {
      if (state.halted.specKey === specKey) {
        state.why = state.halted.why;
        return;
      }
      state.halted = undefined;
    }
    const fresh = newlyRequired(state.chain);
    if (fresh !== undefined && fresh.rebuild.some((entry) => entry.buildDir === tip.buildDir)) {
      state.why = `it now requires ${fresh.modules.join(", ")}, which its code was not built on - its code has to be started again on it`;
      return;
    }
    const below = waitingOn(state);
    state.waitsFor = below;
    if (below !== undefined) {
      state.why = `waiting for ${below}: the code it is built on is not built yet`;
      return;
    }
    // The conformance tests of what the code is built from, first: after a job lands, before the next one builds on it.
    if (state.conformanceHalted !== undefined && state.conformanceHalted.key !== conformanceKey(state)) state.conformanceHalted = undefined;
    if (conformanceWanted(state, spec) && state.conformanceHalted === undefined) {
      const tested = testedOf(state);
      if (workOf("conformance", tested, state, spec).length > 0) {
        const testedKey = serializeTree(tested);
        const existing = state.conformancePlan;
        if (existing === undefined || existing.specKey !== specKey || existing.from !== testedKey || existing.jobs.length === 0) {
          state.conformancePlan = { specKey, from: testedKey, jobs: await plan(state, spec, tested, "conformance") };
        }
        const next = state.conformancePlan!.jobs[0];
        if (next !== undefined) {
          state.why = undefined;
          startJob(state, spec, tested, next);
          return;
        }
      } else state.conformancePlan = undefined;
    }
    const from = builtOf(state);
    if (codeWork(from, spec.tree).length === 0) {
      state.plan = undefined;
      state.why = state.conformanceHalted?.why ?? "built from the spec as it is";
      return;
    }
    const fromKey = serializeTree(from);
    if (state.plan === undefined || state.plan.specKey !== specKey || state.plan.from !== fromKey || state.plan.jobs.length === 0) {
      const jobs = await plan(state, spec, from);
      state.plan = { specKey, from: fromKey, jobs };
      if (jobs.length === 0) {
        state.why = "the planner found no way to cut the work into jobs that hold together";
        return;
      }
    }
    state.why = undefined;
    startJob(state, spec, from, state.plan.jobs[0]!);
  };

  const statusOf = (state: ModuleState): ModuleStatus => {
    // What runs next: the conformance tests' jobs, then the code's - the running job at the head of its own.
    const running = state.running?.planned;
    const own = (jobs: PlannedJob[] | undefined) => (jobs ?? []).filter((job) => job !== running);
    const planned = [...(running !== undefined ? [running] : []), ...own(state.conformancePlan?.jobs), ...own(state.plan?.jobs)];
    const tip = tipEntry(state);
    return {
      module: tip.moduleName,
      plainFile: tip.plainFile,
      ...(state.running !== undefined ? { running: { jobId: state.running.jobId, title: state.running.planned.title } } : {}),
      planned: (state.running !== undefined ? planned.slice(1) : planned).map((job) => ({ title: job.title, cases: job.cases, track: job.track })),
      ...(state.running === undefined && state.why !== undefined ? { why: state.why } : {}),
    };
  };

  /** Look after a codebase - its chain up to it - from now on; says its state. */
  const track = (chain: ChainEntry[], askedFile: string, request: { model?: string; guidance?: string }): ModuleState => {
    const tip = tipOf(chain);
    let state = modules.get(tip.buildDir);
    if (state === undefined) {
      state = { chain, askedFile, guidance: [] };
      modules.set(tip.buildDir, state);
      // Bottom of the chain first: a codebase is looked at after those it is built on.
      const at = order.findIndex((key) => modules.get(key)!.chain.some((entry) => entry.buildDir === tip.buildDir));
      if (at === -1) order.push(tip.buildDir);
      else order.splice(at, 0, tip.buildDir);
    }
    state.chain = chain;
    state.askedFile = askedFile;
    const model = request.model ?? options.modelFor?.(tip.plainFile);
    if (model !== undefined) state.model = model;
    if (request.guidance !== undefined && !state.guidance.includes(request.guidance)) state.guidance.push(request.guidance);
    return state;
  };

  const loop: WorkLoop = {
    async bringUp(plainFile, request = {}) {
      const file = resolve(options.cwd, plainFile);
      asked.set(file, { ...asked.get(file), ...request });
      const states = withParseCache(() =>
        chainsFor(file).flatMap((chain) => toBuild(chain).map((entry) => track(chain.slice(0, chain.indexOf(entry) + 1), file, request))),
      );
      // Asked again, a halted codebase is tried again.
      for (const state of states) state.halted = undefined;
      await tick();
      return [...new Set(states)].map(statusOf);
    },
    async regenerate(plainFile, frid, request = {}) {
      const asked = resolve(options.cwd, plainFile);
      const own = resolveRequiresChain(asked, [], undefined, { allowNoFunctionalities: true });
      const module = tipOf(own).moduleName;
      let taken = 0;
      for (const chain of chainsFor(asked)) {
        const tip = tipOf(chain);
        if (modules.get(tip.buildDir)?.running !== undefined) throw new Error(`${tip.moduleName} has a job running: ask again once it is done.`);
        const record = readRecord(tip.buildDir);
        if (record === null) continue;
        const section = tip.moduleName === module ? FUNCTIONAL_REQUIREMENTS : REQUIRED_FUNCTIONAL_SPECS;
        const items = (record[section] as Array<{ module?: string; frid?: string }> | undefined) ?? [];
        const kept = items.filter((item, index) => (section === FUNCTIONAL_REQUIREMENTS ? String(index + 1) !== frid : !(item.module === module && item.frid === frid)));
        if (kept.length === items.length) continue;
        writeCodeRecord(tip.buildDir, { ...record, [section]: kept } as MarshalledPlainSource);
        recordHistory(tip.buildDir, `${module} functional spec ${frid} to be built again`);
        taken += 1;
      }
      if (taken === 0) throw new Error(`${module} has no functional spec ${frid} built anywhere, so there is nothing to build again.`);
      return loop.bringUp(plainFile, request);
    },
    async conformance(plainFile, request = {}) {
      const file = resolve(options.cwd, plainFile);
      asked.set(file, { ...asked.get(file), ...(request.model !== undefined ? { model: request.model } : {}) });
      const states = withParseCache(() =>
        chainsFor(file).flatMap((chain) => toBuild(chain).map((entry) => track(chain.slice(0, chain.indexOf(entry) + 1), file, request))),
      );
      const tip = states.at(-1);
      for (const state of states) {
        // The functional specs named are the module's own: they are chosen in its codebase, the rest as they were.
        const named = state === tip && request.frids !== undefined && request.frids.length > 0 ? new Set(request.frids) : undefined;
        state.conformance = { ...(named !== undefined ? { chosen: named } : {}) };
        state.conformanceHalted = undefined;
        state.halted = undefined;
      }
      await tick();
      return [...new Set(states)].map(statusOf);
    },
    status() {
      return order.map((key) => statusOf(modules.get(key)!));
    },
    planned() {
      const now = Date.now();
      let sequence = Number.MAX_SAFE_INTEGER;
      // The last job - running or planned - of each module, by name: what a module waiting for it waits behind.
      const lastOf = new Map<string, string>();
      return order.flatMap((key) => {
        const state = modules.get(key)!;
        const tip = tipEntry(state);
        const status = statusOf(state);
        let before = status.running?.jobId;
        if (before !== undefined) lastOf.set(tip.moduleName, before);
        const row = (id: string, summary: string, note: string, waitingOn: string[]): Job => ({
          id,
          kind: "render_spec_diff",
          summary,
          note,
          ...(state.model !== undefined ? { model: state.model } : {}),
          status: "queued",
          sequence: sequence--,
          queuedAt: now,
          startedAt: now,
          waitingOn,
          tail: "",
          activity: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
          agents: [],
          transcript: [],
        });
        // Waiting for the module below it: not planned yet, but in the queue all the same - behind what it waits for.
        if (state.running === undefined && state.waitsFor !== undefined) {
          const behind = lastOf.get(state.waitsFor);
          const id = `planned-${tip.moduleName}-waiting`;
          lastOf.set(tip.moduleName, id);
          return [
            row(
              id,
              `${basename(tip.plainFile)} - waits for ${state.waitsFor}`,
              `Not planned yet: its work is planned into jobs once ${state.waitsFor} is built - the code it is built on.`,
              behind !== undefined ? [behind] : [],
            ),
          ];
        }
        return status.planned.map((job, index): Job => {
          const planned = row(
            `planned-${tip.moduleName}-${index + 1}`,
            `${basename(tip.plainFile)} ${job.track === "conformance" ? "conformance: " : ""}${job.title}`,
            `Planned, not started: ${casesText(job.cases)}. It is planned again whenever the spec changes or a job before it ends.`,
            before !== undefined ? [before] : [],
          );
          before = planned.id;
          lastOf.set(tip.moduleName, planned.id);
          return planned;
        });
      });
    },
    async drain() {
      for (;;) {
        await ticking;
        const running = order.map((key) => modules.get(key)!.running?.jobId).filter((id): id is string => id !== undefined);
        if (running.length === 0) return;
        await Promise.all(running.map((id) => options.registry.wait(id).catch(() => undefined)));
        // Its settling ticks: let it start what comes next before looking again.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
  };
  return loop;
}

/** A diff's lines placed in the .plain files of a chain - the tip's first - named as they are from the project. */
function whereInFiles(diff: string, chain: ChainEntry[]): DiffWhere {
  try {
    const files = [...chain].reverse().flatMap((entry) => specFilesOf(entry.plainFile));
    const unique = [...new Set(files)].map((path) => ({ name: relative(projectDirOf(chain.at(-1)!.plainFile), path) || basename(path), text: readFileSync(path, "utf8") }));
    return locateDiffLines(diff, unique);
  } catch {
    return {};
  }
}

/** What a job does, in a few words: its cases. */
function casesText(cases: JobCases): string {
  const parts = [
    ...(cases.fresh ? ["sets the project up"] : []),
    ...(cases.add.length > 0 ? [`adds ${cases.add.map((spec) => `fs ${spec.frid}`).join(", ")}`] : []),
    ...(cases.patch.length > 0 ? [`changes ${cases.patch.map((spec) => `fs ${spec.frid}`).join(", ")}`] : []),
    ...(cases.delete.length > 0 ? [`takes out ${cases.delete.map((spec) => `fs ${spec.frid}`).join(", ")}`] : []),
  ];
  return parts.length > 0 ? parts.join(", ") : "no functional spec - reqs or definitions only";
}

/** The codebases the loop looks after, as the person reads them: what runs, what is planned after it, and why nothing does. */
export function describeModules(statuses: ModuleStatus[]): string {
  if (statuses.length === 0) return "Nothing is being built.";
  return statuses
    .map((status) => {
      const lines = [`${status.module} (${basename(status.plainFile)}):`];
      if (status.running !== undefined) lines.push(`  running: job ${status.running.jobId} - ${status.running.title}`);
      status.planned.forEach((job, index) => lines.push(`  ${index + 1}. ${job.track === "conformance" ? "conformance tests: " : ""}${job.title} - ${casesText(job.cases)}`));
      if (status.why !== undefined) lines.push(`  ${status.why}`);
      return lines.join("\n");
    })
    .join("\n");
}

/**
 * A conformance job: its tests written and run for its change - a failure judged, the test or the code fixed - then the
 * whole suite, the tests the module inherits with it. Passing, what the tests are written for is recorded and committed;
 * otherwise all of it - the code's fixes too - is undone.
 */
const defaultConformanceRunner: JobRunner = async (job, onDelta) => {
  const result = await renderSpecDiffConformance({
    plainFile: job.plainFile,
    diff: job.planned.step.textDiff,
    change: describeSpecChange(job.planned.step.changes),
    cwd: job.cwd,
    applied: "already applied",
    spec: job.spec,
    ...(job.model !== undefined ? { model: job.model } : {}),
    onDelta,
  });
  if (result.passed) {
    writeTestsRecord(result.conformanceDir, job.planned.step.tree);
    recordHistory(job.buildDir, `conformance tests: ${job.planned.title}`);
  }
  return { landed: result.passed, report: describeSpecDiffConformance(result) };
};

/** A job as a spec diff render, landed on its unit tests: conformance is a track of its own. */
const defaultRunner: JobRunner = async (job, onDelta) => {
  const result = await renderSpecDiff({
    plainFile: job.plainFile,
    diff: job.planned.step.textDiff,
    cwd: job.cwd,
    applied: "already applied",
    spec: job.spec,
    conformance: false,
    regression: false,
    ...(job.model !== undefined ? { model: job.model } : {}),
    onDelta,
  });
  // Landed code can be tried.
  return { landed: result.passed, report: withTryItLine(describeSpecDiff(result), result.passed && result.restructured !== true) };
};
