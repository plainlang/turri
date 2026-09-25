import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ask, createExecutor } from "../pi.ts";
import { PLAIN_SOURCE_FILE_EXTENSION, plainFileParser } from "../plain/parser.ts";
import { ACCEPTANCE_TESTS, getFrids, getSpecificationsForFrid, TEST_REQUIREMENTS, getInheritedFunctionalSpecs, type MarshalledPlainSource } from "../plain/spec.ts";
import { reportStage } from "./activity.ts";
import { confinedTools } from "./confine.ts";
import { moduleDirOf, recordHistory, startFromLastCommit } from "./history.ts";
import { notesForSession, withNotes } from "./notes.ts";
import { labelsPrompt, missingTestLabels } from "./test-kinds.ts";
import {
  createScriptTool,
  findTestScripts,
  projectRootFor,
  requireTestScripts,
  runConformanceScript,
  runUnitScript,
  type ScriptRun,
  scriptFailure,
  withTestingScripts,
} from "./test-scripts.ts";
import { createWebTools, WEB_TOOLS } from "./web.ts";
import { ATTEMPTS } from "./stop-report.ts";
import type { RequiredSpec } from "./state.ts";
import { defaultBuildDir, modulesRoot, testsDirUnder, ensureInVmScratch, vmScratchDir } from "./paths.ts";
import { buildConformancePrompt } from "./prompt.ts";
import { diffFiles, digestFiles } from "./codebase.ts";
import { loadLinkedResources } from "./resources.ts";
import { resolveTemplateDirs } from "./render.ts";
import {
  findTestRemovals,
  inventoryTests,
  listFiles,
  removalChallengePrompt,
  runCommand,
  truncateOutput,
  type TestRemoval,
  type TestRun,
  verifyUnitSuite,
} from "./testing.ts";

/**
 * The conformance agent's own tools, beside its file tools and shell: running its tests, and -
 * since it fixes the code when the code is what is wrong - running the code's unit tests.
 */
const CONFORMANCE_TOOLS = ["run_conformance_tests", "run_unit_tests"];

const DEFAULT_MAX_ROUNDS = ATTEMPTS.conformance;

/**
 * A module's conformance tests: one directory, `plain_modules/<module>/tests`, organised
 * however the tests are best organised. It holds the tests of the modules it requires too,
 * copied up with their code, so running it is the regression suite of the whole chain.
 */
export function conformanceDirFor(moduleName: string, root?: string): string {
  return testsDirUnder(root ?? modulesRoot(), moduleName);
}

const MAX_OUTPUT_CHARS = 20000;

export interface RenderConformanceTestsOptions {
  plainFile: string;
  frid?: string;
  templateDirs?: string[];
  /** The rendered code under test. Must exist and be non-empty. */
  buildDir?: string;
  /** Where the tests are written. Defaults to `<cwd>/plain_modules/<module>/tests`. */
  conformanceDir?: string;
  onDelta?: (delta: string) => void;
  onRun?: (command: string, exitCode: number) => void;
  /** Rounds of fixing a failing run before giving up. */
  maxRounds?: number;
  /** "provider/model-id". Omitted: whatever pi is configured to use. */
  model?: string;
  dryRun?: boolean;
  /** Update the tests for a spec change, given as a diff, rather than for one functionality. */
  diff?: string;
  /**
   * The spec as parsed when that change was written. A change rendered from a queue runs after
   * later ones went into the file, so the file is not what this change is about.
   */
  spec?: { moduleName: string; tree: MarshalledPlainSource };
  /**
   * This is a later step of work already under way, whose changes are not committed yet - a
   * spec diff's conformance step - so the module is not put back to its last commit first.
   */
  continuing?: boolean;
}

export interface RenderConformanceTestsResult {
  moduleName: string;
  frid: string;
  buildDir: string;
  conformanceDir: string;
  prompt: string;
  response: string;
  files: string[];
  runs: TestRun[];
  /** Whether the harness's own run of the whole suite passed - and the unit tests, when the code changed. */
  passed: boolean;
  /** Whether the agent changed the code to make the tests pass. */
  codeChanged: boolean;
  /** Conformance tests that went missing mid-run and had to be justified. */
  testRemovals: TestRemoval[];
}


/**
 * Write black-box conformance tests for one functionality of a .plain specification.
 *
 * Runs after the functionality has been rendered: the build directory is the subject,
 * and this refuses to start without one.
 */
