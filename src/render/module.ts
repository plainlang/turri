import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { ask, createExecutor } from "../pi.ts";
import { plainFileParser } from "../plain/parser.ts";
import { getFrids,
  getSpecificationItems,
  getSpecificationsForFrid,
  TEST_REQUIREMENTS,
  type MarshalledPlainSource, getInheritedFunctionalSpecs } from "../plain/spec.ts";
import {
  conformanceDirFor,
  renderConformanceTests,
  runInSandbox,
  type RenderConformanceTestsResult,
} from "./conformance.ts";
import { reportActivity, reportStage } from "./activity.ts";
import { confinedTools } from "./confine.ts";
import { defaultBuildDir, modulesRoot } from "./paths.ts";
import { buildRegressionFixPrompt } from "./prompt.ts";
import { recordHistory } from "./history.ts";
import {
  copyRequiredCode,
  findCodebaseTip,
  requiredFunctionalSpecs,
  resolveRequiresChain,
  type ChainEntry,
} from "./requires.ts";
import type { RequiredSpec } from "./state.ts";
import {
  describePending,
  isModuleUpToDate,
  pendingFrids,
  readState,
  recordConformanceCommand,
  recordFunctionality,
  recordRegeneration,
  specStateFor,
  type Pending,
} from "./state.ts";
import { renderFunctionality, resolveTemplateDirs, type RenderFunctionalityResult } from "./render.ts";
import {
  chooseRegressionCommand,
  createRunTestsTool,
  listFiles,
  runCommand,
  type TestRun,
} from "./testing.ts";

/** On top of the file tools, which are fenced to the build directory by `confine.ts`. */
const FIX_TOOLS = ["run_unit_tests"];
const DEFAULT_MAX_REGRESSION_ROUNDS = 3;

export interface RegressionRun extends TestRun {
  /** Functionalities whose tests took part in this run. */
  frids: string[];
}

export interface RegressionResult {
  passed: boolean;
  runs: RegressionRun[];
  /** Each time the implementation was changed to repair a regression. */
  repairs: string[];
  /** Empty when no functionality has produced a runnable command yet. */
  command: string | null;
  /** True when no whole-suite command was found, so this run covered only part of it. */
  narrow: boolean;
  /** Tests were there, but no command to run them was known: they were not run. */
  unrun?: boolean;
}

export interface FunctionalityOutcome {
  frid: string;
  render: RenderFunctionalityResult;
  conformance?: RenderConformanceTestsResult;
  regression?: RegressionResult;
  /** Where this functionality stopped, or null when it completed. */
  stoppedAt: "unit tests" | "conformance" | "regression" | null;
  /** True when conformance was off for this run. */
  conformanceSkipped?: boolean;
}

export interface RenderModuleResult {
  moduleName: string;
  buildDir: string;
  conformanceRoot: string;
  /** Every functionality in the module, in order. */
  frids: string[];
  /** Functionalities attempted, in order. */
  outcomes: FunctionalityOutcome[];
  /** Functionalities that completed with a green regression suite. */
  completed: string[];
  /** Whether conformance tests were written, and if not, why not. */
  conformance: "on" | "off: no test reqs" | "off: asked";
  passed: boolean;
}

export interface RenderModuleOptions {
  plainFile: string;
  templateDirs?: string[];
  buildDir?: string;
  /** Root the module directories hang off. Defaults to `<cwd>/plain_modules`. */
  conformanceRoot?: string;
  model?: string;
  /** Start from this functionality, treating earlier ones as already built. */
  from?: string;
  /** Stop after this functionality. Everything before it is built first. */
  to?: string;
  /** Rebuild functionalities that are already built from the current specification. */
  force?: boolean;
  /**
   * Write conformance tests. Defaults to whether the module has test reqs, which are what
   * conformance tests are written from. Setting it true without them is an error.
   */
  conformance?: boolean;
  maxRegressionRounds?: number;
  /**
   * Say how to try the last functionality this run builds. Only the last: the ones before
   * it are steps on the way, and a long run is usually one nobody is watching.
   */
  tryIt?: boolean;
  onDelta?: (delta: string) => void;
  onEvent?: (event: ModuleEvent) => void;
}

