import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { ask, BEGIN, createExecutor } from "../pi.ts";
import { plainFileParser } from "../plain/parser.ts";
import { getFrids,
  getSpecificationItems,
  getSpecificationsForFrid,
  TEST_REQUIREMENTS,
  type MarshalledPlainSource, getInheritedFunctionalSpecs } from "../plain/spec.ts";
import {
  conformanceDirFor,
  renderConformanceTests,
  type RenderConformanceTestsResult,
} from "./conformance.ts";
import { reportActivity, reportSpec, reportStage, reportTranscript, unitOf } from "./activity.ts";
import { confinedTools } from "./confine.ts";
import { defaultBuildDir, modulesRoot, projectRootOf, projectDirOf } from "./paths.ts";
import { buildRegressionFixPrompt } from "./prompt.ts";
import { abandonWork, markWork, recordHistory, startFromLastCommit, startWork, type WorkStart } from "./history.ts";
import { CODER_COMPACTION } from "./compaction.ts";
import { notesForSession, withNotes } from "./notes.ts";
import {
  findTestScripts,
  MissingTestScriptError,
  projectRootFor,
  requireTestScripts,
  runConformanceScript,
  type TestScripts,
  createScriptTool,
  runUnitScript,
  withoutConformance,
  withTestingScripts,
} from "./test-scripts.ts";
import { createWebTools, WEB_TOOLS } from "./web.ts";
import { ATTEMPTS, describeStop, type StopFacts } from "./stop-report.ts";
import {
  copyRequiredCode,
  findCodebaseTip,
  newlyRequired,
  requiredFunctionalSpecs,
  resolveRequiresChain,
  startFromScratch,
  type ChainEntry,
} from "./requires.ts";
import type { RequiredSpec } from "./state.ts";
import { readBuiltTree, writeBuiltTree } from "./state.ts";
import { llmPlanner, planSpecSteps, reachedByRendering, sameSpec, type Planner } from "./spec-steps.ts";
import type { RenderSpecDiffResult, SpecSnapshot } from "./spec-change.ts";
import {
  describePending,
  isModuleUpToDate,
  pendingFrids,
  builtRequiredSpecs,
  type Pending,
} from "./state.ts";
import { renderFunctionality, resolveTemplateDirs, type PinnedSpec, type RenderFunctionalityResult } from "./render.ts";
import {
  listFiles,
  runCommand,
  type TestRun,
  keepingTestsUnchanged,
} from "./testing.ts";

/** On top of the file tools, which are fenced to the build directory by `confine.ts`. */
const FIX_TOOLS = ["run_unit_tests", "run_conformance_tests", "update_notes"];
const DEFAULT_MAX_REGRESSION_ROUNDS = ATTEMPTS.regression;

export interface RegressionRun extends TestRun {
  /** Functionalities whose tests took part in this run. */
  frids: string[];
}

export interface RegressionResult {
  passed: boolean;
  runs: RegressionRun[];
  /** Each time the implementation was changed to repair a regression. */
  repairs: string[];
  /** The conformance testing script that ran the suite; null when there were no tests to run. */
  command: string | null;
  /** Conformance was turned off, so the conformance tests already here were not run. */
  conformanceOff?: boolean;
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
  /**
   * When the spec had moved on from the code in more than new functional specs, the spec diffs it
   * was brought up to date with, in order - rendered up to the first that did not pass - and
   * `outcomes` is empty.
   */
  specSteps?: SpecStepOutcome[];
  /** Those spec diffs, when they were queued as render spec diff jobs rather than rendered here. */
  queuedSpecDiffs?: Array<{ title: string; jobId: string }>;
}

/** A spec diff to queue as a job of its own: the diff, and the spec as it leaves it. */
export interface QueuedSpecStep {
  title: string;
  plainFile: string;
  diff: string;
  spec: SpecSnapshot;
}

export interface SpecStepOutcome {
  title: string;
  reason: string;
  /** The sections it changed. */
  sections: string[];
  result: RenderSpecDiffResult;
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
  onDelta?: (delta: string) => void;
  onEvent?: (event: ModuleEvent) => void;
  /** Orders the changes into spec diffs when it takes them. The planning agent, by default. */
  planner?: Planner;
  /**
   * Given, spec diffs are not rendered here but handed over, in order, to be queued as render spec
   * diff jobs - as forge-plain queues them. Returns each one's job id.
   */
  queueSpecDiffs?: (steps: QueuedSpecStep[]) => string[];
}