export async function renderConformanceTests(
  options: RenderConformanceTestsOptions,
): Promise<RenderConformanceTestsResult> {
  if (extname(options.plainFile) !== PLAIN_SOURCE_FILE_EXTENSION) {
    throw new Error(`Expected a ${PLAIN_SOURCE_FILE_EXTENSION} file, got '${options.plainFile}'.`);
  }

  const templateDirs = resolveTemplateDirs(options.plainFile, options.templateDirs);
  const [moduleName, tree] = options.spec
    ? [options.spec.moduleName, options.spec.tree]
    : plainFileParser(basename(options.plainFile), templateDirs);

  const frids = [...getFrids(tree)];
  const frid = options.frid ?? frids[0];
  if (frid === undefined) throw new Error(`Module '${moduleName}' has no functionalities.`);
  if (!frids.includes(frid)) {
    throw new Error(`Functionality ${frid} does not exist. Available: ${frids.join(", ")}.`);
  }

  const buildDir = resolve(options.buildDir ?? defaultBuildDir(moduleName));
  const conformanceDir = resolve(options.conformanceDir ?? conformanceDirFor(moduleName));
  // From the last known good state, unless this step continues work not yet committed.
  if (!options.dryRun && options.continuing !== true) {
    startFromLastCommit(buildDir, moduleName);
    if (moduleDirOf(conformanceDir) !== moduleDirOf(buildDir)) startFromLastCommit(conformanceDir, moduleName);
  }
  const manifest = listFiles(buildDir);
  if (manifest.length === 0) {
    throw new Error(
      `Nothing to test: ${buildDir} is empty or missing. ` +
        `Render the functionality first, for example: npm run render -- ${options.plainFile} ${frid}`,
    );
  }

  const [specifications] = getSpecificationsForFrid(tree, frid);

  // Conformance tests are written from the test reqs: they say how the suite is built and
  // run. Without them there is nothing to write tests against, and an agent asked anyway
  // would invent a convention that nothing else in the project shares.
  if (specifications[TEST_REQUIREMENTS].length === 0) {
    throw new Error(
      `Module '${moduleName}' has no ${TEST_REQUIREMENTS}, so conformance tests cannot be written. ` +
        `Add a ${TEST_REQUIREMENTS} section saying how conformance tests are written and run, or render ` +
        "with conformance turned off.",
    );
  }

  // Whether the tests pass is the project's conformance testing script - and, when the code is
  // changed, its unit testing script: without them, nothing is written.
  const root = projectRootFor(options.plainFile, buildDir);
  const scripts = findTestScripts(root);
  if (!options.dryRun) requireTestScripts(moduleName, scripts, { conformance: true });

  const linkedResources = loadLinkedResources(tree, frid, templateDirs);
  const required = getInheritedFunctionalSpecs(tree);
  const prompt = withTestingScripts(buildConformancePrompt({
    moduleName,
    frid,
    specifications,
    linkedResources,
    manifest,
    codeDir: buildDir,
    existingTests: listFiles(conformanceDir),
    required,
    diff: options.diff,
  }), scripts, ["conformance", "unit"], root);

  if (options.dryRun) {
    return {
      moduleName,
      frid,
      buildDir,
      conformanceDir,
      prompt,
      response: "",
      files: listFiles(conformanceDir),
      runs: [],
      passed: false,
      codeChanged: false,
      testRemovals: [],
    };
  }

  mkdirSync(conformanceDir, { recursive: true });

  const runs: TestRun[] = [];
  const unitRuns: TestRun[] = [];
  const testRemovals: TestRemoval[] = [];
  const codeBefore = digestFiles(buildDir);
  const codeChanged = () => {
    const diff = diffFiles(codeBefore, digestFiles(buildDir));
    return diff.added.length + diff.changed.length + diff.removed.length > 0;
  };

  // One agent, going back and forth until the tests pass: it writes them from the spec, and
  // when one fails it works out - against the spec - whether the test or the code is wrong, and
  // fixes that one. It works in its tests and sees plain_modules, the code included.
  const fence = confinedTools({ workdir: conformanceDir });
  const notes = notesForSession(buildDir, `${moduleName} ${options.diff !== undefined ? "spec change" : frid} conformance`);
  const executor = await createExecutor({
    cwd: conformanceDir,
    customTools: [
      notes.tool,
      ...createWebTools(),
      ...fence.tools,
      createScriptTool({
        kind: "conformance",
        script: scripts.conformance,
        run: () => runConformanceScript(buildDir, [conformanceDir], scripts),
        runs,
        onRun: options.onRun,
      }),
      createScriptTool({ kind: "unit", script: scripts.unit, run: () => runUnitScript(buildDir, scripts.unit!), runs: unitRuns }),
    ],
    tools: [...fence.names, ...CONFORMANCE_TOOLS, "update_notes", ...WEB_TOOLS],
    model: options.model,
  });

  try {
    let inventory = inventoryTests(conformanceDir);
    const stage = (label: string) => reportStage(`${moduleName} ${frid}: ${label}`);
    stage("writing conformance tests from the spec");
    let response = await ask(executor, withNotes(prompt, buildDir), options.onDelta);

    const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
    let verified = false;
    for (let round = 0; round < maxRounds; round += 1) {
      const current = inventoryTests(conformanceDir);
      const removals = findTestRemovals(inventory, current);
      if (removals.length > 0) {
        testRemovals.push(...removals);
        inventory = current;
        response = await ask(executor, removalChallengePrompt(removals, "conformance tests"), options.onDelta);
        continue;
      }

      // The conformance tests and each acceptance test have to be there, and labelled as what
      // they are, before anything else counts.
      if (options.diff === undefined) {
        const missing = missingTestLabels(conformanceDir, frid, specifications[ACCEPTANCE_TESTS] ?? []);
        if (missing.length > 0) {
          stage("labelling the conformance and acceptance tests");
          response = await ask(executor, labelsPrompt(frid, missing), options.onDelta);
          continue;
        }
      }

      // Whether the functionality is done is the harness's run of the project's conformance
      // testing script, on every functionality's tests - and the code's unit testing script, when
      // the agent changed the code.
      stage("checking the conformance tests");
      const recheck = await runConformanceScript(buildDir, [conformanceDir], scripts);
      runs.push({ command: recheck.command, exitCode: recheck.exitCode });
      options.onRun?.(recheck.command, recheck.exitCode);
      if (recheck.exitCode !== 0) {
        stage(`conformance tests failing - fixing (round ${round + 1} of ${maxRounds})`);
        response = await ask(executor, conformanceFailingPrompt(recheck, buildDir), options.onDelta);
        continue;
      }
      if (codeChanged()) {
        stage("the code changed - checking its unit tests");
        const unit = await verifyUnitSuite(buildDir, unitRuns, scripts.unit!);
        if (!unit.ok) {
          response = await ask(
            executor,
            `You changed the code, so its unit tests must still pass.\n\n${unit.prompt}`,
            options.onDelta,
          );
          continue;
        }
      }
      verified = true;
      break;
    }

    await notes.ensureWritten((next) => ask(executor, next, options.onDelta));
    const changed = codeChanged();
    // The tests, and the code when it changed: one commit if they share a module folder.
    const subject =
      `conformance ${moduleName} ${options.diff !== undefined ? "for a spec change" : `fs ${frid}`} ` +
      `(${verified ? "pass" : "NOT passing"}${changed ? ", code changed" : ""})`;
    recordHistory(conformanceDir, subject);
    if (moduleDirOf(buildDir) !== moduleDirOf(conformanceDir)) recordHistory(buildDir, subject);

    return {
      moduleName,
      frid,
      buildDir,
      conformanceDir,
      prompt,
      response,
      files: listFiles(conformanceDir),
      runs,
      passed: verified,
      codeChanged: changed,
      testRemovals,
    };
  } finally {
    executor.dispose();
  }
}

/** A failing run, handed back to the conformance agent to fix - the test or the code. */
function conformanceFailingPrompt(run: ScriptRun, codeDir: string): string {
  // A toolchain missing, or a run out of time, is not a question of test or code.
  if (run.exitCode === 69 || run.exitCode === 124) return scriptFailure(run, "conformance testing");
  return [
    `The harness ran the project's conformance testing script, \`${run.command}\`, on the whole suite, and it failed (exit ${run.exitCode}):`,
    "",
    run.output.trimEnd(),
    "",
    "Work out, against the specification, what is wrong - your test or the code - and fix that one:",
    "- A test that asserts something the specification does not require, or misreads it, is corrected.",
    `- Code that does not do what the specification says is fixed, in ${codeDir}, and its unit tests kept passing.`,
    "Never change a test so it agrees with code that contradicts the specification, and never delete, skip or",
    "weaken a test to get a pass.",
  ].join("\n");
}