export type ModuleEvent =
  | { type: "functionality_start"; frid: string; index: number; total: number }
  | { type: "functionality_skipped"; frid: string }
  | { type: "phase"; frid: string; phase: "render" | "conformance" | "regression" }
  | { type: "run"; command: string; exitCode: number; frids?: string[] }
  | { type: "narrow_command"; command: string }
  | { type: "repair"; frids: string[] }
  | { type: "functionality_done"; frid: string }
  | { type: "stopped"; frid: string; at: string };

/** The module's conformance tests, when there are any: the chain's, copied up, and its own. */
function conformanceDirs(conformanceRoot: string, moduleName: string): string[] {
  const dir = conformanceDirFor(moduleName, conformanceRoot);
  return existsSync(dir) && listFiles(dir).length > 0 ? [dir] : [];
}

/** Repair the implementation after the merged suite went red. */
async function repairRegression(input: {
  buildDir: string;
  moduleName: string;
  frids: string[];
  tree: MarshalledPlainSource;
  required: RequiredSpec[];
  failure: string;
  model?: string;
  onDelta?: (delta: string) => void;
}): Promise<string> {
  const [specifications] = getSpecificationsForFrid(input.tree, input.frids[input.frids.length - 1]!);
  const runs: TestRun[] = [];

  const fence = confinedTools({ workdir: input.buildDir });
  const session = await createExecutor({
    cwd: input.buildDir,
    customTools: [
      ...fence.tools,
      createRunTestsTool({
        name: "run_unit_tests",
        label: "Run unit tests",
        description: "Run the unit test suite in the working directory and return its exit code and output.",
        run: (command) => runCommand(input.buildDir, command),
        runs,
      }),
    ],
    tools: [...fence.names, ...FIX_TOOLS],
    model: input.model,
  });

  try {
    return await ask(
      session,
      buildRegressionFixPrompt({
        moduleName: input.moduleName,
        frids: input.frids,
        specifications,
        required: input.required,
        failure: input.failure,
      }),
      input.onDelta,
    );
  } finally {
    session.dispose();
  }
}

/**
 * Run every conformance test built so far, and repair the code until they all pass.
 *
 * This is the gate between one functionality and the next. A functionality that passed on
 * its own is not finished until the ones before it still pass alongside it, and each
 * repair changes the code - so the suite is run again after every one.
 */
export async function ensureRegressionPasses(input: {
  buildDir: string;
  conformanceRoot: string;
  moduleName: string;
  frids: string[];
  tree: MarshalledPlainSource;
  /** The required modules' functional specs, for the repair agent. */
  required: RequiredSpec[];
  /** The suite command. Null: the one this codebase last ran its whole suite with, if any. */
  command: string | null;
  /** True when `command` is not known to run the whole suite. */
  narrow?: boolean;
  model?: string;
  maxRounds?: number;
  onDelta?: (delta: string) => void;
  onEvent?: (event: ModuleEvent) => void;
}): Promise<RegressionResult> {
  const dirs = conformanceDirs(input.conformanceRoot, input.moduleName);
  const runs: RegressionRun[] = [];
  const repairs: string[] = [];

  const narrow = input.command !== null && (input.narrow ?? false);
  // Tests carried up from the modules below come with the command that ran them.
  const command = input.command ?? readState(input.buildDir)?.conformanceCommand ?? null;

  if (dirs.length === 0) return { passed: true, runs, repairs, command, narrow };
  if (command === null) {
    // There are tests, but nothing has ever run them here and no command came with them.
    return { passed: true, runs, repairs, command, narrow, unrun: true };
  }

  if (narrow) input.onEvent?.({ type: "narrow_command", command });

  const maxRounds = input.maxRounds ?? DEFAULT_MAX_REGRESSION_ROUNDS;
  for (let round = 0; round <= maxRounds; round += 1) {
    reportStage(
      `${input.moduleName}: running every functionality's conformance tests together (${input.frids.join(", ")})`,
    );
    const result = await runInSandbox(input.buildDir, dirs, command);
    runs.push({ command, exitCode: result.exitCode, frids: input.frids });
    reportActivity(result.exitCode === 0 ? "  ✓ whole suite passing" : `  ✗ whole suite failing (exit ${result.exitCode})`);
    input.onEvent?.({ type: "run", command, exitCode: result.exitCode, frids: input.frids });

    if (result.exitCode === 0) {
      // Whatever builds on this codebase later can run the same suite with it.
      if (!narrow) recordConformanceCommand(input.buildDir, command);
      if (repairs.length > 0) {
        recordHistory(input.buildDir, `regression ${input.moduleName} (pass after ${repairs.length} repair(s))`);
      }
      return { passed: true, runs, repairs, command, narrow };
    }
    if (round === maxRounds) break;

    input.onEvent?.({ type: "repair", frids: input.frids });
    reportStage(`${input.moduleName}: an earlier functionality broke - repairing (round ${round + 1} of ${maxRounds})`);
    repairs.push(
      await repairRegression({
        buildDir: input.buildDir,
        moduleName: input.moduleName,
        frids: input.frids,
        tree: input.tree,
        required: input.required,
        failure: result.output,
        model: input.model,
        onDelta: input.onDelta,
      }),
    );
  }

  recordHistory(input.buildDir, `regression ${input.moduleName} (NOT passing after ${repairs.length} repair(s))`);
  return { passed: false, runs, repairs, command, narrow };
}

