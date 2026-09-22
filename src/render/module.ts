import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { ask, createExecutor } from "../pi.ts";
import { plainFileParser } from "../plain/parser.ts";
import { getFrids, getSpecificationsForFrid, type MarshalledPlainSource } from "../plain/spec.ts";
import {
  conformanceDirFor,
  renderConformanceTests,
  runInSandbox,
  type RenderConformanceTestsResult,
} from "./conformance.ts";
import { buildRegressionFixPrompt } from "./prompt.ts";
import { renderFunctionality, resolveTemplateDirs, type RenderFunctionalityResult } from "./render.ts";
import {
  chooseRegressionCommand,
  createRunTestsTool,
  listFiles,
  runCommand,
  type TestRun,
} from "./testing.ts";

const FIX_TOOLS = ["read", "write", "edit", "bash", "ls", "grep", "find", "run_unit_tests"];
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
}

export interface FunctionalityOutcome {
  frid: string;
  render: RenderFunctionalityResult;
  conformance?: RenderConformanceTestsResult;
  regression?: RegressionResult;
  /** Where this functionality stopped, or null when it completed. */
  stoppedAt: "unit tests" | "conformance" | "regression" | null;
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
  passed: boolean;
}

export interface RenderModuleOptions {
  plainFile: string;
  templateDirs?: string[];
  buildDir?: string;
  /** Root for per-functionality test directories. Defaults to `<cwd>/conformance`. */
  conformanceRoot?: string;
  model?: string;
  /** Start from this functionality, treating earlier ones as already built. */
  from?: string;
  /** Stop after this functionality. */
  to?: string;
  maxRegressionRounds?: number;
  onDelta?: (delta: string) => void;
  onEvent?: (event: ModuleEvent) => void;
}

export type ModuleEvent =
  | { type: "functionality_start"; frid: string; index: number; total: number }
  | { type: "phase"; frid: string; phase: "render" | "conformance" | "regression" }
  | { type: "run"; command: string; exitCode: number; frids?: string[] }
  | { type: "narrow_command"; command: string }
  | { type: "repair"; frids: string[] }
  | { type: "functionality_done"; frid: string }
  | { type: "stopped"; frid: string; at: string };

function conformanceDirs(conformanceRoot: string, moduleName: string, frids: string[]): string[] {
  return frids
    .map((frid) => conformanceDirFor(moduleName, frid, conformanceRoot))
    .filter((dir) => existsSync(dir) && listFiles(dir).length > 0);
}

