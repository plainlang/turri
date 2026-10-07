import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { plainFileParser, withParseCache } from "../plain/parser.ts";
import { ACCEPTANCE_TESTS, FUNCTIONAL_REQUIREMENTS, REQUIRED_FUNCTIONAL_SPECS, TEST_REQUIREMENTS, type MarshalledPlainSource } from "../plain/spec.ts";
import { reportActivity, reportStage } from "./activity.ts";
import { llmChunkAgents, planChunks, stepsOf, type ChunkAgents, type PlanInput } from "./chunk-plan.ts";
import { recordHistory, resetToLastCommit } from "./lineage.ts";
import { createJobRegistry, type Job, type JobRegistry } from "./jobs.ts";
import { moduleLanes } from "./lanes.ts";
import type { Steering } from "./steer.ts";
import {
  adoptDigests,
  chainTree,
  codeTree,
  conformanceTarget,
  GROW_AGAIN,
  inheritedRecord,
  notBuilt,
  readRecord,
  RECORD_FILE,
  withResourceDigests,
  writeCodeRecord,
  writeTestsRecord,
  type Chosen,
} from "./records.ts";
import { describeSpecDiffConformance, renderSpecDiffConformance } from "./bind.ts";
import { conformanceDirFor } from "./conformance.ts";
import { modulesRoot } from "./paths.ts";
import { budgetFor, configForSpec } from "../config.ts";
import { describeSpecChange } from "./prompt.ts";
import { resolveTemplateDirs } from "./paths.ts";
import { builtTips, copyRequiredCode, newlyRequired, resolveRequiresChain, startFromScratch, type ChainEntry } from "./requires.ts";
import { withTryItLine } from "./delivery.ts";
import { describeSpecDiff, renderSpecDiff, specFilesOf, type SpecSnapshot } from "./regrow.ts";
import { locateDiffLines, type DiffWhere } from "./diff-view.ts";
import { agentChanges, changeDiffInFiles } from "./change-view.ts";
import { createSteering, MAX_STEERS, markTold, steer, waitingSteer, type JobSteering } from "./steering.ts";
import { projectDirOf } from "./paths.ts";
import { changesBetween, parseTree, serializeTree, type SpecChange, type SpecStep } from "./spec-steps.ts";
import { listFiles } from "./testing.ts";
import { casesOf, codeWork, stillWanted, whyNotWanted, type JobCases, type TouchedSpec } from "./drift.ts";

/**
 * The work loop - see docs/growing.md.
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
  job: {
    plainFile: string;
    moduleName: string;
    buildDir: string;
    spec: SpecSnapshot;
    planned: PlannedJob;
    model?: string;
    cwd: string;
    /** A code job's: how the loop steers it when the spec changes inside what it grows - and the record it lands. */
    steering?: JobSteering;
  },
  onDelta: (delta: string) => void,
) => Promise<{ landed: boolean; report: string }>;

/** A codebase as the loop sees it, for the person. */
export interface ModuleStatus {
  module: string;
  plainFile: string;
  /** The job running now, if one is. */
  running?: { jobId: string; title: string; steered?: string[] };
  /**
   * The jobs planned after it, in order: the module's code jobs, then its conformance jobs. A conformance job scheduled
   * for functional specs not all built yet - `waitsFor`, those that are not - comes after the module's last code job.
   */
  planned: Array<{ title: string; cases: JobCases; track: Track; waitsFor?: string[]; planning?: true }>;
  /**
   * Under `conformance-tests: chosen`: the functional specs the planned code jobs add or change that no conformance
   * test is for, is chosen to be, or is scheduled - for the conversation to choose from now.
   */
  toChoose?: TouchedSpec[];
  /** Under `conformance-budget:`: how many more of the module's functional specs may be chosen. Unset: no limit. */
  chooseBudget?: number;
  /** Why nothing runs there, when nothing does. */
  why?: string;
  /**
   * It now requires modules its code was not built on - `requires` - and is built only once its code is started
   * over on them: these codebases' code and tests taken out, kept in their history, and built again from the
   * bottom of the chain. Never done unasked: `startOver` does it.
   */
  startOver?: { requires: string[]; codebases: string[] };
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
  running?: {
    jobId: string;
    planned: PlannedJob;
    from: MarshalledPlainSource;
    after: MarshalledPlainSource;
    stopping?: boolean;
    /** Running on although the spec moved on from it - allow-to-stop-jobs is false - and why: said once a reason. */
    keptDespite?: string;
    /** A code job's steering: what it lands, what its agent is told, and how many times it was steered. */
    steering?: JobSteering;
  };
  /**
   * Conformance tests asked for in the conversation - over a config that has them off - and for which functional
   * specs: none named, every one. Not asked: as the config says.
   */
  conformance?: { chosen?: Set<string> };
  /** The conformance tests a job a functional spec, as the person asked when they asked for them - not one job for all. */
  conformanceSeparately?: boolean;
  /**
   * Conformance tests the conversation scheduled, one group a request, for functional specs not all built yet -
   * `unbuilt`, those that are not, as of the last look. A group is chosen once the code record has every one of
   * them as the spec has it, and its tests are then written once the module's code is built.
   */
  scheduled?: Array<{ specs: TouchedSpec[]; unbuilt: string[] }>;
  /** The groups scheduled that are chosen now, their tests not written yet: shown as what is planned while it is planned. */
  together?: TouchedSpec[][];
  /** The track being planned into jobs now, nothing running: what is next is shown while it is. */
  planning?: Track;
  /** The conformance tests halted, the code going on: until the spec or the code changes from `key`, or they are asked for again. */
  conformanceHalted?: { why: string; key: string };
  /** Nothing runs here until the spec changes from `specKey`, or it is asked for again. */
  halted?: { why: string; specKey: string };
  /** The spec as the last look read it. */
  seen?: SpecSnapshot;
  /** Why the last look started nothing here. */
  why?: string;
  /** The module below it that it waits for, while it does: not planned until that one is built. */
  waitsFor?: string;
  /** Its code has to be started over on modules it was not built on - see `ModuleStatus.startOver`. */
  startOver?: ModuleStatus["startOver"];
}

/** What is left to grow in a codebase - see `WorkLoop.drift`. */
export interface DriftReport {
  module: string;
  plainFile: string;
  /** The code's work, from its record to the spec now: null, none - built from the spec as it is. */
  code: JobCases | null | undefined;
  /** The conformance tests' work: null, none; undefined, none are written here. */
  conformance: JobCases | null | undefined;
  /** Conformance tests scheduled ahead of their code, and which of their functional specs are not built yet. */
  scheduled: Array<{ frids: string[]; unbuilt: string[] }>;
  running?: { jobId: string; title: string };
  /** Why nothing grows there: halted, or its spec does not parse. */
  why?: string;
  startOver?: ModuleStatus["startOver"];
}