function suiteCommand(conformance: RenderConformanceTestsResult | undefined): {
  command: string | null;
  narrow: boolean;
} {
  return conformance === undefined
    ? { command: null, narrow: false }
    : chooseRegressionCommand(conformance.runs);
}

/**
 * Build a whole module, one functionality at a time.
 *
 * A functionality advances only when its unit tests pass, its own conformance tests pass,
 * and the conformance tests of every functionality before it still pass alongside it.
 */
export async function renderModule(options: RenderModuleOptions): Promise<RenderModuleResult> {
  const templateDirs = resolveTemplateDirs(options.plainFile, options.templateDirs);
  const [moduleName, tree] = plainFileParser(basename(options.plainFile), templateDirs);

  const allFrids = [...getFrids(tree)];
  const buildDir = resolve(options.buildDir ?? defaultBuildDir(moduleName));
  const conformanceRoot = resolve(options.conformanceRoot ?? modulesRoot());

  const fromIndex = options.from ? allFrids.indexOf(options.from) : 0;
  if (fromIndex === -1) throw new Error(`Functionality ${options.from} does not exist.`);
  const toIndex = options.to ? allFrids.indexOf(options.to) : allFrids.length - 1;
  if (toIndex === -1) throw new Error(`Functionality ${options.to} does not exist.`);

  // Anything already built from the current specification is left alone. A functionality
  // whose spec has since changed counts as not built, which is what makes "render
  // functionality 4" also repair 1 to 3 when their specs moved.
  const pending: Pending[] = options.force
    ? allFrids.slice(fromIndex, toIndex + 1).map((frid) => ({ frid, reason: "never built" as const }))
    : pendingFrids(tree, buildDir, allFrids[toIndex]).filter(
        (entry) => allFrids.indexOf(entry.frid) >= fromIndex,
      );
  const toBuild = new Set(pending.map((entry) => entry.frid));
  const lastToBuild = pending.at(-1)?.frid;
  // Read once for the module: the required modules do not change while this one builds.
  const required = getInheritedFunctionalSpecs(tree);

  const outcomes: FunctionalityOutcome[] = [];
  const completed = allFrids.slice(0, fromIndex);
  let command: string | null = null;
  let narrow = false;

  // Conformance is optional, and it is written from the test reqs. With none, there is
  // nothing to write tests against, so it is off unless explicitly asked for.
  const hasTestReqs = (getSpecificationItems(tree, TEST_REQUIREMENTS) ?? []).length > 0;
  const conformanceEnabled = options.conformance ?? hasTestReqs;
  if (conformanceEnabled && !hasTestReqs) {
    throw new Error(
      `Module '${moduleName}' has no ${TEST_REQUIREMENTS}, so conformance tests cannot be written. ` +
        `Add a ${TEST_REQUIREMENTS} section, or leave conformance off.`,
    );
  }

  /** Write what this functionality was built from, as soon as it is known. */
  const record = (
    frid: string,
    status: { unitTests: "passed" | "failed"; conformance?: "passed" | "failed" | "skipped" },
  ) =>
    recordFunctionality(buildDir, moduleName, { frid, ...specStateFor(tree, frid), ...status });

  for (let index = fromIndex; index <= toIndex; index += 1) {
    const frid = allFrids[index]!;

    if (!toBuild.has(frid)) {
      options.onEvent?.({ type: "functionality_skipped", frid });
      completed.push(frid);
      continue;
    }

    options.onEvent?.({ type: "functionality_start", frid, index: index + 1, total: allFrids.length });

    options.onEvent?.({ type: "phase", frid, phase: "render" });
    const render = await renderFunctionality({
      plainFile: options.plainFile,
      frid,
      templateDirs: options.templateDirs,
      buildDir,
      model: options.model,
      tryIt: options.tryIt === true && frid === lastToBuild,
      onDelta: options.onDelta,
      onRun: (cmd, exitCode) => options.onEvent?.({ type: "run", command: cmd, exitCode }),
    });

    // State is written as each stage finishes, not at the end. A module is routinely
    // left part-built - conformance fails on functionality 3, the run stops - and the
    // work already done on that functionality must survive it.
    record(frid, { unitTests: render.passed ? "passed" : "failed" });

    if (!render.passed) {
      outcomes.push({ frid, render, stoppedAt: "unit tests" });
      options.onEvent?.({ type: "stopped", frid, at: "unit tests" });
      break;
    }

    if (!conformanceEnabled) {
      // No new conformance tests for this functionality - but the ones already here, this
      // module's and those carried up from below, are kept passing whatever is built.
      record(frid, { unitTests: "passed", conformance: "skipped" });
      options.onEvent?.({ type: "phase", frid, phase: "regression" });
      const regression = await ensureRegressionPasses({
        buildDir,
        conformanceRoot,
        moduleName,
        frids: [...completed, frid],
        tree,
        required,
        command,
        narrow,
        model: options.model,
        maxRounds: options.maxRegressionRounds,
        onDelta: options.onDelta,
        onEvent: options.onEvent,
      });
      if (!regression.passed) {
        outcomes.push({ frid, render, regression, stoppedAt: "regression", conformanceSkipped: true });
        options.onEvent?.({ type: "stopped", frid, at: "regression" });
        break;
      }
      outcomes.push({ frid, render, regression, stoppedAt: null, conformanceSkipped: true });
      completed.push(frid);
      options.onEvent?.({ type: "functionality_done", frid });
      continue;
    }

    options.onEvent?.({ type: "phase", frid, phase: "conformance" });
    const conformance = await renderConformanceTests({
      plainFile: options.plainFile,
      frid,
      templateDirs: options.templateDirs,
      buildDir,
      conformanceDir: conformanceDirFor(moduleName, conformanceRoot),
      model: options.model,
      onDelta: options.onDelta,
      onRun: (cmd, exitCode) => options.onEvent?.({ type: "run", command: cmd, exitCode }),
    });

    const chosen = suiteCommand(conformance);
    if (chosen.command !== null) {
      command = chosen.command;
      narrow = chosen.narrow;
    }

    record(frid, { unitTests: "passed", conformance: conformance.passed ? "passed" : "failed" });

    if (!conformance.passed) {
      outcomes.push({ frid, render, conformance, stoppedAt: "conformance" });
      options.onEvent?.({ type: "stopped", frid, at: "conformance" });
      break;
    }

    options.onEvent?.({ type: "phase", frid, phase: "regression" });
    const regression = await ensureRegressionPasses({
      buildDir,
      conformanceRoot,
      moduleName,
      frids: [...completed, frid],
      tree,
      required,
      command,
      narrow,
      model: options.model,
      maxRounds: options.maxRegressionRounds,
      onDelta: options.onDelta,
      onEvent: options.onEvent,
    });

    if (!regression.passed) {
      outcomes.push({ frid, render, conformance, regression, stoppedAt: "regression" });
      options.onEvent?.({ type: "stopped", frid, at: "regression" });
      break;
    }

    outcomes.push({ frid, render, conformance, regression, stoppedAt: null });
    completed.push(frid);
    options.onEvent?.({ type: "functionality_done", frid });
  }

  // The record's last word on each functionality lands after its step's own commit.
  recordHistory(buildDir, `${moduleName}: build record`);

  return {
    moduleName,
    buildDir,
    conformanceRoot,
    frids: allFrids,
    outcomes,
    completed,
    conformance: conformanceEnabled ? "on" : options.conformance === false ? "off: asked" : "off: no test reqs",
    passed: outcomes.length > 0 && outcomes.every((outcome) => outcome.stoppedAt === null),
  };
}