/** Repair the implementation after the merged suite went red. */
async function repairRegression(input: {
  buildDir: string;
  moduleName: string;
  frids: string[];
  tree: MarshalledPlainSource;
  failure: string;
  model?: string;
  onDelta?: (delta: string) => void;
}): Promise<string> {
  const [specifications] = getSpecificationsForFrid(input.tree, input.frids[input.frids.length - 1]!);
  const runs: TestRun[] = [];

  const session = await createExecutor({
    cwd: input.buildDir,
    customTools: [
      createRunTestsTool({
        name: "run_unit_tests",
        label: "Run unit tests",
        description: "Run the unit test suite in the working directory and return its exit code and output.",
        run: (command) => runCommand(input.buildDir, command),
        runs,
      }),
    ],
    tools: FIX_TOOLS,
    model: input.model,
  });

  try {
    return await ask(
      session,
      buildRegressionFixPrompt({
        moduleName: input.moduleName,
        frids: input.frids,
        specifications,
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
  command: string | null;
  /** True when `command` is not known to run the whole suite. */
  narrow?: boolean;
  model?: string;
  maxRounds?: number;
  onDelta?: (delta: string) => void;
  onEvent?: (event: ModuleEvent) => void;
}): Promise<RegressionResult> {
  const dirs = conformanceDirs(input.conformanceRoot, input.moduleName, input.frids);
  const runs: RegressionRun[] = [];
  const repairs: string[] = [];

  const narrow = input.narrow ?? false;

  if (input.command === null || dirs.length === 0) {
    // Nothing runnable yet: no functionality has produced a passing command.
    return { passed: dirs.length === 0, runs, repairs, command: input.command, narrow };
  }

  if (narrow) input.onEvent?.({ type: "narrow_command", command: input.command });

  const maxRounds = input.maxRounds ?? DEFAULT_MAX_REGRESSION_ROUNDS;
  for (let round = 0; round <= maxRounds; round += 1) {
    const result = runInSandbox(input.buildDir, dirs, input.command);
    runs.push({ command: input.command, exitCode: result.exitCode, frids: input.frids });
    input.onEvent?.({ type: "run", command: input.command, exitCode: result.exitCode, frids: input.frids });

    if (result.exitCode === 0) return { passed: true, runs, repairs, command: input.command, narrow };
    if (round === maxRounds) break;

    input.onEvent?.({ type: "repair", frids: input.frids });
    repairs.push(
      await repairRegression({
        buildDir: input.buildDir,
        moduleName: input.moduleName,
        frids: input.frids,
        tree: input.tree,
        failure: result.output,
        model: input.model,
        onDelta: input.onDelta,
      }),
    );
  }

  return { passed: false, runs, repairs, command: input.command, narrow };
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
  const buildDir = resolve(options.buildDir ?? join(process.cwd(), "build", moduleName));
  const conformanceRoot = resolve(options.conformanceRoot ?? join(process.cwd(), "conformance"));

  const fromIndex = options.from ? allFrids.indexOf(options.from) : 0;
  if (fromIndex === -1) throw new Error(`Functionality ${options.from} does not exist.`);
  const toIndex = options.to ? allFrids.indexOf(options.to) : allFrids.length - 1;
  if (toIndex === -1) throw new Error(`Functionality ${options.to} does not exist.`);

  const outcomes: FunctionalityOutcome[] = [];
  const completed = allFrids.slice(0, fromIndex);
  let command: string | null = null;
  let narrow = false;

  for (let index = fromIndex; index <= toIndex; index += 1) {
    const frid = allFrids[index]!;
    options.onEvent?.({ type: "functionality_start", frid, index: index + 1, total: allFrids.length });

    options.onEvent?.({ type: "phase", frid, phase: "render" });
    const render = await renderFunctionality({
      plainFile: options.plainFile,
      frid,
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

    options.onEvent?.({ type: "phase", frid, phase: "conformance" });
    const conformance = await renderConformanceTests({
      plainFile: options.plainFile,
      frid,
      templateDirs: options.templateDirs,
      buildDir,
      conformanceDir: conformanceDirFor(moduleName, frid, conformanceRoot),
      model: options.model,
      onDelta: options.onDelta,
      onRun: (cmd, exitCode) => options.onEvent?.({ type: "run", command: cmd, exitCode }),
    });

    const chosen = suiteCommand(conformance);
    if (chosen.command !== null) {
      command = chosen.command;
      narrow = chosen.narrow;
    }

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

  return {
    moduleName,
    buildDir,
    conformanceRoot,
    frids: allFrids,
    outcomes,
    completed,
    passed: outcomes.length > 0 && outcomes.every((outcome) => outcome.stoppedAt === null),
  };
}

export interface RegenerateFunctionalityOptions extends RenderModuleOptions {
  frid: string;
}

export interface RegenerateFunctionalityResult {
  moduleName: string;
  frid: string;
  buildDir: string;
  conformanceRoot: string;
  render: RenderFunctionalityResult;
  conformance?: RenderConformanceTestsResult;
  regression?: RegressionResult;
  passed: boolean;
  stoppedAt: "unit tests" | "conformance" | "regression" | null;
}

/**
 * Rebuild one functionality whose specification changed, over code that already exists.
 *
 * The difference from a first render is what comes after: the whole module's conformance
 * suite runs, not just this functionality's, because a changed specification can move
 * behaviour that another functionality was relying on.
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

  const buildDir = resolve(options.buildDir ?? join(process.cwd(), "build", moduleName));
  const conformanceRoot = resolve(options.conformanceRoot ?? join(process.cwd(), "conformance"));

  if (listFiles(buildDir).length === 0) {
    throw new Error(
      `Nothing to regenerate: ${buildDir} is empty or missing. ` +
        "regenerateFunctionality updates code that already exists - render the module first.",
    );
  }

  options.onEvent?.({ type: "phase", frid: options.frid, phase: "render" });
  const render = await renderFunctionality({
    plainFile: options.plainFile,
    frid: options.frid,
    templateDirs: options.templateDirs,
    buildDir,
    model: options.model,
    onDelta: options.onDelta,
    onRun: (cmd, exitCode) => options.onEvent?.({ type: "run", command: cmd, exitCode }),
  });

  if (!render.passed) {
    return {
      moduleName,
      frid: options.frid,
      buildDir,
      conformanceRoot,
      render,
      passed: false,
      stoppedAt: "unit tests",
    };
  }

  options.onEvent?.({ type: "phase", frid: options.frid, phase: "conformance" });
  const conformance = await renderConformanceTests({
    plainFile: options.plainFile,
    frid: options.frid,
    templateDirs: options.templateDirs,
    buildDir,
    conformanceDir: conformanceDirFor(moduleName, options.frid, conformanceRoot),
    model: options.model,
    onDelta: options.onDelta,
    onRun: (cmd, exitCode) => options.onEvent?.({ type: "run", command: cmd, exitCode }),
  });

  if (!conformance.passed) {
    return {
      moduleName,
      frid: options.frid,
      buildDir,
      conformanceRoot,
      render,
      conformance,
      passed: false,
      stoppedAt: "conformance",
    };
  }

  // Every functionality that has tests on disk, not just the ones up to this one: a
  // specification change can break something built later just as easily as earlier.
  options.onEvent?.({ type: "phase", frid: options.frid, phase: "regression" });
  const regression = await ensureRegressionPasses({
    buildDir,
    conformanceRoot,
    moduleName,
    frids: allFrids,
    tree,
    ...suiteCommand(conformance),
    model: options.model,
    maxRounds: options.maxRegressionRounds,
    onDelta: options.onDelta,
    onEvent: options.onEvent,
  });

  return {
    moduleName,
    frid: options.frid,
    buildDir,
    conformanceRoot,
    render,
    conformance,
    regression,
    passed: regression.passed,
    stoppedAt: regression.passed ? null : "regression",
  };
}
