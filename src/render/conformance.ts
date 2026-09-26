import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ask, createExecutor } from "../pi.ts";
import { PLAIN_SOURCE_FILE_EXTENSION, plainFileParser } from "../plain/parser.ts";
import {
  ACCEPTANCE_TESTS,
  DEFINITIONS,
  FUNCTIONAL_REQUIREMENTS,
  NON_FUNCTIONAL_REQUIREMENTS,
  getFrids,
  getInheritedFunctionalSpecs,
  getSpecificationsForFrid,
  TEST_REQUIREMENTS,
  type MarshalledPlainSource,
  type Specifications,
} from "../plain/spec.ts";
import { reportActivity, reportSpec, reportStage } from "./activity.ts";
import { confinedTools } from "./confine.ts";
import { abandonWork, moduleDirOf, recordHistory, startWork, type WorkStart } from "./history.ts";
import { notesForSession, withNotes } from "./notes.ts";
import { labelsPrompt, misplacedConformanceTests, misplacedTestsPrompt, missingTestLabels } from "./test-kinds.ts";
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
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { codeFixPrompt, createCodeFixer, exploreInvocation, judgeFailure, testsFixPrompt, type SpecContext } from "./conformance-agents.ts";
import { ATTEMPTS } from "./stop-report.ts";
import { sectionsOf, type RequiredSpec } from "./state.ts";
import { defaultBuildDir, modulesRoot, testsDirUnder, ensureInVmScratch, vmScratchDir, projectDirOf } from "./paths.ts";
import { buildConformancePrompt } from "./prompt.ts";
import { diffFiles, digestFiles } from "./codebase.ts";
import { loadLinkedResources } from "./resources.ts";
import { buildingSpec, resolveTemplateDirs } from "./render.ts";
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
  /** How many times the harness ran the conformance testing script: the rounds it judged. */
  rounds?: number;
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

  // For a spec change, the tests follow the change, whatever it touches - a definition, a req -
  // with or without a functional spec yet; for one functionality, they are that functionality's.
  const forChange = options.diff !== undefined;
  const frids = [...getFrids(tree)];
  const frid = options.frid ?? (forChange ? frids.at(-1) : frids[0]);
  if (frid === undefined && !forChange) throw new Error(`Module '${moduleName}' has no functionalities.`);
  if (frid !== undefined && !frids.includes(frid)) {
    throw new Error(`Functionality ${frid} does not exist. Available: ${frids.join(", ")}.`);
  }

  const buildDir = resolve(options.buildDir ?? defaultBuildDir(moduleName, projectDirOf(options.plainFile)));
  const conformanceDir = resolve(options.conformanceDir ?? conformanceDirFor(moduleName, modulesRoot(projectDirOf(options.plainFile))));
  const stage = (label: string) => {
    if (!options.dryRun) reportStage(`${forChange ? moduleName : `${moduleName} ${frid}`}: ${label}`);
  };
  stage(options.diff !== undefined ? "conformance tests for the spec change" : `conformance tests for functionality ${frid}`);
  if (!options.dryRun && !forChange) reportSpec(buildingSpec(moduleName, frid!, frids.length, getSpecificationsForFrid(tree, frid!)[0], true));
  // From the last known good state, unless this step continues work not yet committed.
  // On its own it is one unit - its tests, and any change to the code - landed whole or undone
  // whole. Continuing work already under way, it is part of that work's unit instead.
  let start: WorkStart | undefined;
  if (!options.dryRun && options.continuing !== true) {
    stage("starting from the codebase's last commit");
    start = startWork([buildDir, conformanceDir], moduleName);
  }
  const manifest = listFiles(buildDir);
  if (manifest.length === 0) {
    throw new Error(
      `Nothing to test: ${buildDir} is empty or missing. ` +
        (forChange ? "Render the spec change first." : `Render the functionality first, for example: npm run render -- ${options.plainFile} ${frid}`),
    );
  }

  // The spec as it stands: every section, and the functional specs - none, for a change made
  // before any was written.
  const specifications: Specifications =
    frid !== undefined
      ? getSpecificationsForFrid(tree, frid)[0]
      : { ...sectionsOf(tree), [FUNCTIONAL_REQUIREMENTS]: [], [ACCEPTANCE_TESTS]: [] };

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
  stage("finding the project's testing scripts");
  const root = projectRootFor(options.plainFile, buildDir);
  const scripts = findTestScripts(root);
  if (!options.dryRun) requireTestScripts(moduleName, scripts, { conformance: true });

  const linkedResources = loadLinkedResources(tree, forChange ? null : frid!, templateDirs);
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
      frid: frid ?? "",
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
  reportActivity(`  conformance testing script: ${relative(root, scripts.conformance!)}`);
  reportActivity(`  the suite so far: ${listFiles(conformanceDir).length} files in ${relative(root, conformanceDir)}`);

  const runs: TestRun[] = [];
  const unitRuns: TestRun[] = [];
  const testRemovals: TestRemoval[] = [];
  const codeBefore = digestFiles(buildDir);
  const codeChanged = () => {
    const diff = diffFiles(codeBefore, digestFiles(buildDir));
    return diff.added.length + diff.changed.length + diff.removed.length > 0;
  };

  // The code and its tests are rendered apart: the tests in their own folder and VM, by an agent
  // that never sees the code. An explorer reads the code first and writes down how the software is
  // invoked, which is what the tests are written against.
  const label = `${moduleName} ${options.diff !== undefined ? "spec change" : frid}`;
  const specContext: SpecContext = { moduleName, text: specText(specifications, options.diff) };
  stage(`exploring the code for how it is invoked${options.model ? ` (${options.model})` : ""}`);
  const invocation = await exploreInvocation({ buildDir, spec: specContext, label, model: options.model, onDelta: options.onDelta });
  reportActivity(`  how to invoke it: ${invocation.split("\n")[0]!.slice(0, 120)}`);
  const agentPrompt = withTestingScripts(
    buildConformancePrompt({
      moduleName,
      frid,
      specifications,
      linkedResources,
      manifest,
      existingTests: listFiles(conformanceDir),
      required,
      diff: options.diff,
      invocation,
    }),
    scripts,
    ["conformance"],
    root,
  );

  // The conformance agent: its file tools and its shell hold the tests folder, nothing of the code.
  const fence = confinedTools({ workdir: conformanceDir, read: [conformanceDir], write: [conformanceDir] });
  const notes = notesForSession(buildDir, `${label} conformance`);
  stage(`starting the conformance agent${options.model ? ` (${options.model})` : ""}`);
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
    ],
    tools: [...fence.names, "run_conformance_tests", "update_notes", ...WEB_TOOLS],
    model: options.model,
    label: `${label} conformance agent`,
  });

  // The coding agent, made the first time the code is what is wrong.
  let fixer: AgentSession | undefined;
  const fixerNotes = notesForSession(buildDir, `${label} conformance code fix`);
  const askFixer = async (text: (first: boolean) => string) => {
    const first = fixer === undefined;
    fixer ??= await createCodeFixer({
      buildDir,
      label,
      model: options.model,
      tools: [fixerNotes.tool, createScriptTool({ kind: "unit", script: scripts.unit, run: () => runUnitScript(buildDir, scripts.unit!), runs: unitRuns })],
      toolNames: ["run_unit_tests", "update_notes"],
    });
    return ask(fixer, withNotes(text(first), buildDir), options.onDelta);
  };

  try {
    let inventory = inventoryTests(conformanceDir);
    let unitInventory = inventoryTests(buildDir);
    // Acceptance tests only when the spec has them for this functionality.
    const acceptance = options.diff === undefined ? (specifications[ACCEPTANCE_TESTS] ?? []).length : 0;
    stage(
      acceptance > 0
        ? `plainwright is writing conformance tests from the spec, and its ${acceptance} acceptance test${acceptance === 1 ? "" : "s"} apart from them`
        : options.diff !== undefined
          ? "plainwright is bringing the conformance tests in line with the spec change"
          : "plainwright is writing conformance tests from the spec",
    );
    let response = await ask(executor, withNotes(agentPrompt, buildDir), options.onDelta);

    const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
    let verified = false;
    let rounds = 0;
    for (let round = 0; round < maxRounds; round += 1) {
      const current = inventoryTests(conformanceDir);
      const removals = findTestRemovals(inventory, current);
      if (removals.length > 0) {
        stage(`justifying ${removals.length} removed conformance test${removals.length === 1 ? "" : "s"}`);
        testRemovals.push(...removals);
        inventory = current;
        response = await ask(executor, removalChallengePrompt(removals, "conformance tests"), options.onDelta);
        continue;
      }
      // The coding agent keeps the unit tests it found.
      const unitNow = inventoryTests(buildDir);
      const unitRemovals = findTestRemovals(unitInventory, unitNow);
      unitInventory = unitNow;
      if (unitRemovals.length > 0 && fixer !== undefined) {
        stage(`justifying ${unitRemovals.length} removed unit test${unitRemovals.length === 1 ? "" : "s"}`);
        testRemovals.push(...unitRemovals);
        await askFixer(() => removalChallengePrompt(unitRemovals, "unit tests"));
        continue;
      }

      // The conformance tests and each acceptance test have to be there, and labelled as what
      // they are, before anything else counts.
      if (options.diff === undefined) {
        const missing = missingTestLabels(conformanceDir, frid!, specifications[ACCEPTANCE_TESTS] ?? []);
        if (missing.length > 0) {
          stage("labelling the conformance and acceptance tests");
          response = await ask(executor, labelsPrompt(frid!, missing), options.onDelta);
          continue;
        }
      }

      // The suite is the tests folder: a conformance test in the code folder is in the wrong place,
      // and not the coding agent's to write.
      const misplaced = misplacedConformanceTests(buildDir);
      if (misplaced.length > 0) {
        stage(`conformance tests in the code folder - the coding agent removes ${misplaced.length === 1 ? "it" : "them"}`);
        await askFixer(() => misplacedTestsPrompt(misplaced, buildDir, conformanceDir));
        continue;
      }

      // Whether it is done is the harness's run of the project's conformance testing script, on
      // every functionality's tests, in the tests VM - and the code's unit testing script.
      stage(`running the conformance testing script on the whole suite (attempt ${rounds + 1} of ${maxRounds})`);
      rounds += 1;
      const recheck = await runConformanceScript(buildDir, [conformanceDir], scripts);
      runs.push({ command: recheck.command, exitCode: recheck.exitCode });
      options.onRun?.(recheck.command, recheck.exitCode);
      if (recheck.exitCode !== 0) {
        // A toolchain missing, or a run out of time, is not a question of test or code: the tests'
        // environment is the conformance agent's.
        if (recheck.exitCode === 69 || recheck.timedOut === true) {
          stage("the conformance run did not get to the tests - back to the conformance agent");
          response = await ask(executor, scriptFailure(recheck, "conformance testing"), options.onDelta);
          continue;
        }
        stage("conformance tests failing - working out whether the code or the tests are wrong");
        const verdict = await judgeFailure({ buildDir, conformanceDir, spec: specContext, run: recheck, invocation, label, model: options.model, onDelta: options.onDelta });
        reportActivity(`  ${verdict.culprit === "code" ? "the code" : "the tests"}: ${verdict.reason.split("\n")[0]!.slice(0, 160)}`);
        if (verdict.culprit === "code") {
          stage("the code is wrong - the coding agent fixes it");
          await askFixer((first) => codeFixPrompt({ buildDir, spec: specContext, run: recheck, reason: verdict.reason, first }));
        } else {
          stage("the tests are wrong - the conformance agent fixes them");
          response = await ask(executor, testsFixPrompt({ run: recheck, reason: verdict.reason }), options.onDelta);
        }
        continue;
      }
      stage(`conformance tests pass (attempt ${rounds})`);
      // Done is both: the conformance suite passing, and the unit tests with it - whether or not
      // the code looks changed. Conformance passing on code whose unit tests fail is not done.
      stage("running the unit testing script too");
      const unit = await verifyUnitSuite(buildDir, unitRuns, scripts.unit!);
      if (!unit.ok) {
        stage("unit tests NOT passing - the coding agent fixes the code");
        await askFixer(() => `The conformance tests pass, but the code's unit tests do not - and both have to.\n\n${unit.prompt}`);
        continue;
      }
      stage("unit tests pass too");
      verified = true;
      break;
    }

    stage("checking the working notes were left");
    await notes.ensureWritten((next) => ask(executor, next, options.onDelta));
    if (fixer !== undefined) await fixerNotes.ensureWritten((next) => ask(fixer!, next, options.onDelta));
    const changed = codeChanged();
    if (verified) {
      // The tests, and the code when it changed: one commit if they share a module folder.
      const subject = `conformance ${moduleName} ${options.diff !== undefined ? "for a spec change" : `fs ${frid}`}${changed ? " (code changed)" : ""}`;
      stage(`committing the conformance tests${changed ? " and the code changes" : ""}`);
      recordHistory(conformanceDir, subject);
      if (moduleDirOf(buildDir) !== moduleDirOf(conformanceDir)) recordHistory(buildDir, subject);
    } else if (start !== undefined) {
      stage("conformance tests NOT passing - undoing them");
      abandonWork(start, moduleName, `the conformance tests ${options.diff !== undefined ? "for the spec change" : `of functionality ${frid}`} do not pass`);
    }

    return {
      moduleName,
      frid: frid ?? "",
      buildDir,
      conformanceDir,
      prompt: agentPrompt,
      response,
      files: listFiles(conformanceDir),
      runs,
      passed: verified,
      rounds,
      codeChanged: changed,
      testRemovals,
    };
  } finally {
    executor.dispose();
    fixer?.dispose();
  }
}

/** The spec as the explorer, the judge and the coding agent are shown it. */
function specText(specifications: Specifications, diff?: string): string {
  const sections = [DEFINITIONS, NON_FUNCTIONAL_REQUIREMENTS, TEST_REQUIREMENTS, FUNCTIONAL_REQUIREMENTS, ACCEPTANCE_TESTS]
    .map((key) => [key, (specifications as unknown as Record<string, string[] | undefined>)[key] ?? []] as const)
    .filter(([, items]) => items.length > 0)
    .map(([key, items]) => `***${key}***\n\n${items.join("\n\n")}`);
  if (diff !== undefined) sections.push(`<spec change>\n${diff.trim()}\n</spec change>`);
  return sections.join("\n\n");
}