export interface RegenerateFunctionalityOptions extends RenderModuleOptions {
  frid: string;
  /**
   * The module whose codebase to regenerate in. Default: the furthest-built module whose
   * requires chain includes this one - required only when those sit on different branches.
   */
  inModule?: string;
  /** Why it is being regenerated, when its spec has not changed: what should come out better. */
  reason?: string;
}

export interface RegenerateFunctionalityResult {
  moduleName: string;
  frid: string;
  /** The codebase it was regenerated in, when that is a later module's rather than its own. */
  codebaseOf?: string;
  buildDir: string;
  conformanceRoot: string;
  render: RenderFunctionalityResult;
  conformance?: RenderConformanceTestsResult;
  regression?: RegressionResult;
  passed: boolean;
  stoppedAt: "unit tests" | "conformance" | "regression" | null;
}

/**
 * Update one functionality whose specification changed, in the codebase that is current.
 *
 * Code accumulates up a requires chain, so once modules are built on top of this one, the
 * code worth changing is at the tip, not in this module's own build - that is an older
 * snapshot, and regenerating there would mean copying it back up over everything built
 * since. So the change is made in the tip's codebase: the functionality is updated there,
 * its conformance tests are rewritten and run against that code, and then the conformance
 * suite of every module in the chain up to the tip runs, because a changed specification
 * can move behaviour that anything built later was relying on.
 *
 * The tip's build record is updated at the end either way, pass or fail: the code changed,
 * and the record has to say what it now holds. This module's own build is left alone.
 */