/** What is left to grow, as the conversation and the command line read it. */
export function describeDrift(reports: DriftReport[]): string {
  if (reports.length === 0) return "Nothing to look at: no module of that spec.";
  const cases = (work: JobCases) => casesText(work);
  // Fully grown: in every codebase the code - and its conformance tests, where there are any - grown from the spec as it
  // is, nothing growing or waiting, and nothing holding the codebase back. A pulse that did not land leaves its work
  // undone, so it shows as drift.
  // conformance: null is no drift, undefined none written here - either is grown; a case list is work left.
  const grown = reports.every((report) => report.code === null && (report.conformance === null || report.conformance === undefined));
  const settled = reports.every((report) => report.running === undefined && report.why === undefined && report.startOver === undefined && report.scheduled.length === 0);
  const verdict = grown && settled ? "\nFully grown: every codebase is grown from the spec as it is, and nothing is growing." : "";
  return reports
    .map((report) => {
      const lines = [`${report.module} (${basename(report.plainFile)}):`];
      if (report.code === null) lines.push("  code: grown from the spec as it is - no drift");
      else if (report.code !== undefined) lines.push(`  code: drifted from the spec - to grow: ${cases(report.code)}`);
      if (report.conformance === null) lines.push("  conformance tests: written for what is built - no drift");
      else if (report.conformance !== undefined) lines.push(`  conformance tests: to write or change - ${cases(report.conformance)}`);
      else lines.push("  conformance tests: none written here");
      for (const group of report.scheduled) lines.push(`  bound ahead: fs ${group.frids.join(", fs ")} - once ${group.unbuilt.map((frid) => `fs ${frid}`).join(", ")} ${group.unbuilt.length === 1 ? "is" : "are"} grown`);
      if (report.running !== undefined) lines.push(`  growing now: pulse ${report.running.jobId} - ${report.running.title}`);
      if (report.why !== undefined) lines.push(`  ${report.why}`);
      if (report.startOver !== undefined) lines.push(`  it has to be rejuvenated on ${report.startOver.requires.join(", ")} before anything more grows there`);
      return lines.join("\n");
    })
    .join("\n") + verdict;
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
   * Grow functional specs of a module again, their spec changed or not: each is marked to grow again in the record
   * of every codebase it is built in - committed - and they are brought up to their spec, the marked ones planned as
   * any change is. Their code is there: the jobs that grow them are told to grow it again, not to build it anew.
   */
  growAgain(plainFile: string, frids: string | string[], options?: { model?: string }): Promise<ModuleStatus[]>;
  /**
   * What is left to grow, for a spec's module, in each codebase where its code lives: the code's work from its record to
   * the spec now, and the conformance tests' - planning nothing, starting nothing.
   */
  drift(plainFile: string): DriftReport[];
  /**
   * Write and run the conformance tests of a spec's module - of the functional specs named, or of every one - on the
   * code as it is built, in the codebases where its code lives: for this session, whatever the config says. Asked
   * again, it clears a halt. Says what it planned.
   */
  conformance(plainFile: string, options?: { frids?: string[]; model?: string; separately?: boolean }): Promise<ModuleStatus[]>;
  /**
   * Start over the codebases of a spec's module that now require a module their code was not built on (see
   * `ModuleStatus.startOver`): their code and conformance tests taken out - committed, so their history keeps
   * them - and the module brought up, from the bottom of its chain. Destructive: asked for only once the person
   * agreed. Says what it planned.
   */
  startOver(plainFile: string, options?: { model?: string }): Promise<ModuleStatus[]>;
  /** Every codebase the loop looks after, bottom of each chain first. */
  status(): ModuleStatus[];
  /**
   * The jobs planned after the running ones, as jobs are listed - queued, each after the one before it -
   * for the job panel and growth. Not started, they are not the registry's: planned again, they change.
   */
  planned(): Job[];
  /** Resolves once nothing runs and nothing more can start. */
  drain(): Promise<void>;
  /** In a dry run: the job each codebase would start, with the spec it would be given. */
  firsts(): Array<{ module: string; plainFile: string; buildDir: string; spec: SpecSnapshot; planned: PlannedJob }>;
}

const tipOf = (chain: ChainEntry[]): ChainEntry => chain.at(-1)!;

/** Whether a module's codebase has been started: code in it, or a record. */
const started = (entry: ChainEntry) => listFiles(entry.buildDir).length > 0 || readRecord(entry.buildDir) !== null;

