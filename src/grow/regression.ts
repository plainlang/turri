import { existsSync } from "node:fs";
import { ask, BEGIN, createExecutor } from "../pi.ts";
import { getSpecificationsForFrid, type MarshalledPlainSource } from "../plain/spec.ts";
import { conformanceDirFor } from "./conformance.ts";
import { reportActivity, reportStage, unitOf } from "./activity.ts";
import { confinedTools } from "./confine.ts";
import { projectRootOf } from "./paths.ts";
import { buildRegressionFixPrompt, sectionModules } from "./prompt.ts";
import { abandonWork, markWork, recordHistory, type WorkStart } from "./lineage.ts";
import { CODER_COMPACTION } from "./compaction.ts";
import { notesForSession, withNotes } from "./notes.ts";
import { createScriptTool, MissingTestScriptError, runConformanceScript, runUnitScript, withTestingScripts, type TestScripts } from "./test-scripts.ts";
import { createWebTools, WEB_TOOLS } from "./web.ts";
import { ATTEMPTS } from "./stop-report.ts";
import type { RequiredSpec } from "./state.ts";
import { keepingTestsUnchanged, listFiles, type TestRun } from "./testing.ts";

/**
 * The regression gate: every conformance test of a codebase - its own and those it inherits - run together with
 * the unit tests, and the code repaired by an agent that may not touch the tests until they all pass. A conformance
 * job ends on it: tests that pass on their own are not done until the whole suite passes with them.
 */

/** On top of the file tools, which are fenced to the build directory by `confine.ts`. */
const FIX_TOOLS = ["run_unit_tests", "run_conformance_tests", "update_notes"];
const DEFAULT_MAX_REGRESSION_ROUNDS = ATTEMPTS.regression;

/** What a regression run reports as it goes: a run of the suite, a repair. */
export type RegressionEvent = { type: "run"; command: string; exitCode: number; frids?: string[] } | { type: "repair"; frids: string[] };

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
          modules: sectionModules(input.tree, input.moduleName),
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
    reportStage(`${unitOf(input.moduleName)}: turri is repairing the code so every functionality's conformance tests pass together`);
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
  onEvent?: (event: RegressionEvent) => void;
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