export async function regenerateFunctionality(
  options: RegenerateFunctionalityOptions,
): Promise<RegenerateFunctionalityResult> {
  const templateDirs = resolveTemplateDirs(options.plainFile, options.templateDirs);
  const [moduleName, tree] = plainFileParser(basename(options.plainFile), templateDirs);

  const allFrids = [...getFrids(tree)];
  if (!allFrids.includes(options.frid)) {
    throw new Error(`Functionality ${options.frid} does not exist. Available: ${allFrids.join(", ")}.`);
  }

  // An explicit build directory is taken at its word; otherwise the change goes to the tip.
  const located =
    options.buildDir === undefined
      ? findCodebaseTip(options.plainFile, { templateDirs: options.templateDirs, inModule: options.inModule })
      : undefined;
  const tip = located?.tip;
  const host =
    tip !== undefined && tip.moduleName !== moduleName
      ? { moduleName: tip.moduleName, plainFile: tip.plainFile, buildDir: tip.buildDir }
      : undefined;

  const buildDir = resolve(host?.buildDir ?? options.buildDir ?? defaultBuildDir(moduleName));
  const conformanceRoot = resolve(options.conformanceRoot ?? modulesRoot());

  if (listFiles(buildDir).length === 0) {
    throw new Error(
      `Nothing to regenerate: ${buildDir} is empty or missing. ` +
        "regenerateFunctionality updates code that already exists - render the module first.",
    );
  }

  const base = { moduleName, frid: options.frid, codebaseOf: host?.moduleName, buildDir, conformanceRoot };

  options.onEvent?.({ type: "phase", frid: options.frid, phase: "render" });
  const render = await renderFunctionality({
    plainFile: options.plainFile,
    frid: options.frid,
    templateDirs: options.templateDirs,
    buildDir,
    model: options.model,
    regenerate: { in: host, reason: options.reason },
    onDelta: options.onDelta,
    onRun: (cmd, exitCode) => options.onEvent?.({ type: "run", command: cmd, exitCode }),
  });

  /** The record at the end, whatever happened: what the code holds now. */
  const record = (conformance: "passed" | "failed" | "skipped") => {
    const built = {
      specHash: specStateFor(tree, options.frid).specHash,
      unitTests: render.passed ? ("passed" as const) : ("failed" as const),
      conformance,
    };
    if (host !== undefined) {
      recordRegeneration(buildDir, host.moduleName, {
        module: moduleName,
        frid: options.frid,
        required: requiredFunctionalSpecs(host.plainFile, options.templateDirs),
        build: built,
      });
    } else {
      recordFunctionality(buildDir, moduleName, { frid: options.frid, ...specStateFor(tree, options.frid), ...built });
    }
    recordHistory(buildDir, `regenerate ${moduleName} fs ${options.frid}${host ? ` in ${host.moduleName}` : ""}: conformance ${conformance}`);
  };

  if (!render.passed) {
    record("skipped");
    return { ...base, render, passed: false, stoppedAt: "unit tests" };
  }

  options.onEvent?.({ type: "phase", frid: options.frid, phase: "conformance" });
  const conformance = await renderConformanceTests({
    plainFile: options.plainFile,
    frid: options.frid,
    templateDirs: options.templateDirs,
    buildDir,
    // In the codebase it is regenerated in: its tests are that codebase's tests.
    conformanceDir: conformanceDirFor(host?.moduleName ?? moduleName, conformanceRoot),
    model: options.model,
    onDelta: options.onDelta,
    onRun: (cmd, exitCode) => options.onEvent?.({ type: "run", command: cmd, exitCode }),
  });

  if (!conformance.passed) {
    record("failed");
    return { ...base, render, conformance, passed: false, stoppedAt: "conformance" };
  }

  // Every functionality that has tests on disk, not just the ones up to this one: a
  // specification change can break something built later just as easily as earlier. The
  // codebase's tests directory holds the whole chain's, copied up with the code.
  options.onEvent?.({ type: "phase", frid: options.frid, phase: "regression" });
  const regression = await ensureRegressionPasses({
    buildDir,
    conformanceRoot,
    moduleName: host?.moduleName ?? moduleName,
    frids: allFrids,
    tree,
    required: requiredFunctionalSpecs(host?.plainFile ?? options.plainFile, options.templateDirs),
    ...suiteCommand(conformance),
    model: options.model,
    maxRounds: options.maxRegressionRounds,
    onDelta: options.onDelta,
    onEvent: options.onEvent,
  });

  record(regression.passed ? "passed" : "failed");
  return {
    ...base,
    render,
    conformance,
    regression,
    passed: regression.passed,
    stoppedAt: regression.passed ? null : "regression",
  };
}