/** The spec a codebase is built from, as the .plain files have it now: its whole requires chain's. */
export function chainSpec(chain: ChainEntry[]): SpecSnapshot {
  // Each module's linked resources hashed where its links point: what a file holds is part of the spec.
  const trees = chain.map((entry) => {
    const dirs = resolveTemplateDirs(entry.plainFile);
    return { module: entry.moduleName, tree: withResourceDigests(plainFileParser(basename(entry.plainFile), dirs, { allowNoFunctionalities: true })[1], dirs) };
  });
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
  /**
   * Whether a module's conformance tests are for the functional specs chosen, not every one: those with acceptance
   * tests, those the conversation asked for, and those tested already. Default: `conformance-tests: chosen`.
   */
  conformanceChosen?: (plainFile: string) => boolean;
  /**
   * Under `conformance-tests: chosen`, asked what a code job that landed built or changed that no conformance test is
   * for - by whoever chooses without a conversation (`turri regrow`) - before the job ends: the functional specs it
   * names are scheduled as bind schedules them. The conversation is told in the job's report instead.
   */
  onChoose?: (plainFile: string, specs: TouchedSpec[], budget?: number) => Promise<string[] | undefined>;
  /**
   * Under `release-after-pulse: true`, what releases a pulse that landed, as its last stage - before the pulse ends, so
   * the module's next pulse starts on what is released. Its last reply goes in the pulse's report. Not given: nothing is.
   */
  release?: (input: { plainFile: string; moduleName: string; title: string; onDelta: (delta: string) => void }) => Promise<string>;
  /** Plan, and keep the job each codebase would start (`firsts`) - but start none. */
  dryRun?: boolean;
}): WorkLoop {
  const modules = new Map<string, ModuleState>();
  const order: string[] = [];
  const run: JobRunner = options.run ?? defaultRunner;
  const runConformance: JobRunner = options.runConformance ?? defaultConformanceRunner;
  const configConformance = options.conformanceOn ?? ((plainFile: string) => configForSpec(plainFile).conformanceTests !== false);
  const configChosen = options.conformanceChosen ?? ((plainFile: string) => configForSpec(plainFile).conformanceTests === "chosen");
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
    const tests = readRecord(testsDirOf(state));
    const target = conformanceTarget(readRecord(tipEntry(state).buildDir), tests, spec.tree, chosenOf(state, spec, tests));
    // No functional spec to test, and none tested: nothing to write - the reqs alone are no conformance job.
    const specsIn = (tree: MarshalledPlainSource | null) => ((tree?.[FUNCTIONAL_REQUIREMENTS] as unknown[] | undefined) ?? []).length;
    return specsIn(target) === 0 && specsIn(tests) === 0 ? (tests ?? {}) : target;
  };

  /**
   * Which functional specs the conformance tests are for: every one - unless the config has them for the chosen ones,
   * or the conversation named some over a config that has them off. Then: those named, those with acceptance tests
   * when the config chooses, and those tested already - a choice is kept, and tests are never taken out because
   * other functional specs were named.
   */
  const chosenOf = (state: ModuleState, spec: SpecSnapshot, tests: MarshalledPlainSource | null): Chosen | undefined => {
    const named = state.conformance?.chosen;
    const choosing = configChosen(tipEntry(state).plainFile);
    if (!choosing && (state.conformance === undefined || named === undefined || configConformance(tipEntry(state).plainFile))) return undefined;
    if (choosing && state.conformance !== undefined && named === undefined) return undefined;
    const tested = new Set(((tests?.[FUNCTIONAL_REQUIREMENTS] as Array<{ frid?: string }> | undefined) ?? []).map((item) => item.frid));
    const specs = (spec.tree[FUNCTIONAL_REQUIREMENTS] as Array<{ [ACCEPTANCE_TESTS]?: unknown[] }> | undefined) ?? [];
    const accepted = (frid: string) => (specs[Number(frid) - 1]?.[ACCEPTANCE_TESTS] ?? []).length > 0;
    return (frid) => tested.has(frid) || named?.has(frid) === true || (choosing && accepted(frid));
  };

  /**
   * Under `conformance-tests: chosen`: the functional specs a code job built or changed that no conformance test is
   * for or is to be for - for the conversation to choose from.
   */
  const toChoose = (state: ModuleState, planned: PlannedJob, spec: SpecSnapshot): TouchedSpec[] => {
    if (planned.track !== "code" || !configChosen(tipEntry(state).plainFile)) return [];
    const chosen = chosenOf(state, spec, readRecord(testsDirOf(state)));
    if (chosen === undefined) return [];
    const scheduled = new Set((state.scheduled ?? []).flatMap((group) => group.specs.map((touched) => touched.frid)));
    return [...planned.cases.add, ...planned.cases.patch].filter((touched) => !chosen(touched.frid) && !scheduled.has(touched.frid));
  };

  /**
   * Under `conformance-budget:`: how many more of the module's functional specs may be chosen - the budget less every
   * one chosen for it already, tested or scheduled, whenever that was; those with acceptance tests do not count. Undefined:
   * no budget.
   */
  const budgetLeft = (state: ModuleState, spec: SpecSnapshot): number | undefined => {
    const budget = configForSpec(tipEntry(state).plainFile).conformanceBudget;
    if (budget === undefined) return undefined;
    const items = (spec.tree[FUNCTIONAL_REQUIREMENTS] as Array<{ [ACCEPTANCE_TESTS]?: unknown[] }> | undefined) ?? [];
    const tests = readRecord(testsDirOf(state));
    const tested = new Set(((tests?.[FUNCTIONAL_REQUIREMENTS] as Array<{ frid?: string }> | undefined) ?? []).map((item) => item.frid));
    const named = state.conformance?.chosen ?? new Set<string>();
    const scheduled = new Set((state.scheduled ?? []).flatMap((group) => group.specs.map((touched) => touched.frid)));
    const used = items.filter((item, index) => {
      const frid = String(index + 1);
      return (item[ACCEPTANCE_TESTS] ?? []).length === 0 && (tested.has(frid) || named.has(frid) || scheduled.has(frid));
    }).length;
    return Math.max(0, budgetFor(budget, items.length) - used);
  };

  /**
   * Under `conformance-tests: chosen`: every functional spec of the module that is built and that no conformance test
   * is for, chosen or scheduled - the module's whole choice, once its code is built.
   */
  const moduleToChoose = (state: ModuleState, spec: SpecSnapshot): TouchedSpec[] => {
    if (!configChosen(tipEntry(state).plainFile)) return [];
    const chosen = chosenOf(state, spec, readRecord(testsDirOf(state)));
    if (chosen === undefined) return [];
    const scheduled = new Set((state.scheduled ?? []).flatMap((group) => group.specs.map((touched) => touched.frid)));
    const items = (spec.tree[FUNCTIONAL_REQUIREMENTS] as Array<{ markdown: string }> | undefined) ?? [];
    const frids = items.map((_, index) => String(index + 1));
    const unbuilt = new Set(notBuilt(readRecord(tipEntry(state).buildDir), spec.tree, frids));
    return frids
      .filter((frid) => !unbuilt.has(frid) && !chosen(frid) && !scheduled.has(frid))
      .map((frid) => ({ frid, text: items[Number(frid) - 1]!.markdown.trim().split("\n")[0]!.replace(/^-\s*/, "").trim() }));
  };

  /**
   * The groups scheduled whose functional specs are all built, as the spec has them: chosen, so their tests are
   * written. A functional spec taken out of the spec is dropped from its group.
   */
  const promote = (state: ModuleState, spec: SpecSnapshot) => {
    const chosen = state.conformance?.chosen;
    if (state.scheduled === undefined || chosen === undefined) return;
    const count = ((spec.tree[FUNCTIONAL_REQUIREMENTS] as unknown[] | undefined) ?? []).length;
    const code = readRecord(tipEntry(state).buildDir);
    state.scheduled = state.scheduled.flatMap((group) => {
      const specs = group.specs.filter((touched) => Number(touched.frid) <= count);
      const unbuilt = notBuilt(code, spec.tree, specs.map((touched) => touched.frid));
      if (specs.length === 0) return [];
      if (unbuilt.length > 0) return [{ specs, unbuilt }];
      for (const touched of specs) chosen.add(touched.frid);
      state.together = [...(state.together ?? []), specs];
      // What the tests are to be written for changed: planned again - after the running job, when one runs.
      state.conformancePlan = undefined;
      return [];
    });
  };

  /** Whether a codebase's conformance tests are written: asked for, or on in the config - with test reqs to write them from, and code to test. */
  const conformanceWanted = (state: ModuleState, spec: SpecSnapshot): boolean =>
    (state.conformance !== undefined || configConformance(tipEntry(state).plainFile)) &&
    ((spec.tree[TEST_REQUIREMENTS] as unknown[] | undefined) ?? []).length > 0 &&
    readRecord(tipEntry(state).buildDir) !== null;

  /**
   * The functional specs a conformance job is scheduled for, as the spec has them now - refused when one is not in
   * the spec, or the module has no test reqs to write tests from: no code job would build it, or no test be written.
   */
  const scheduledSpecs = (state: ModuleState, frids: string[]): TouchedSpec[] => {
    const tip = tipEntry(state);
    const spec = chainSpec(state.chain);
    const items = (spec.tree[FUNCTIONAL_REQUIREMENTS] as Array<{ markdown: string }> | undefined) ?? [];
    const unknown = frids.filter((frid) => !/^[1-9]\d*$/.test(frid) || Number(frid) > items.length);
    if (unknown.length > 0) {
      throw new Error(
        `${tip.moduleName} has ${items.length} functional spec${items.length === 1 ? "" : "s"}, and ${unknown.map((frid) => `fs ${frid}`).join(", ")} ` +
          `${unknown.length === 1 ? "is not one of them" : "are not among them"}: no code pulse builds ${unknown.length === 1 ? "it" : "them"}, so no conformance ` +
          "test could ever be written for it. Nothing was scheduled.",
      );
    }
    if (((spec.tree[TEST_REQUIREMENTS] as unknown[] | undefined) ?? []).length === 0) {
      throw new Error(`${tip.moduleName} has no ***test reqs***: conformance tests are written from them, so none can be. Nothing was scheduled.`);
    }
    return frids.map((frid) => ({ frid, text: items[Number(frid) - 1]!.markdown.trim().split("\n")[0]!.replace(/^-\s*/, "").trim() }));
  };

  /** Functional specs of a module scheduled for conformance tests, beside those chosen before - as bind does for the module's own. */
  const schedule = (state: ModuleState, frids: string[]) => {
    const before = state.conformance;
    // Every one is tested already: nothing to add.
    if (before !== undefined && before.chosen === undefined) return;
    let specs: TouchedSpec[];
    try {
      specs = scheduledSpecs(state, frids);
    } catch (error) {
      reportActivity(`  ${tipEntry(state).moduleName}: the conformance tests chosen were not scheduled - ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    state.conformance = { chosen: before?.chosen ?? new Set() };
    state.scheduled = [...(state.scheduled ?? []), { specs, unbuilt: specs.map((touched) => touched.frid) }];
  };

  /** The work of a track, from where it is built from to what it is to be. */
  const workOf = (track: Track, from: MarshalledPlainSource, state: ModuleState, spec: SpecSnapshot) =>
    track === "code" ? codeWork(from, spec.tree) : changesBetween(serializeTree(from), serializeTree(conformanceOf(state, spec)));

  /** The codebases brought up in this look: one left behind is never waited for. */
  let looking = new Set<ModuleState>();

  /**
   * The module below this one that it waits for, and why: one with a job running, code left to build, or conformance
   * tests wanted and not yet written and passing - a codebase starts from the code and the conformance tests below it,
   * so they pass before anything is built on them. Conformance tests below that did not pass hold it until they do.
   */
  const waitingOn = (state: ModuleState): { module: string; why: string } | undefined => {
    for (const entry of state.chain.slice(0, -1)) {
      const below = modules.get(entry.buildDir);
      if (below === undefined || (!looking.has(below) && below.running === undefined)) continue;
      const waiting = (why: string) => ({ module: entry.moduleName, why: `waiting for ${entry.moduleName}: ${why}` });
      if (below.running !== undefined) return waiting(below.running.planned.track === "conformance" ? "its conformance tests are being written" : "the code it is built on is not built yet");
      const spec = chainSpec(below.chain);
      if (codeWork(builtOf(below), spec.tree).length > 0) return waiting("the code it is built on is not built yet");
      if (below.conformanceHalted !== undefined) return waiting(`its conformance tests did not pass - ${below.conformanceHalted.why}`);
      if ((below.scheduled ?? []).length > 0) return waiting("the conformance tests chosen for it are not written yet");
      if (conformanceWanted(below, spec) && workOf("conformance", testedOf(below), below, spec).length > 0) return waiting("its conformance tests are not written yet");
    }
    return undefined;
  };

  /**
   * Steer the running code job when the spec moved on inside what it grows: its target moved to the spec as it now is
   * there, its agent told - now, in its turn, or when the step it is at ends - its view in the panel moved too. Whatever
   * else changed is the next job's. True when it was steered: not a third time, unless into a steer still waiting.
   */
  const trySteer = (state: ModuleState, spec: SpecSnapshot, own: SpecChange[], work: SpecChange[]): boolean => {
    const running = state.running;
    const steering = running?.steering;
    if (running === undefined || steering === undefined || running.planned.track !== "code") return false;
    const waiting = waitingSteer(steering) !== undefined;
    if (steering.steers >= MAX_STEERS && !waiting) return false;
    const moved = steer(steering, running.from, own, (tree) => workOf("code", tree, state, spec));
    if (moved === undefined) return false;
    // Steered, everything it grows is wanted - else something it grows was taken out, and that is no steer.
    if (!stillWanted(changesBetween(serializeTree(running.from), serializeTree(moved.target)), work)) return false;
    const why = whyNotWanted(own, work);
    steering.target = moved.target;
    steering.agent = moved.agent;
    if (!waiting) steering.steers += 1;
    steering.notes.push(why);
    running.after = moved.target;
    const text = waitingSteer(steering);
    if (text !== undefined && steering.deliver?.(text) === true) markTold(steering);
    const tip = tipEntry(state);
    const job = options.registry.get(running.jobId);
    if (job !== undefined) {
      const shown = changeDiffInFiles(
        agentChanges(changesBetween(serializeTree(running.from), serializeTree(steering.agent)), "code"),
        relative(projectDirOf(tip.plainFile), tip.plainFile) || basename(tip.plainFile),
        (diff) => whereInFiles(diff, state.chain),
      );
      job.diff = shown.diff;
      job.diffWhere = shown.where;
    }
    reportActivity(`  ⇢ steered pulse ${running.jobId} (${steering.steers} of ${MAX_STEERS}): ${why}`);
    return true;
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
    const separately = track === "conformance" && state.conformanceSeparately === true;
    const input: PlanInput = { base: from, current, specFile, specText, steering, track, moduleName: tip.moduleName, ...(separately ? { separately } : {}) };
    const model = typeof options.plannerModel === "function" ? options.plannerModel() : options.plannerModel;
    const agents = options.planner === false ? undefined : (options.planner ?? llmChunkAgents({ cwd: options.cwd, model: model ?? state.model, label: `${basename(tip.plainFile)} planner` }));
    reportStage(`${tip.moduleName}: planning the ${track === "code" ? "work" : "conformance tests"} into pulses`);
    const draft = await planChunks(input, agents);
    const fresh = tip.requires === null && (track === "code" ? !started(tip) : readRecord(testsDirOf(state)) === null);
    return stepsOf(input, draft).map((job, index) => {
      // Its cases from its own change: the spec before it to the spec after it - the plan's changes are numbered from where the plan starts.
      const cases = casesOf(parseTree(job.step.before), changesBetween(job.step.before, job.step.after), { fresh: fresh && index === 0, module: tip.moduleName });
      return { title: job.title, reason: job.reason, cases, step: job.step, track };
    });
  };

  /** Plan a track with nothing running: while the planner works, the codebase says so rather than showing nothing. */
  const planIdle = async (state: ModuleState, spec: SpecSnapshot, from: MarshalledPlainSource, track: Track): Promise<PlannedJob[]> => {
    state.planning = track;
    try {
      return await plan(state, spec, from, track);
    } finally {
      state.planning = undefined;
    }
  };

  /** A dry run's first jobs, by codebase: what each would start. */
  const firsts = new Map<string, { spec: SpecSnapshot; planned: PlannedJob }>();

  const startJob = (state: ModuleState, spec: SpecSnapshot, from: MarshalledPlainSource, planned: PlannedJob) => {
    const tip = tipEntry(state);
    if (options.dryRun === true) {
      firsts.set(tip.buildDir, { spec: planned.track === "conformance" ? spec : { ...spec, tree: planned.step.tree }, planned });
      state.why = `would start: ${planned.title}`;
      return;
    }
    const conformance = planned.track === "conformance";
    // A code job can be steered while it grows: its target moves with the spec, inside what it grows.
    const steering = conformance ? undefined : createSteering(planned.step.tree, tip.moduleName);
    // Shown as its agent is given it: the job's own items, from whichever file they are written in - its imports too.
    const shown = changeDiffInFiles(
      agentChanges(planned.step.changes, planned.track),
      relative(projectDirOf(tip.plainFile), tip.plainFile) || basename(tip.plainFile),
      (diff) => whereInFiles(diff, state.chain),
    );
    const job: Job = options.registry.start({
      kind: conformance ? "bind" : "regrow",
      summary: `${basename(tip.plainFile)} ${conformance ? "conformance: " : ""}${planned.title}`,
      module: tip.moduleName,
      diff: shown.diff,
      ...(state.model !== undefined ? { model: state.model } : {}),
      lanes: [...moduleLanes(tip.plainFile, options.buildDir)],
      rerun: `turri regrow ${relative(options.cwd, tip.plainFile) || basename(tip.plainFile)}`,
      run: async (onDelta) => {
        // The guardrail: a conformance job tests only code that is built - the code record, read as the job starts, has every functional spec it tests as it tests it.
        if (conformance) {
          const testing = [...planned.cases.add, ...planned.cases.patch].map((touched) => touched.frid);
          const missing = notBuilt(readRecord(tip.buildDir), planned.step.tree, testing);
          if (missing.length > 0) {
            const record = relative(options.cwd, join(tip.buildDir, RECORD_FILE));
            const notBuiltText = `${missing.map((frid) => `fs ${frid}`).join(", ")} ${missing.length === 1 ? "is" : "are"} not built`;
            return {
              report:
                `Not started: this conformance pulse is to test ${testing.map((frid) => `fs ${frid}`).join(", ")}, and ${notBuiltText} - ` +
                `${record} does not have ${missing.length === 1 ? "it" : "them"} as the spec has ${missing.length === 1 ? "it" : "them"}. ` +
                "No conformance test is written for code that is not built. Tell the user, and see with drift which code pulse grows it.",
              details: { passed: false, landed: false, notBuilt: notBuiltText },
            };
          }
        }
        // Nothing here yet: the codebase starts as a copy of the one it is built on, recorded as what it inherits.
        if (tip.requires !== null && !started(tip)) {
          const below = state.chain.find((entry) => entry.moduleName === tip.requires);
          const source = below === undefined ? null : readRecord(below.buildDir);
          if (below !== undefined && source !== null) {
            copyRequiredCode(below.buildDir, tip.buildDir, tip.moduleName, below.moduleName);
            // Its conformance tests come with the code, the ones below's: none of its own is written yet.
            if (existsSync(join(testsDirOf(state), RECORD_FILE))) writeTestsRecord(testsDirOf(state), {});
          }
        }
        // A conformance job is shown the spec whole - its test reqs and acceptance tests are its to write from.
        const result = await (conformance ? runConformance : run)(
          {
            plainFile: tip.plainFile,
            moduleName: tip.moduleName,
            buildDir: tip.buildDir,
            spec: conformance ? spec : { ...spec, tree: planned.step.tree },
            planned,
            model: state.model,
            cwd: options.cwd,
            ...(steering !== undefined ? { steering } : {}),
          },
          onDelta,
        );
        // Under conformance-tests: chosen, what it built that no conformance test is for is the conversation's to choose.
        const choose = result.landed ? toChoose(state, planned, spec) : [];
        // Chosen without a conversation once the module's code is built - its last job landed - with the whole module
        // in view, before the job ends: scheduled before its conformance runs, and anything is built on it.
        if (result.landed && planned.track === "code" && options.onChoose !== undefined) {
          const now = chainSpec(state.chain);
          if (codeWork(builtOf(state), now.tree).length === 0) {
            const candidates = moduleToChoose(state, now);
            const left = budgetLeft(state, now);
            if (candidates.length > 0 && left === 0) reportActivity(`  ${tip.moduleName}: its conformance budget is spent - none of fs ${candidates.map((touched) => touched.frid).join(", ")} is chosen`);
            const picked = candidates.length > 0 && left !== 0 ? await options.onChoose(tip.plainFile, candidates, left) : undefined;
            // Within the budget, whatever was answered: the first that fit.
            if (picked !== undefined && picked.length > 0) schedule(state, left !== undefined ? picked.slice(0, left) : picked);
          }
        }
        const report =
          choose.length > 0
            ? `${result.report}\n\n${chooseNote(tip.plainFile, choose, budgetLeft(state, spec))}`
            : result.report;
        // Released as its last stage, when the config says so: the module's next pulse starts on what is released.
        let released: string | undefined;
        if (result.landed && options.release !== undefined && configForSpec(tip.plainFile).releaseAfterPulse === true) {
          reportStage(`module ${tip.moduleName}: releasing what this pulse landed (release-after-pulse)`);
          try {
            released = `Released after the pulse: ${(await options.release({ plainFile: tip.plainFile, moduleName: tip.moduleName, title: planned.title, onDelta })).trim()}`;
          } catch (error) {
            // What landed stays landed: a release that fails is said, and the next pulse goes on.
            released = `The release after the pulse failed: ${error instanceof Error ? error.message : String(error)}`;
          }
          reportActivity(`  ${released.split("\n")[0]}`);
        }
        return {
          report: released !== undefined ? `${report}\n\n${released}` : report,
          details: { passed: result.landed, landed: result.landed, ...(released !== undefined ? { released: true } : {}) },
        };
      },
    });
    // Its lines where they are written: the module's .plain file, those it imports, and those of the modules below it.
    job.diffWhere = shown.where;
    state.running = { jobId: job.id, planned, from, after: planned.step.tree, ...(steering !== undefined ? { steering } : {}) };
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
        const unbuilt = (settled?.details as { notBuilt?: string } | undefined)?.notBuilt;
        const why =
          settled?.status === "stopped"
            ? `pulse ${running.jobId} was stopped`
            : unbuilt !== undefined
              ? `conformance pulse ${running.jobId} ("${running.planned.title}") did not start: ${unbuilt}`
              : `conformance pulse ${running.jobId} ("${running.planned.title}") did not pass`;
        state.conformanceHalted = { why: `${why} - its conformance tests are written again once the spec or the code changes, or they are asked for again`, key: conformanceKey(state) };
        // Nothing more is built on code whose conformance tests did not pass: its code halts too, and what is above waits.
        let key = "";
        try {
          key = keyOf(chainSpec(state.chain));
        } catch {
          /* a spec that does not parse halts it all the same */
        }
        state.halted = { why: `${why} - nothing more is built on it until its conformance tests pass`, specKey: key };
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
        const why = settled?.status === "stopped" ? `pulse ${running.jobId} was stopped` : `pulse ${running.jobId} ("${running.planned.title}") did not land`;
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

  /**
   * A record written before linked resources were hashed has the hashes of the files as they are now - committed, with
   * nothing running there - so the code is taken to be built from them, rather than everything linking one built again.
   */
  const hashResources = (state: ModuleState, spec: SpecSnapshot) => {
    // A dry run only reads.
    if (options.dryRun === true) return;
    const code = tipEntry(state).buildDir;
    for (const dir of [code, testsDirOf(state)]) {
      const record = readRecord(dir);
      const hashed = adoptDigests(record, spec.tree);
      if (record === null || hashed === null || serializeTree(hashed) === serializeTree(record)) continue;
      (dir === code ? writeCodeRecord : writeTestsRecord)(dir, hashed);
      recordHistory(dir, "the record's linked resources hashed, as their files are now");
    }
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
    state.seen = spec;
    promote(state, spec);

    if (state.running !== undefined) {
      if (state.running.stopping === true) return;
      // The stop rule: every change the running job makes is still part of the work, measured from the same record.
      const track = state.running.planned.track;
      const own = changesBetween(serializeTree(state.running.from), serializeTree(state.running.after));
      let work = workOf(track, state.running.from, state, spec);
      // A change inside what it grows steers it, rather than stopping it or leaving it to the next job.
      if (!stillWanted(own, work) && trySteer(state, spec, own, work)) work = workOf(track, state.running.from, state, spec);
      const ownNow = changesBetween(serializeTree(state.running.from), serializeTree(state.running.after));
      if (!stillWanted(ownNow, work)) {
        const why = whyNotWanted(ownNow, work);
        // The project may have it run to its end instead: what it lands, the next job grows the change on top of.
        if (configForSpec(tip.plainFile).allowToStopJobs === false) {
          if (state.running.keptDespite !== why) {
            state.running.keptDespite = why;
            reportActivity(`  ${tip.moduleName}: pulse ${state.running.jobId} runs on although ${why} - allow-to-stop-jobs is false: the change is grown on top of what it lands`);
          }
        } else {
          state.running.stopping = true;
          state.why = `pulse ${state.running.jobId} was stopped: ${why}, which it was growing from`;
          reportActivity(`  ${tip.moduleName}: ${state.why}`);
          options.registry.stop(
            state.running.jobId,
            `Stopped by turri, not by you: ${why}, which it was growing from. What it had done is rolled back, and the spec as it is now is grown instead. To have a running pulse finish first and the change grown on top of it, set allow-to-stop-jobs: false in config.yaml.`,
          );
          return;
        }
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
    hashResources(state, spec);
    if (state.halted !== undefined) {
      if (state.halted.specKey === specKey) {
        state.why = state.halted.why;
        return;
      }
      state.halted = undefined;
    }
    const fresh = newlyRequired(state.chain);
    state.startOver = undefined;
    if (fresh !== undefined && fresh.rebuild.some((entry) => entry.buildDir === tip.buildDir)) {
      const codebases = fresh.rebuild.map((entry) => entry.moduleName);
      state.startOver = { requires: fresh.modules, codebases };
      state.why =
        `it now requires ${fresh.modules.join(", ")}, which its code was not built on: it is built only once ` +
        `${codebases.join(", ")} ${codebases.length === 1 ? "is" : "are"} started over - code and conformance tests taken out, kept in the history, and built again on ${fresh.modules.join(", ")}`;
      return;
    }
    const below = waitingOn(state);
    state.waitsFor = below?.module;
    if (below !== undefined) {
      state.why = below.why;
      return;
    }
    // The module's code first, every job of it; then its conformance tests - once, for the module as built, with one
    // explorer and one run of the whole suite - and only then is anything built on it (waitingOn).
    const from = builtOf(state);
    const codeLeft = codeWork(from, spec.tree).length > 0;
    if (state.conformanceHalted !== undefined && state.conformanceHalted.key !== conformanceKey(state)) state.conformanceHalted = undefined;
    if (!codeLeft && conformanceWanted(state, spec) && state.conformanceHalted === undefined) {
      const tested = testedOf(state);
      if (workOf("conformance", tested, state, spec).length > 0) {
        const testedKey = serializeTree(tested);
        const existing = state.conformancePlan;
        if (existing === undefined || existing.specKey !== specKey || existing.from !== testedKey || existing.jobs.length === 0) {
          state.conformancePlan = { specKey, from: testedKey, jobs: await planIdle(state, spec, tested, "conformance") };
        }
        const next = state.conformancePlan!.jobs[0];
        if (next !== undefined) {
          state.why = undefined;
          startJob(state, spec, tested, next);
          return;
        }
      } else {
        state.conformancePlan = undefined;
        state.together = undefined;
      }
    }
    if (!codeLeft) {
      state.plan = undefined;
      state.why = state.conformanceHalted?.why ?? "built from the spec as it is";
      return;
    }
    const fromKey = serializeTree(from);
    if (state.plan === undefined || state.plan.specKey !== specKey || state.plan.from !== fromKey || state.plan.jobs.length === 0) {
      const jobs = await planIdle(state, spec, from, "code");
      state.plan = { specKey, from: fromKey, jobs };
      if (jobs.length === 0) {
        state.why = "the planner found no way to cut the work into pulses that hold together";
        return;
      }
    }
    state.why = undefined;
    startJob(state, spec, from, state.plan.jobs[0]!);
  };

  const statusOf = (state: ModuleState): ModuleStatus => {
    // What runs next: the code's jobs, then the conformance tests' - the module's, once its code is built - the running job first.
    const running = state.running?.planned;
    const own = (jobs: PlannedJob[] | undefined) => (jobs ?? []).filter((job) => job !== running);
    // A track being planned again shows as that, not as its plan before.
    const replanning = state.running === undefined ? state.planning : undefined;
    const jobs = [
      ...(running !== undefined ? [running] : []),
      ...(replanning === "code" ? [] : own(state.plan?.jobs)),
      ...(replanning === "conformance" ? [] : own(state.conformancePlan?.jobs)),
    ];
    // A scheduled conformance job comes after the module's last code job - last, when none is planned.
    const lastCode = jobs.findLastIndex((job) => job.track === "code");
    const after = (state.scheduled ?? []).map(() => lastCode);
    const scheduledAt = (index: number): ModuleStatus["planned"] =>
      (state.scheduled ?? []).flatMap((group, at) =>
        after[at] !== index
          ? []
          : [{ title: group.specs.map((touched) => `fs ${touched.frid}`).join(", "), cases: { fresh: false, add: group.specs, patch: [], again: [], delete: [], mechanical: false }, track: "conformance" as const, waitsFor: group.unbuilt }],
      );
    // Being planned, nothing running: what is next - for the conformance tests, the groups chosen that it plans - not nothing.
    const together = (state.together ?? []).flat().map((touched) => `fs ${touched.frid}`);
    const planningNow: ModuleStatus["planned"] =
      state.running === undefined && state.planning !== undefined
        ? [
            {
              title: state.planning === "conformance" ? (together.length > 0 ? together.join(", ") : "the conformance tests") : "the work",
              cases: { fresh: false, add: [], patch: [], again: [], delete: [], mechanical: false },
              track: state.planning,
              planning: true,
            },
          ]
        : [];
    const planned: ModuleStatus["planned"] = [
      ...planningNow,
      ...jobs.flatMap((job, index) => [{ title: job.title, cases: job.cases, track: job.track }, ...scheduledAt(index)]),
      ...scheduledAt(-1),
    ];
    const choose = new Map<string, TouchedSpec>();
    if (state.seen !== undefined) for (const job of jobs) for (const touched of toChoose(state, job, state.seen)) choose.set(touched.frid, touched);
    const tip = tipEntry(state);
    return {
      module: tip.moduleName,
      plainFile: tip.plainFile,
      ...(state.running !== undefined
        ? {
            running: {
              jobId: state.running.jobId,
              title: state.running.planned.title,
              ...(state.running.steering !== undefined && state.running.steering.steers > 0 ? { steered: [...state.running.steering.notes] } : {}),
            },
          }
        : {}),
      planned: state.running !== undefined ? planned.slice(1) : planned,
      ...(choose.size > 0 ? { toChoose: [...choose.values()] } : {}),
      ...(choose.size > 0 && state.seen !== undefined && budgetLeft(state, state.seen) !== undefined ? { chooseBudget: budgetLeft(state, state.seen) } : {}),
      ...(state.running === undefined && state.why !== undefined ? { why: state.why } : {}),
      ...(state.running === undefined && state.startOver !== undefined ? { startOver: state.startOver } : {}),
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
    async growAgain(plainFile, given, request = {}) {
      const frids = [...new Set(Array.isArray(given) ? given : [given])];
      const asked = resolve(options.cwd, plainFile);
      const own = resolveRequiresChain(asked, [], undefined, { allowNoFunctionalities: true });
      const module = tipOf(own).moduleName;
      const chains = chainsFor(asked);
      for (const chain of chains) {
        const tip = tipOf(chain);
        if (modules.get(tip.buildDir)?.running !== undefined) throw new Error(`${tip.moduleName} has a pulse running: ask again once it is done.`);
      }
      const found = new Set<string>();
      for (const chain of chains) {
        const tip = tipOf(chain);
        const record = readRecord(tip.buildDir);
        if (record === null) continue;
        const section = tip.moduleName === module ? FUNCTIONAL_REQUIREMENTS : REQUIRED_FUNCTIONAL_SPECS;
        const items = (record[section] as Array<{ module?: string; frid?: string }> | undefined) ?? [];
        const named = (item: { module?: string; frid?: string }, index: number) =>
          section === FUNCTIONAL_REQUIREMENTS ? String(index + 1) : item.module === module ? (item.frid ?? "") : "";
        const taken = items.flatMap((item, index) => (frids.includes(named(item, index)) ? [named(item, index)] : []));
        if (taken.length === 0) continue;
        for (const frid of taken) found.add(frid);
        const marked = items.map((item, index) => (frids.includes(named(item, index)) ? { ...item, [GROW_AGAIN]: true } : item));
        writeCodeRecord(tip.buildDir, { ...record, [section]: marked } as MarshalledPlainSource);
        recordHistory(tip.buildDir, `${module} functional spec${taken.length === 1 ? "" : "s"} ${taken.join(", ")} to grow again`);
      }
      const missing = frids.filter((frid) => !found.has(frid));
      if (found.size === 0) throw new Error(`${module} has no functional spec ${missing.join(", ")} built anywhere, so there is nothing to grow again: regrow grows what is not built.`);
      const statuses = await loop.bringUp(plainFile, request);
      if (missing.length > 0) reportActivity(`  ${module}: functional spec ${missing.join(", ")} is not built anywhere - nothing to grow again there`);
      return statuses;
    },
    drift(plainFile) {
      const file = resolve(options.cwd, plainFile);
      return withParseCache(() =>
        chainsFor(file).flatMap((chain) =>
          toBuild(chain).map((entry): DriftReport => {
            const codebase = chain.slice(0, chain.indexOf(entry) + 1);
            const tip = tipOf(codebase);
            // The codebase as the loop knows it, or - never asked for - as its records have it.
            const state = modules.get(tip.buildDir) ?? { chain: codebase, askedFile: file, guidance: [] };
            const report: DriftReport = { module: tip.moduleName, plainFile: tip.plainFile, code: undefined, conformance: undefined, scheduled: [] };
            let spec: SpecSnapshot;
            try {
              spec = chainSpec(codebase);
            } catch (error) {
              return { ...report, why: `its spec does not parse: ${error instanceof Error ? error.message : String(error)}` };
            }
            const from = builtOf(state);
            const fresh = tip.requires === null && !started(tip);
            const code = codeWork(from, spec.tree);
            report.code = code.length === 0 ? null : casesOf(from, code, { fresh, module: tip.moduleName });
            if (conformanceWanted(state, spec)) {
              const tested = testedOf(state);
              const tests = workOf("conformance", tested, state, spec);
              report.conformance = tests.length === 0 ? null : casesOf(tested, tests, { module: tip.moduleName });
            }
            report.scheduled = (state.scheduled ?? []).map((group) => ({ frids: group.specs.map((touched) => touched.frid), unbuilt: group.unbuilt }));
            if (state.running !== undefined) report.running = { jobId: state.running.jobId, title: state.running.planned.title };
            const halted = state.halted?.why ?? state.conformanceHalted?.why;
            if (halted !== undefined) report.why = halted;
            if (state.startOver !== undefined) report.startOver = state.startOver;
            return report;
          }),
        ),
      );
    },
    async conformance(plainFile, request = {}) {
      const file = resolve(options.cwd, plainFile);
      asked.set(file, { ...asked.get(file), ...(request.model !== undefined ? { model: request.model } : {}) });
      const states = withParseCache(() =>
        chainsFor(file).flatMap((chain) => toBuild(chain).map((entry) => track(chain.slice(0, chain.indexOf(entry) + 1), file, request))),
      );
      const tip = states.at(-1);
      const asks = request.frids !== undefined && request.frids.length > 0 ? [...new Set(request.frids)] : undefined;
      // Refused before anything is chosen: a functional spec the spec does not have is built by no code job, so its tests could never be written.
      const specs = tip !== undefined && asks !== undefined ? scheduledSpecs(tip, asks) : undefined;
      for (const state of states) {
        // The functional specs named are the module's own: they are scheduled in its codebase, beside those chosen before.
        const named = state === tip ? specs : undefined;
        const before = state.conformance;
        // Asked for every one before, or now: every one.
        const all = (before !== undefined && before.chosen === undefined) || named === undefined;
        state.conformance = all ? {} : { chosen: before?.chosen ?? new Set() };
        // Scheduled now, chosen once all of them are built - at once, those that are.
        state.scheduled = all ? undefined : [...(state.scheduled ?? []), { specs: named, unbuilt: named.map((touched) => touched.frid) }];
        // One job for all of them, or one a functional spec: as this request asks. Changed, the plan is made again.
        const separately = request.separately === true;
        if ((state.conformanceSeparately === true) !== separately) state.conformancePlan = undefined;
        state.conformanceSeparately = separately;
        state.conformanceHalted = undefined;
        state.halted = undefined;
      }
      await tick();
      return [...new Set(states)].map(statusOf);
    },
    async startOver(plainFile, request = {}) {
      const file = resolve(options.cwd, plainFile);
      const own = resolveRequiresChain(file, [], undefined, { allowNoFunctionalities: true });
      const rebuild = new Map<string, { entry: ChainEntry; requires: string[] }>();
      for (const chain of [...chainsFor(file), own]) {
        const fresh = newlyRequired(chain);
        for (const entry of fresh?.rebuild ?? []) rebuild.set(entry.buildDir, { entry, requires: fresh!.modules });
      }
      if (rebuild.size === 0) throw new Error(`Nothing of ${tipOf(own).moduleName} has to be started over: its code is built on every module it requires.`);
      for (const { entry } of rebuild.values()) {
        if (modules.get(entry.buildDir)?.running !== undefined) throw new Error(`${entry.moduleName} has a pulse running: ask again once it is done.`);
      }
      for (const { entry, requires } of rebuild.values()) {
        startFromScratch(entry, `it now requires ${requires.join(", ")}, which its code was not built on`);
        const state = modules.get(entry.buildDir);
        if (state !== undefined) {
          state.plan = undefined;
          state.conformancePlan = undefined;
          state.halted = undefined;
          state.conformanceHalted = undefined;
          state.startOver = undefined;
        }
      }
      return loop.bringUp(plainFile, request);
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
        const row = (id: string, summary: string, note: string, waitingOn: string[], conformance = false): Job => ({
          id,
          kind: conformance ? "bind" : "regrow",
          summary,
          module: tip.moduleName,
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
              `Not planned yet: its work is planned into pulses once ${state.waitsFor} is built - the code it is built on.`,
              behind !== undefined ? [behind] : [],
            ),
          ];
        }
        return status.planned.map((job, index): Job => {
          const planned = row(
            `planned-${tip.moduleName}-${index + 1}`,
            `${basename(tip.plainFile)} ${job.track === "conformance" ? "conformance: " : ""}${job.title}`,
            job.waitsFor !== undefined
              ? `Scheduled, not started: the conformance tests of ${job.title}, once ${waitsText(job.waitsFor)} built - the code record has to have them first.`
            : job.planning === true
              ? `Being planned into pulses now: ${job.title}. The first starts as soon as the plan is made.`
              : `Planned, not started: ${casesText(job.cases)}. It is planned again whenever the spec changes or a pulse before it ends.`,
            before !== undefined ? [before] : [],
            job.track === "conformance",
          );
          before = planned.id;
          lastOf.set(tip.moduleName, planned.id);
          return planned;
        });
      });
    },
    firsts() {
      return order.flatMap((key) => {
        const first = firsts.get(key);
        const tip = tipEntry(modules.get(key)!);
        return first === undefined ? [] : [{ module: tip.moduleName, plainFile: tip.plainFile, buildDir: tip.buildDir, ...first }];
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

/** The functional specs a scheduled conformance job waits for: "fs 2 is", "fs 2, fs 3 are". */
function waitsText(frids: string[]): string {
  return `${frids.map((frid) => `fs ${frid}`).join(", ")} ${frids.length === 1 ? "is" : "are"}`;
}

/** What a job does, in a few words: its cases. */
function casesText(cases: JobCases): string {
  const parts = [
    ...(cases.fresh ? ["sets the project up"] : []),
    ...(cases.add.length > 0 ? [`adds ${cases.add.map((spec) => `fs ${spec.frid}`).join(", ")}`] : []),
    ...(cases.patch.length > 0 ? [`changes ${cases.patch.map((spec) => `fs ${spec.frid}`).join(", ")}`] : []),
    ...(cases.again.length > 0 ? [`grows ${cases.again.map((spec) => `fs ${spec.frid}`).join(", ")} again`] : []),
    ...(cases.delete.length > 0 ? [`takes out ${cases.delete.map((spec) => `fs ${spec.frid}`).join(", ")}`] : []),
  ];
  return parts.length > 0 ? parts.join(", ") : "no functional spec - reqs or definitions only";
}

/** The codebases the loop looks after, as the person reads them: what runs, what is planned after it, and why nothing does. */
/**
 * The coding agent's task for a dry run's first job, built as the render builds it - and all it did rolled back. Not for
 * a conformance job: its prompt is built from what the code holds once it is built.
 */
export async function promptOf(first: ReturnType<WorkLoop["firsts"]>[number]): Promise<string | undefined> {
  if (first.planned.track !== "code") return undefined;
  const result = await renderSpecDiff({
    plainFile: first.plainFile,
    diff: first.planned.step.textDiff,
    applied: "already applied",
    spec: first.spec,
    cases: first.planned.cases,
    dryRun: true,
  });
  return result.task;
}

/** The first job a codebase would start, and the prompt its coding agent would get. */
export interface JobPreview {
  module: string;
  title: string;
  track: Track;
  cases: JobCases;
  /** The coding agent's task, whole. Not for a conformance job: it is built from what the code holds once it is built. */
  task?: string;
}

/**
 * What bringing a spec's module up would start, in each codebase, and the prompt of each - planned on a loop of its own
 * that starts nothing. A codebase `busy` says is running a job is left out: a dry run starts from its last commit, and
 * what the next job there is given depends on what the running one lands.
 */
export async function previewJobs(options: {
  plainFile: string;
  cwd: string;
  buildDir?: string;
  model?: string;
  plannerModel?: string;
  steering?: (plainFile: string) => Steering[];
  /** Whether a codebase, by its module, has a job running. */
  busy?: (module: string) => boolean;
}): Promise<{ statuses: ModuleStatus[]; previews: JobPreview[]; busy: string[] }> {
  const loop = createWorkLoop({
    registry: createJobRegistry(),
    cwd: options.cwd,
    dryRun: true,
    ...(options.buildDir !== undefined ? { buildDir: options.buildDir } : {}),
    ...(options.model !== undefined ? { modelFor: () => options.model } : {}),
    ...(options.plannerModel !== undefined ? { plannerModel: options.plannerModel } : {}),
    ...(options.steering !== undefined ? { steering: options.steering } : {}),
  });
  const statuses = await loop.bringUp(options.plainFile, options.model !== undefined ? { model: options.model } : {});
  const previews: JobPreview[] = [];
  const busy: string[] = [];
  for (const first of loop.firsts()) {
    if (options.busy?.(first.module) === true) {
      busy.push(first.module);
      continue;
    }
    const preview: JobPreview = { module: first.module, title: first.planned.title, track: first.planned.track, cases: first.planned.cases };
    const task = await promptOf(first);
    if (task !== undefined) preview.task = task;
    previews.push(preview);
  }
  return { statuses, previews, busy };
}

/** What the conversation is told, after a code job lands, of what it built that no conformance test is for, chosen or scheduled. */
export function chooseNote(plainFile: string, specs: TouchedSpec[], budget?: number): string {
  return [
    "conformance-tests: chosen - the conformance tests are for the functional specs chosen. This pulse built or changed these,",
    "and no conformance test is for them or scheduled:",
    ...specs.map((touched) => `- fs ${touched.frid}: ${touched.text}`),
    `Decide which of them black-box conformance tests are worth it for - what a user or a client of ${basename(plainFile)} relies on,`,
    "not an internal detail its unit tests already cover - and say why. For those, call bind with their",
    "numbers; the rest stay without. A functional spec with acceptance tests always has them.",
    ...(budget !== undefined ? [budgetLine(budget)] : []),
  ].join("\n");
}

/** The module's conformance budget, as the one choosing is told it. */
function budgetLine(budget: number): string {
  return budget === 0
    ? "The module's conformance budget (conformance-budget in the config) is spent: choose none, unless the user asks for them."
    : `Choose at most ${budget} - the module's conformance budget (conformance-budget in the config) - the ones that matter most; more only when the user asks for them.`;
}

/** What the conversation is told, when the work is planned, of what the code jobs add or change that no conformance test is for, chosen or scheduled. */
function chooseNow(plainFile: string, specs: TouchedSpec[], budget?: number): string[] {
  return [
    "  conformance-tests: chosen - the code pulses above add or change these, and no conformance test is for them or scheduled:",
    ...specs.map((touched) => `  - fs ${touched.frid}: ${touched.text}`),
    `  Decide now which are worth black-box tests - what a user or a client of ${basename(plainFile)} relies on, not an internal`,
    "  detail its unit tests cover - say why, and call bind with their numbers: one call a conformance pulse,",
    "  scheduled now and started once the module's code is built, before anything is built on it. The rest stay without.",
    ...(budget !== undefined ? [`  ${budgetLine(budget)}`] : []),
  ];
}

export function describeModules(statuses: ModuleStatus[], options: { for?: "chat" | "command line" } = {}): string {
  if (statuses.length === 0) return "Nothing is being built.";
  const startOver = (status: ModuleStatus): string[] => {
    if (status.startOver === undefined) return [];
    const { requires, codebases } = status.startOver;
    return options.for === "command line"
      ? [`  turri regrow ${basename(status.plainFile)} --rejuvenate starts ${codebases.join(", ")} over`]
      : [
          `  Ask the user whether to start ${codebases.join(", ")} over, and say why: ${codebases.join(", ")} was built without ` +
            `${requires.join(", ")}, so no change to its code can bring ${requires.join(", ")} in - its code and conformance ` +
            "tests are taken out, kept in its history, and built again from the bottom of the chain. Only if they agree, " +
            `call rejuvenate with ${basename(status.plainFile)}.`,
        ];
  };
  return statuses
    .map((status) => {
      const lines = [`${status.module} (${basename(status.plainFile)}):`];
      if (status.running !== undefined) {
        lines.push(`  running: pulse ${status.running.jobId} - ${status.running.title}`);
        // Steered, not stopped or planned again: what changed went to its agent.
        for (const why of status.running.steered ?? []) lines.push(`    ⇢ steered: ${why} - its agent was told, and it lands the spec as it is now there`);
      }
      status.planned.forEach((job, index) =>
        lines.push(
          job.waitsFor !== undefined
            ? `  ${index + 1}. conformance tests: ${job.title} - scheduled, starts once ${waitsText(job.waitsFor)} built`
            : job.planning === true
              ? `  ${index + 1}. ${job.track === "conformance" ? "conformance tests: " : ""}${job.title} - being planned into pulses`
            : `  ${index + 1}. ${job.track === "conformance" ? "conformance tests: " : ""}${job.title} - ${casesText(job.cases)}`,
        ),
      );
      if (status.why !== undefined) lines.push(`  ${status.why}`);
      if (status.toChoose !== undefined && options.for !== "command line") lines.push(...chooseNow(status.plainFile, status.toChoose, status.chooseBudget));
      lines.push(...startOver(status));
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
    change: describeSpecChange(job.planned.step.changes, job.moduleName),
    cwd: job.cwd,
    applied: "already applied",
    spec: job.spec,
    cases: job.planned.cases,
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
    cases: job.planned.cases,
    ...(job.model !== undefined ? { model: job.model } : {}),
    ...(job.steering !== undefined ? { steering: job.steering } : {}),
    onDelta,
  });
  // Landed code can be tried.
  return { landed: result.passed, report: withTryItLine(describeSpecDiff(result), result.passed && result.restructured !== true) };
};