export type ModuleEvent =
  | { type: "functionality_start"; frid: string; index: number; total: number; spec?: string }
  | { type: "functionality_skipped"; frid: string }
  | { type: "phase"; frid: string; phase: "render" | "conformance" | "regression" }
  | { type: "run"; command: string; exitCode: number; frids?: string[] }
  | { type: "repair"; frids: string[] }
  | { type: "functionality_done"; frid: string }
  | { type: "stopped"; frid: string; at: string }
  /** A spec diff of the several a spec that moved on is brought in as, starting: its place, its title, the diff. */
  | { type: "spec_diff_start"; index: number; total: number; title: string; diff: string }
  | { type: "spec_diff_done"; index: number; passed: boolean };

/** The module's conformance tests, when there are any: the chain's, copied up, and its own. */
function conformanceDirs(conformanceRoot: string, moduleName: string): string[] {
  const dir = conformanceDirFor(moduleName, conformanceRoot);
  return existsSync(dir) && listFiles(dir).length > 0 ? [dir] : [];
}

/** Repair the implementation after the merged suite went red. */
async function repairRegression(input: {
  /** The conformance tests the repair is not allowed to change. */
  testsDirs: string[];
  buildDir: string;
  moduleName: string;
  frids: string[];
  tree: MarshalledPlainSource;
  required: RequiredSpec[];
  failure: string;
  /** The step the repair is for, as its notes say: `app 3`, `app spec change`. */
  step: string;
  /** The scripts that judge it, for its prompt. */
  scripts: TestScripts;
  model?: string;
  onDelta?: (delta: string) => void;
}): Promise<string> {
  const [specifications] = getSpecificationsForFrid(input.tree, input.frids[input.frids.length - 1]!);
  const runs: TestRun[] = [];

  const fence = confinedTools({ workdir: input.buildDir });
  const notes = notesForSession(input.buildDir, `${input.step} regression repair`);
  reportStage(`${unitOf(input.moduleName)}: starting the repair agent${input.model ? ` (${input.model})` : ""}`);
  const session = await createExecutor({
    cwd: input.buildDir,
    customTools: [
      notes.tool,
      ...createWebTools(),
      ...fence.tools,
      createScriptTool({ kind: "unit", script: input.scripts.unit, run: () => runUnitScript(input.buildDir, input.scripts.unit!), runs }),
      createScriptTool({
        kind: "conformance",
        script: input.scripts.conformance,
        run: () => runConformanceScript(input.buildDir, input.testsDirs, input.scripts),
        runs: [],
      }),
    ],
    tools: [...fence.names, ...FIX_TOOLS, ...WEB_TOOLS],
    model: input.model,
    label: `${input.step} repair agent`,
    system: fence.note,
    task: withNotes(
      withTestingScripts(
        buildRegressionFixPrompt({
          moduleName: input.moduleName,
          frids: input.frids,
          specifications,
          required: input.required,
          failure: input.failure,
        }),
        input.scripts,
        ["conformance", "unit"],
        projectRootOf(input.buildDir),
      ),
      input.buildDir,
    ),
    compaction: { instructions: CODER_COMPACTION },
  });

  try {
    reportStage(`${unitOf(input.moduleName)}: plainwright is repairing the code so every functionality's conformance tests pass together`);
    const { report, restored } = await keepingTestsUnchanged({
      dirs: input.testsDirs,
      label: input.moduleName,
      start: () => ask(session, BEGIN, input.onDelta),
      again: (prompt) => ask(session, prompt, input.onDelta),
    });
    if (restored.length > 0) reportActivity(`  put back ${restored.length} conformance test file(s) the repair agent changed`);
    reportStage(`${unitOf(input.moduleName)}: checking the working notes were left`);
    await notes.ensureWritten((next) => ask(session, next, input.onDelta));
    return restored.length > 0
      ? `${report}\n\n(The harness put back ${restored.length} conformance test file(s) this repair changed.)`
      : report;
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
  /**
   * The unit of work the run belongs to, undone whole when the suite still fails. Without one,
   * only what the repairs did is undone.
   */
  start?: WorkStart;
  /** The step the regression run is for, as a repair's notes say; the last functionality by default. */
  step?: string;
  /** The codebase's testing scripts: its conformance testing script runs the suite. */
  scripts: TestScripts;
  model?: string;
  maxRounds?: number;
  onDelta?: (delta: string) => void;
  onEvent?: (event: ModuleEvent) => void;
}): Promise<RegressionResult> {
  const dirs = conformanceDirs(input.conformanceRoot, input.moduleName);
  const runs: RegressionRun[] = [];
  const repairs: string[] = [];

  let command: string | null = null;

  if (dirs.length === 0) {
    reportActivity(`  ${input.moduleName} has no conformance tests yet - nothing to keep passing`);
    return { passed: true, runs, repairs, command };
  }
  if (input.scripts.conformanceOff === true) {
    reportActivity(`  conformance is off: ${input.moduleName}'s conformance tests were not run`);
    return { passed: true, runs, repairs, command, conformanceOff: true };
  }
  // There are tests: the project's conformance testing script runs them, or nothing does.
  if (input.scripts.conformance === undefined) throw new MissingTestScriptError(input.moduleName, "conformance");

  const start = input.start ?? markWork([input.buildDir, ...dirs]);
  const maxRounds = input.maxRounds ?? DEFAULT_MAX_REGRESSION_ROUNDS;
  for (let round = 0; round <= maxRounds; round += 1) {
    reportStage(
      round === 0
        ? `${unitOf(input.moduleName)}: running the codebase's whole conformance suite - every functionality's tests together (${input.frids.join(", ")})`
        : `${unitOf(input.moduleName)}: repair ${round} done - running the whole conformance suite again`,
    );
    const result = await runConformanceScript(input.buildDir, dirs, input.scripts);
    command = result.command;
    runs.push({ command, exitCode: result.exitCode, frids: input.frids });
    reportActivity(result.exitCode === 0 ? "  ✓ whole suite passing" : `  ✗ whole suite failing (exit ${result.exitCode})`);
    input.onEvent?.({ type: "run", command, exitCode: result.exitCode, frids: input.frids });

    // The whole suite passing is half of it: the unit tests have to pass with it.
    let failure = result.output;
    let passing = result.exitCode === 0;
    if (passing && input.scripts.unit !== undefined) {
      reportStage(`${unitOf(input.moduleName)}: the whole conformance suite passes - running the unit testing script too`);
      const unit = await runUnitScript(input.buildDir, input.scripts.unit);
      runs.push({ command: unit.command, exitCode: unit.exitCode, frids: input.frids });
      input.onEvent?.({ type: "run", command: unit.command, exitCode: unit.exitCode, frids: input.frids });
      if (unit.exitCode !== 0) {
        reportActivity(`  ✗ unit tests failing (exit ${unit.exitCode}) with the conformance suite passing`);
        passing = false;
        failure = `The conformance suite passes, but the code's unit tests do not - and both have to.\n\n${unit.output}`;
      }
    }

    if (passing) {
      reportStage(`${unitOf(input.moduleName)}: the whole conformance suite passes, and the unit tests with it${repairs.length > 0 ? ` after ${repairs.length} repair${repairs.length === 1 ? "" : "s"}` : ""}`);
      if (repairs.length > 0) {
        recordHistory(input.buildDir, `regression ${input.moduleName} (pass after ${repairs.length} repair(s))`);
      }
      return { passed: true, runs, repairs, command };
    }
    if (round === maxRounds) break;

    input.onEvent?.({ type: "repair", frids: input.frids });
    reportStage(`${unitOf(input.moduleName)}: an earlier functionality broke - repairing (round ${round + 1} of ${maxRounds})`);
    repairs.push(
      await repairRegression({
        testsDirs: dirs,
        buildDir: input.buildDir,
        moduleName: input.moduleName,
        frids: input.frids,
        tree: input.tree,
        required: input.required,
        failure,
        step: input.step ?? `${input.moduleName} ${input.frids.at(-1)}`,
        scripts: input.scripts,
        model: input.model,
        onDelta: input.onDelta,
      }),
    );
  }

  reportStage(`${unitOf(input.moduleName)}: the whole conformance suite still fails after ${repairs.length} repair${repairs.length === 1 ? "" : "s"} - stopping`);
  abandonWork(start, input.moduleName, `the whole conformance suite still fails after ${repairs.length} repair(s)`);
  return { passed: false, runs, repairs, command };
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
  const buildDir = resolve(options.buildDir ?? defaultBuildDir(moduleName, projectDirOf(options.plainFile)));
  const conformanceRoot = resolve(options.conformanceRoot ?? modulesRoot(projectDirOf(options.plainFile)));
  // A module build starts from the last known good state of its codebase.
  startFromLastCommit(buildDir, moduleName);

  // The spec may have moved on from the code in more than new functional specs - one changed in
  // place, a req added, a definition changed. Rendering the new ones would miss that, so the
  // change is brought in as spec diffs instead. Asked for a range, or to rebuild, it is built
  // functionality by functionality as asked.
  if (options.from === undefined && options.to === undefined && !options.force) {
    const built = readBuiltTree(buildDir);
    // Only laid out differently - definitions moved to a common module, specs moved between this
    // module and one it requires: the code already is what the spec says. Recorded, not rendered.
    if (built !== null && !reachedByRendering(built, tree) && sameSpec(built, tree)) {
      reportStage(`${unitOf(moduleName)}: the specs were only restructured - nothing to render; recording the spec as it is now laid out`);
      writeBuiltTree(buildDir, tree);
      recordHistory(buildDir, "spec restructured: nothing to render");
    } else if (built !== null && !reachedByRendering(built, tree)) {
      const brought = await renderAsSpecDiffs(options, { moduleName, tree, built, buildDir });
      if (brought !== undefined && "queued" in brought) {
        return {
          moduleName,
          buildDir,
          conformanceRoot,
          frids: allFrids,
          outcomes: [],
          completed: [],
          conformance: options.conformance === false ? "off: asked" : "on",
          passed: true,
          specSteps: [],
          queuedSpecDiffs: brought.queued,
        };
      }
      const specSteps = brought;
      if (specSteps !== undefined) {
        const conformanceRoot = resolve(options.conformanceRoot ?? modulesRoot(projectDirOf(options.plainFile)));
        const hasTestReqs = (getSpecificationItems(tree, TEST_REQUIREMENTS) ?? []).length > 0;
        const passed = specSteps.every((step) => step.result.passed);
        return {
          moduleName,
          buildDir,
          conformanceRoot,
          frids: allFrids,
          outcomes: [],
          completed: passed ? allFrids : [],
          conformance: options.conformance === false ? "off: asked" : (options.conformance ?? hasTestReqs) ? "on" : "off: no test reqs",
          passed,
          specSteps,
        };
      }
    }
  }

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
  // Read once for the module: the required modules do not change while this one builds.
  const required = getInheritedFunctionalSpecs(tree);

  const outcomes: FunctionalityOutcome[] = [];
  const completed = allFrids.slice(0, fromIndex);
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
  // What decides each functionality is done is the project's testing scripts: without them,
  // nothing is built.
  // Turned off, the conformance testing script is not used at all, found or not.
  const found = findTestScripts(projectRootFor(options.plainFile, buildDir), options.plainFile, buildDir);
  const scripts = options.conformance === false ? withoutConformance(found) : found;
  requireTestScripts(moduleName, scripts, { conformance: conformanceEnabled });
  const inRange = allFrids.slice(fromIndex, toIndex + 1);
  reportStage(
    `${unitOf(moduleName)}: ${allFrids.length} functionalit${allFrids.length === 1 ? "y" : "ies"} - ` +
      (pending.length === 0
        ? "all built from their current specs, nothing to do"
        : `building ${pending.map((entry) => entry.frid).join(", ")}${inRange.length > pending.length ? ` (${inRange.length - pending.length} already built)` : ""}`) +
      (options.conformance === false ? ", conformance off" : conformanceEnabled ? ", with conformance tests" : ", no test reqs - no conformance tests of its own"),
  );

  for (let index = fromIndex; index <= toIndex; index += 1) {
    const frid = allFrids[index]!;

    if (!toBuild.has(frid)) {
      reportActivity(`  functionality ${frid} is already built from its current spec - skipped`);
      options.onEvent?.({ type: "functionality_skipped", frid });
      completed.push(frid);
      continue;
    }

    options.onEvent?.({
      type: "functionality_start",
      frid,
      index: index + 1,
      total: allFrids.length,
      spec: getSpecificationsForFrid(tree, frid)[0]["functional specs"].at(-1)?.trim(),
    });

    // A functionality is one unit - its code, its conformance tests, the whole suite passing
    // with it - landed whole or undone whole.
    const unit = startWork([buildDir, conformanceDirFor(moduleName, conformanceRoot)], moduleName);
    options.onEvent?.({ type: "phase", frid, phase: "render" });
    const render = await renderFunctionality({
      plainFile: options.plainFile,
      frid,
      conformance: conformanceEnabled,
      templateDirs: options.templateDirs,
      buildDir,
      model: options.model,
      onDelta: options.onDelta,
      onRun: (cmd, exitCode) => options.onEvent?.({ type: "run", command: cmd, exitCode }),
    });

    if (!render.passed) {
      outcomes.push({ frid, render, stoppedAt: "unit tests" });
      options.onEvent?.({ type: "stopped", frid, at: "unit tests" });
      break;
    }

    if (!conformanceEnabled) {
      // No new conformance tests for this functionality - but the ones already here, this
      // module's and those carried up from below, are kept passing whatever is built.
      options.onEvent?.({ type: "phase", frid, phase: "regression" });
      const regression = await ensureRegressionPasses({
        start: unit,
        buildDir,
        conformanceRoot,
        moduleName,
        frids: [...completed, frid],
        tree,
        required,
        scripts,
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
      reportStage(`${unitOf(moduleName, frid)}: done - functionality ${index + 1} of ${allFrids.length} built`);
      options.onEvent?.({ type: "functionality_done", frid });
      continue;
    }

    reportStage(`${unitOf(moduleName, frid)}: unit tests pass - writing its conformance tests`);
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

    if (!conformance.passed) {
      abandonWork(unit, moduleName, `functionality ${frid}'s conformance tests do not pass`);
      outcomes.push({ frid, render, conformance, stoppedAt: "conformance" });
      options.onEvent?.({ type: "stopped", frid, at: "conformance" });
      break;
    }

    options.onEvent?.({ type: "phase", frid, phase: "regression" });
    const regression = await ensureRegressionPasses({
      start: unit,
      buildDir,
      conformanceRoot,
      moduleName,
      frids: [...completed, frid],
      tree,
      required,
      scripts,
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
    reportStage(`${unitOf(moduleName, frid)}: done - functionality ${index + 1} of ${allFrids.length} built`);
    options.onEvent?.({ type: "functionality_done", frid });
  }

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

/**
 * Bring a module's code up to its spec as a sequence of spec diffs: the changes between the tree
 * the code is built from and the spec, ordered into steps, each rendered as a spec diff from the
 * spec as that step leaves it - up to the first that does not pass. Undefined when the change
 * does not land in this module's own codebase - a later module is built on it - where the chain
 * brings it in instead.
 */
async function renderAsSpecDiffs(
  options: RenderModuleOptions,
  module: { moduleName: string; tree: MarshalledPlainSource; built: MarshalledPlainSource; buildDir: string },
): Promise<SpecStepOutcome[] | { queued: Array<{ title: string; jobId: string }> } | undefined> {
  const { renderSpecDiff, snapshotSpec } = await import("./spec-change.ts");
  const project = projectDirOf(options.plainFile);
  const snapshot = snapshotSpec(options.plainFile, { cwd: project, templateDirs: options.templateDirs });
  const tip = snapshot.chain.at(-1)!;
  if (tip.moduleName !== module.moduleName || resolve(tip.buildDir) !== resolve(module.buildDir)) return undefined;

  reportStage(`${unitOf(module.moduleName)}: the spec has moved on from the code in more than new functional specs - planning the change as spec diffs`);
  const plan = await planSpecSteps(module.built, module.tree, {
    planner: options.planner ?? llmPlanner({ cwd: project, model: options.model, label: `${module.moduleName} spec steps planner` }),
    specFile: relative(project, options.plainFile),
    specText: readFileSync(options.plainFile, "utf8"),
  });
  reportStage(`${unitOf(module.moduleName)}: ${plan.steps.length} spec diff${plan.steps.length === 1 ? "" : "s"} - ${plan.steps.map((step) => step.title).join("; ")}`);

  if (options.queueSpecDiffs !== undefined) {
    const ids = options.queueSpecDiffs(
      plan.steps.map((step) => ({ title: step.title, plainFile: options.plainFile, diff: step.textDiff, spec: { ...snapshot, tree: step.tree } })),
    );
    return { queued: plan.steps.map((step, index) => ({ title: step.title, jobId: ids[index]! })) };
  }

  const outcomes: SpecStepOutcome[] = [];
  for (const [index, step] of plan.steps.entries()) {
    reportStage(`${unitOf(module.moduleName)}: spec diff ${index + 1} of ${plan.steps.length} - ${step.title}`);
    // What it is on now - and so, in the job panel, for how long.
    reportSpec({ label: `${module.moduleName} spec diff ${index + 1} of ${plan.steps.length}`, text: step.title });
    // What it renders, as a render spec diff job shows its diff: with the progress, and in /watch.
    reportTranscript({ kind: "diff", text: step.textDiff });
    options.onEvent?.({ type: "spec_diff_start", index: index + 1, total: plan.steps.length, title: step.title, diff: step.textDiff });
    const result = await renderSpecDiff({
      plainFile: options.plainFile,
      diff: step.textDiff,
      cwd: project,
      templateDirs: options.templateDirs,
      // The spec is already as it ends; each step is built from the spec as it leaves it.
      applied: "already applied",
      spec: { ...snapshot, tree: step.tree },
      conformance: options.conformance,
      model: options.model,
      onDelta: options.onDelta,
    });
    outcomes.push({ title: step.title, reason: step.reason, sections: step.sections, result });
    options.onEvent?.({ type: "spec_diff_done", index: index + 1, passed: result.passed });
    if (!result.passed) break;
  }
  return outcomes;
}

export interface RegenerateFunctionalityOptions extends RenderModuleOptions {
  frid: string;
  /** The spec as it was when the regeneration was asked for: what it builds, whatever the file says by then. */
  pinned?: PinnedSpec;
  /**
   * Land on the unit tests, and leave the conformance tests - brought in line with the new spec - and
   * the whole suite to a job of its own right behind it, as a functionality's render and a spec diff do.
   */
  conformanceLater?: boolean;
  /**
   * The module whose codebase to regenerate in. Default: the furthest-built module whose
   * requires chain includes this one - required only when those sit on different branches.
   */
  inModule?: string;
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
  /** It landed on its unit tests: its conformance tests, and the whole suite, follow as a job of their own. */
  conformanceLater?: boolean;
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
  const [moduleName, tree] = options.pinned !== undefined ? [options.pinned.moduleName, options.pinned.tree] : plainFileParser(basename(options.plainFile), templateDirs);

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

  const buildDir = resolve(host?.buildDir ?? options.buildDir ?? defaultBuildDir(moduleName, projectDirOf(options.plainFile)));
  const conformanceRoot = resolve(options.conformanceRoot ?? modulesRoot(projectDirOf(options.plainFile)));

  if (listFiles(buildDir).length === 0) {
    throw new Error(
      `Nothing to regenerate: ${buildDir} is empty or missing. ` +
        "regenerateFunctionality updates code that already exists - render the module first.",
    );
  }

  const base = { moduleName, frid: options.frid, codebaseOf: host?.moduleName, buildDir, conformanceRoot };
  const owner = host?.moduleName ?? moduleName;
  // The regeneration is one unit - the code, its conformance tests, the whole suite - landed
  // whole or undone whole.
  const unit = startWork([buildDir, conformanceDirFor(owner, conformanceRoot)], owner);

  options.onEvent?.({ type: "phase", frid: options.frid, phase: "render" });
  const render = await renderFunctionality({
    plainFile: options.plainFile,
    frid: options.frid,
    // Its conformance tests are brought in line after it, unless conformance is off.
    conformance: options.conformance !== false,
    templateDirs: options.templateDirs,
    buildDir,
    model: options.model,
    regenerate: { in: host },
    ...(options.pinned !== undefined ? { pinned: options.pinned } : {}),
    onDelta: options.onDelta,
    onRun: (cmd, exitCode) => options.onEvent?.({ type: "run", command: cmd, exitCode }),
  });

  if (!render.passed) {
    return { ...base, render, passed: false, stoppedAt: "unit tests" };
  }

  // The scripts of the codebase it is regenerated in; turned off, no conformance testing script is used.
  const found = findTestScripts(projectRootFor(host?.plainFile ?? options.plainFile, buildDir), host?.plainFile ?? options.plainFile, buildDir);
  const scripts = options.conformance === false ? withoutConformance(found) : found;
  const hasTestReqs = (getSpecificationItems(tree, TEST_REQUIREMENTS) ?? []).length > 0;

  // Landed on its unit tests: its conformance tests and the whole suite are the job behind it.
  if (options.conformanceLater === true && options.conformance !== false && hasTestReqs) {
    reportStage(`${unitOf(moduleName, options.frid)}: regenerated - its conformance tests, and the whole suite, follow as a job of their own`);
    return { ...base, render, passed: true, stoppedAt: null, conformanceLater: true };
  }

  // No conformance tests of its own to bring in line - conformance is off, or the module has no
  // test reqs to write them from. The codebase's existing ones are still kept passing, unless off.
  if (options.conformance === false || !hasTestReqs) {
    reportStage(`${unitOf(moduleName, options.frid)}: regenerated - ${options.conformance === false ? "conformance is off" : "no test reqs, so no conformance tests of its own"}`);
    const regression = await ensureRegressionPasses({
      start: unit,
      buildDir,
      conformanceRoot,
      moduleName: host?.moduleName ?? moduleName,
      frids: allFrids,
      tree,
      required: requiredFunctionalSpecs(host?.plainFile ?? options.plainFile, options.templateDirs),
      scripts,
      model: options.model,
      maxRounds: options.maxRegressionRounds,
      onDelta: options.onDelta,
      onEvent: options.onEvent,
    });
    return { ...base, render, regression, passed: regression.passed, stoppedAt: regression.passed ? null : "regression" };
  }

  reportStage(`${unitOf(moduleName, options.frid)}: regenerated - bringing its conformance tests in line with the new spec`);
  options.onEvent?.({ type: "phase", frid: options.frid, phase: "conformance" });
  const conformance = await renderConformanceTests({
    plainFile: options.plainFile,
    frid: options.frid,
    templateDirs: options.templateDirs,
    buildDir,
    // In the codebase it is regenerated in: its tests are that codebase's tests.
    conformanceDir: conformanceDirFor(host?.moduleName ?? moduleName, conformanceRoot),
    model: options.model,
    // The spec it was asked to regenerate from, when it was pinned: the tests follow what the code was built from.
    ...(options.pinned !== undefined ? { spec: options.pinned } : {}),
    onDelta: options.onDelta,
    onRun: (cmd, exitCode) => options.onEvent?.({ type: "run", command: cmd, exitCode }),
  });

  if (!conformance.passed) {
    abandonWork(unit, owner, `functionality ${options.frid}'s conformance tests do not pass`);
    return { ...base, render, conformance, passed: false, stoppedAt: "conformance" };
  }

  // Every functionality that has tests on disk, not just the ones up to this one: a
  // specification change can break something built later just as easily as earlier. The
  // codebase's tests directory holds the whole chain's, copied up with the code.
  options.onEvent?.({ type: "phase", frid: options.frid, phase: "regression" });
  const regression = await ensureRegressionPasses({
    start: unit,
    buildDir,
    conformanceRoot,
    moduleName: host?.moduleName ?? moduleName,
    frids: allFrids,
    tree,
    required: requiredFunctionalSpecs(host?.plainFile ?? options.plainFile, options.templateDirs),
    // The suite of the codebase it is regenerated in, run by that codebase's script.
    scripts,
    model: options.model,
    maxRounds: options.maxRegressionRounds,
    onDelta: options.onDelta,
    onEvent: options.onEvent,
  });

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
    const required = builtRequiredSpecs(entry.buildDir);
    if (required === null || required.length === 0) continue;

    const recorded = new Map(required.map((spec) => [`${spec.module}/${spec.frid}`, spec]));
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
  if (chain.length > 1) reportStage(`the chain: ${chain.map((entry) => entry.moduleName).join(" → ")} - each module is built on the one before it`);

  const byModule = new Map(chain.map((entry) => [entry.moduleName, entry]));
  const outcomes: ChainOutcome[] = [];

  // A module required now that the built code was not started on - the specs split into a new
  // module below: it is built, and every built module above it starts again from scratch, on it.
  const fresh = options.skipRequires ? undefined : newlyRequired(chain);
  if (fresh !== undefined) {
    const now = fresh.modules.join(", ");
    for (const entry of fresh.rebuild) {
      reportStage(`${unitOf(entry.moduleName)}: it now requires ${now}, which its code was not built on - starting it again from scratch`);
      startFromScratch(entry, `it now requires ${now}`);
    }
  }

  // Where the chain's code already lives. Everything below it is in its codebase, so it is
  // not rebuilt in its own - an ancestor whose spec changed is regenerated up here instead.
  const covering = options.force || options.skipRequires ? undefined : coveringCodebase(chain, options.templateDirs);

  for (const [index, entry] of chain.entries()) {
    if (covering !== undefined && index < covering.index) {
      reportActivity(`  ${entry.moduleName}: its code is already in ${chain[covering.index]!.moduleName}'s codebase - not rebuilt on its own`);
      options.onChainEvent?.({ type: "module_skipped", module: entry.moduleName });
      outcomes.push({ module: entry.moduleName, skipped: true, copied: 0 });
      continue;
    }

    let regenerated: RegenerateFunctionalityResult[] | undefined;
    if (covering !== undefined && index === covering.index && covering.stale.length > 0) {
      regenerated = [];
      reportStage(`${unitOf(entry.moduleName)}: ${covering.stale.length} functionalit${covering.stale.length === 1 ? "y" : "ies"} of the modules below changed - regenerating ${covering.stale.length === 1 ? "it" : "them"} here first`);
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
    // Up to date: every functionality built, from the spec as it stands - its sections too.
    if (!options.force && isModuleUpToDate(entryTree, entry.buildDir) && reachedByRendering(readBuiltTree(entry.buildDir), entryTree)) {
      reportActivity(`  ${entry.moduleName}: already built from its current spec - skipped`);
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

    reportStage(`${unitOf(entry.moduleName)}: module ${index + 1} of ${chain.length} in the chain`);
    let copied = 0;
    if (entry.requires !== null) {
      const source = byModule.get(entry.requires);
      if (source !== undefined) {
        reportStage(`${unitOf(entry.moduleName)}: starting from ${entry.requires}'s code and conformance tests`);
        copied = copyRequiredCode(source.buildDir, entry.buildDir, entry.moduleName, source.moduleName, entryTree).length;
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
    });

    outcomes.push({ module: entry.moduleName, skipped: false, copied, result, regenerated });
    options.onChainEvent?.({ type: "module_done", module: entry.moduleName, passed: result.passed });

    if (!result.passed) return { chain, outcomes, passed: false };
    // Its spec diffs are queued, not built: a module after it would be built on the code before them.
    // The chain stops here; asking again once they land picks it up.
    if (result.queuedSpecDiffs !== undefined && index < chain.length - 1) return { chain, outcomes, passed: true };
  }

  return { chain, outcomes, passed: true };
}

/** The facts of where a functionality's build stopped, for describeStop. */
function stopFacts(moduleName: string, outcome: Pick<FunctionalityOutcome, "frid" | "render" | "conformance" | "regression" | "stoppedAt">): StopFacts | undefined {
  if (outcome.stoppedAt === null) return undefined;
  return {
    moduleName,
    frid: outcome.frid,
    at: outcome.stoppedAt,
    runs: outcome.render.runs,
    attempts: outcome.render.attempts,
    conformance: outcome.conformance,
    repairs: outcome.regression?.repairs.length,
  };
}

/** Where a chain stopped, why, and what to do - or nothing when it did not stop. */
export function describeChainStop(result: RenderChainResult): string | undefined {
  for (const outcome of result.outcomes) {
    for (const regenerated of outcome.regenerated ?? []) {
      const facts = stopFacts(regenerated.moduleName, regenerated);
      if (facts) return describeStop(facts);
    }
    for (const step of outcome.result?.specSteps ?? []) {
      const { result: change } = step;
      if (change.stoppedAt === null) continue;
      return describeStop({
        moduleName: change.moduleName,
        at: change.stoppedAt,
        runs: change.runs,
        attempts: change.attempts,
        conformance: change.conformance,
        repairs: change.regression?.repairs.length,
      });
    }
    for (const functionality of outcome.result?.outcomes ?? []) {
      const facts = stopFacts(outcome.module, functionality);
      if (facts) return describeStop(facts);
    }
  }
  return undefined;
}

/** Where a regeneration stopped, why, and what to do - or nothing when it passed. */
export function describeRegenerationStop(result: RegenerateFunctionalityResult): string | undefined {
  const facts = stopFacts(result.moduleName, result);
  return facts ? describeStop(facts) : undefined;
}