export interface ChainOutcome {
  module: string;
  /** Already built, and not forced. */
  skipped: boolean;
  /** Files copied in from the module this one requires. */
  copied: number;
  result?: RenderModuleResult;
  /** Required modules' functionalities regenerated in this module's codebase first. */
  regenerated?: RegenerateFunctionalityResult[];
}

export interface RenderChainResult {
  chain: ChainEntry[];
  outcomes: ChainOutcome[];
  passed: boolean;
}

export interface RenderChainOptions extends RenderModuleOptions {
  /** Rebuild modules that are already complete. */
  force?: boolean;
  /** Build only the named module, ignoring what it requires. */
  skipRequires?: boolean;
  onChainEvent?: (event: ChainEvent) => void;
}

export type ChainEvent =
  | { type: "chain"; chain: ChainEntry[] }
  | { type: "module_start"; module: string; index: number; total: number }
  | { type: "module_skipped"; module: string }
  | { type: "copied"; from: string; to: string; files: number }
  | { type: "module_done"; module: string; passed: boolean };

/**
 * The furthest-built module in the chain that records what it was built on, and which of
 * its required modules' functionalities have changed since.
 *
 * A module's record lists every functional spec of the modules below it, as its codebase
 * holds them. Where that record exists, the modules below are done - their code is in
 * this codebase - and a spec of theirs that has moved since is regenerated here. A build
 * recorded before that list was kept has nothing to compare against, and is not used.
 */
function coveringCodebase(
  chain: ChainEntry[],
  templateDirs: string[] | undefined,
): { index: number; stale: RequiredSpec[] } | undefined {
  const sameSpec = (a: RequiredSpec, b: RequiredSpec) =>
    a.spec === b.spec && JSON.stringify(a.acceptanceTests ?? []) === JSON.stringify(b.acceptanceTests ?? []);

  for (let index = chain.length - 1; index >= 1; index -= 1) {
    const entry = chain[index]!;
    if (listFiles(entry.buildDir).length === 0) continue;
    const state = readState(entry.buildDir);
    if (state === null || state.required.length === 0) continue;

    const recorded = new Map(state.required.map((spec) => [`${spec.module}/${spec.frid}`, spec]));
    const stale = requiredFunctionalSpecs(entry.plainFile, templateDirs).filter((current) => {
      const built = recorded.get(`${current.module}/${current.frid}`);
      return built === undefined || !sameSpec(built, current);
    });
    return { index, stale };
  }
  return undefined;
}

/**
 * Build a module and everything it requires, bottom first.
 *
 * A required module is not a dependency to link against - its code is copied into the
 * build before this module starts, so it has to be finished first. Each module keeps its
 * own build directory, and records which functionalities it holds, so a chain interrupted
 * half way can be resumed without rebuilding what is already done.
 */
export async function renderChain(options: RenderChainOptions): Promise<RenderChainResult> {
  const chain = options.skipRequires
    ? resolveRequiresChain(options.plainFile, options.templateDirs, options.buildDir).slice(-1)
    : resolveRequiresChain(options.plainFile, options.templateDirs, options.buildDir);

  options.onChainEvent?.({ type: "chain", chain });

  const byModule = new Map(chain.map((entry) => [entry.moduleName, entry]));
  const outcomes: ChainOutcome[] = [];

  // Where the chain's code already lives. Everything below it is in its codebase, so it is
  // not rebuilt in its own - an ancestor whose spec changed is regenerated up here instead.
  const covering = options.force || options.skipRequires ? undefined : coveringCodebase(chain, options.templateDirs);

  for (const [index, entry] of chain.entries()) {
    if (covering !== undefined && index < covering.index) {
      options.onChainEvent?.({ type: "module_skipped", module: entry.moduleName });
      outcomes.push({ module: entry.moduleName, skipped: true, copied: 0 });
      continue;
    }

    let regenerated: RegenerateFunctionalityResult[] | undefined;
    if (covering !== undefined && index === covering.index && covering.stale.length > 0) {
      regenerated = [];
      for (const stale of covering.stale) {
        const result = await regenerateFunctionality({
          ...options,
          plainFile: byModule.get(stale.module)!.plainFile,
          frid: stale.frid,
          inModule: entry.moduleName,
          buildDir: undefined,
          from: undefined,
          to: undefined,
        });
        regenerated.push(result);
        if (!result.passed) {
          outcomes.push({ module: entry.moduleName, skipped: false, copied: 0, regenerated });
          options.onChainEvent?.({ type: "module_done", module: entry.moduleName, passed: false });
          return { chain, outcomes, passed: false };
        }
      }
    }

    const [, entryTree] = plainFileParser(basename(entry.plainFile), resolveTemplateDirs(entry.plainFile, options.templateDirs));
    if (!options.force && isModuleUpToDate(entryTree, entry.buildDir)) {
      options.onChainEvent?.({ type: "module_skipped", module: entry.moduleName });
      outcomes.push({ module: entry.moduleName, skipped: true, copied: 0 });
      continue;
    }

    options.onChainEvent?.({
      type: "module_start",
      module: entry.moduleName,
      index: index + 1,
      total: chain.length,
    });

    let copied = 0;
    if (entry.requires !== null) {
      const source = byModule.get(entry.requires);
      if (source !== undefined) {
        const firstFrid = entry.frids[0];
        copied = copyRequiredCode(
          source.buildDir,
          entry.buildDir,
          entry.moduleName,
          firstFrid !== undefined ? specStateFor(entryTree, firstFrid).sections : undefined,
        ).length;
        options.onChainEvent?.({
          type: "copied",
          from: entry.requires,
          to: entry.moduleName,
          files: copied,
        });
      }
    }

    const result = await renderModule({
      ...options,
      plainFile: entry.plainFile,
      buildDir: entry.buildDir,
      // Required modules are built on the way to the one asked for; only that one is tried.
      tryIt: options.tryIt === true && index === chain.length - 1,
    });

    outcomes.push({ module: entry.moduleName, skipped: false, copied, result, regenerated });
    options.onChainEvent?.({ type: "module_done", module: entry.moduleName, passed: result.passed });

    if (!result.passed) return { chain, outcomes, passed: false };
  }

  return { chain, outcomes, passed: true };
}
