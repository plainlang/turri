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
import { createWebTools, WEB_TOOLS } from "./web.ts";
import { ATTEMPTS } from "./stop-report.ts";
import type { RequiredSpec } from "./state.ts";
import { defaultBuildDir, modulesRoot, testsDirUnder, ensureInVmScratch, vmScratchDir } from "./paths.ts";
import { buildConformancePrompt } from "./prompt.ts";
import { diffFiles, digestFiles } from "./codebase.ts";
import { loadLinkedResources } from "./resources.ts";
import { resolveTemplateDirs } from "./render.ts";
import {
  createRunTestsTool,
  findTestRemovals,
  inventoryTests,
  listFiles,
  removalChallengePrompt,
  runCommand,
  truncateOutput,
  type TestRemoval,
  type TestRun,
  chooseRegressionCommand,
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
 * Run a command against the built code with one or more test sets laid over it.
 *
 * Neither the build nor the tests are touched: everything happens in a throwaway copy, so a
 * test run cannot leave anything behind in the codebase it is testing, and each run starts
 * from the same state as the last.
 *
 * Several sets merge for a regression run - every functionality built so far. A file that
 * would land on one already taken is renamed rather than overwritten, because two
 * functionalities are allowed to have written a `test_helpers.py` each and neither of them
 * should silently lose.
 */
export async function runInSandbox(
  buildDir: string,
  conformanceDirs: string | string[],
  command: string,
): Promise<{ exitCode: number; output: string }> {
  const dirs = Array.isArray(conformanceDirs) ? conformanceDirs : [conformanceDirs];
  // The same place every time for the same build and tests, emptied first: the run's VM is
  // started once for it and reused, and nothing from the last run is left in it.
  const key = createHash("sha1").update(JSON.stringify([resolve(buildDir), ...dirs.map((dir) => resolve(dir))])).digest("hex").slice(0, 16);
  // Inside plain_modules, since that is all the VM holds.
  const sandbox = join(vmScratchDir(buildDir), "runs", key);
  rmSync(sandbox, { recursive: true, force: true });
  ensureInVmScratch(buildDir, sandbox);

  try {
    // Entry by entry: a build directory outside plain_modules holds the VM's scratch itself.
    for (const entry of readdirSync(buildDir)) {
      if (entry !== ".plainwright") cpSync(join(buildDir, entry), join(sandbox, entry), { recursive: true });
    }

    const taken = new Set(listFiles(sandbox));
    dirs.forEach((dir, index) => {
      if (!existsSync(dir)) return;
      for (const file of listFiles(dir)) {
        let target = file;
        if (taken.has(target)) {
          const renamed = `${index + 1}_${basename(file)}`;
          target = dirname(file) === "." ? renamed : join(dirname(file), renamed);
        }
        taken.add(target);
        const destination = join(sandbox, target);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(join(dir, file), destination);
      }
    });

    return await runCommand(sandbox, command);
  } finally {
    // Emptied, not removed: the next run reuses the path, and the VM mounted on it.
    for (const entry of readdirSync(sandbox)) rmSync(join(sandbox, entry), { recursive: true, force: true });
  }
}

function createRunTool(
  buildDir: string,
  conformanceDir: string,
  runs: TestRun[],
  lastOutput: { value: string },
  onRun?: (command: string, exitCode: number) => void,
) {
  return defineTool({
    name: "run_conformance_tests",
    label: "Run conformance tests",
    description:
      "Run a command against the built code with your tests laid over it, in a throwaway copy. " +
      "Use the command the test reqs specify. Returns the exit code and combined output.",
    promptSnippet: "run_conformance_tests: run your tests against the built code",
    parameters: Type.Object({
      command: Type.String({ description: 'Shell command, e.g. "python -m unittest discover"' }),
    }),
    async execute(_id, params) {
      const { exitCode, output } = await runInSandbox(buildDir, conformanceDir, params.command);
      runs.push({ command: params.command, exitCode });
      lastOutput.value = output;
      onRun?.(params.command, exitCode);
      return {
        content: [{ type: "text" as const, text: `exit code: ${exitCode}\n\n${output}` }],
        details: { command: params.command, exitCode },
      };
    },
  });
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

  const linkedResources = loadLinkedResources(tree, frid, templateDirs);
  const required = getInheritedFunctionalSpecs(tree);
  const prompt = buildConformancePrompt({
    moduleName,
    frid,
    specifications,
    linkedResources,
    manifest,
    codeDir: buildDir,
    existingTests: listFiles(conformanceDir),
    required,
    diff: options.diff,
  });

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
  const lastOutput = { value: "" };
  const codeBefore = digestFiles(buildDir);
  const codeChanged = () => {
    const diff = diffFiles(codeBefore, digestFiles(buildDir));
    return diff.added.length + diff.changed.length + diff.removed.length > 0;
  };

  // One agent, going back and forth until the tests pass: it writes them from the spec, and
  // when one fails it works out - against the spec - whether the test or the code is wrong, and
  // fixes that one. It works in its tests and sees plain_modules, the code included.
  const fence = confinedTools({ workdir: conformanceDir });
  const notes = notesForSession(buildDir, `${moduleName} ${frid} conformance`);
  const executor = await createExecutor({
    cwd: conformanceDir,
    customTools: [
      notes.tool,
      ...createWebTools(),
      ...fence.tools,
      createRunTool(buildDir, conformanceDir, runs, lastOutput, options.onRun),
      createRunTestsTool({
        name: "run_unit_tests",
        label: "Run unit tests",
        description: `Run the code's unit tests, in ${buildDir}, and return the exit code and output. Use it after changing the code.`,
        run: (command) => runCommand(buildDir, command),
        runs: unitRuns,
      }),
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

      const last = runs.at(-1);
      if (last === undefined) {
        response = await ask(
          executor,
          "You have not run the tests yet. Call run_conformance_tests with the command the test reqs give.",
          options.onDelta,
        );
        continue;
      }

      if (last.exitCode !== 0) {
        stage(`conformance tests failing - fixing (round ${round + 1} of ${maxRounds})`);
        response = await ask(executor, conformanceFailingPrompt(last.command, last.exitCode, lastOutput.value, buildDir), options.onDelta);
        continue;
      }

      // Its own run passed. The conformance tests and each acceptance test have to be there, and
      // labelled as what they are, before anything else counts.
      if (options.diff === undefined) {
        const missing = missingTestLabels(conformanceDir, frid, specifications[ACCEPTANCE_TESTS] ?? []);
        if (missing.length > 0) {
          stage("labelling the conformance and acceptance tests");
          response = await ask(executor, labelsPrompt(frid, missing), options.onDelta);
          continue;
        }
      }

      // Whether the functionality is done is the harness's run: the whole
      // suite, run by the harness - and the code's unit tests, when the agent changed the code.
      stage("checking the conformance tests");
      const suite = chooseRegressionCommand(runs);
      if (suite.command === null || suite.narrow) {
        response = await ask(
          executor,
          `Your last passing run, \`${last.command}\`, does not run the whole conformance suite. Call ` +
            "run_conformance_tests with the whole-suite command from the test reqs, the one that discovers every " +
            "test in the working directory, and fix whatever it reports.",
          options.onDelta,
        );
        continue;
      }
      const recheck = await runInSandbox(buildDir, conformanceDir, suite.command);
      runs.push({ command: suite.command, exitCode: recheck.exitCode });
      lastOutput.value = recheck.output;
      options.onRun?.(suite.command, recheck.exitCode);
      if (recheck.exitCode !== 0) {
        stage(`conformance tests failing when the harness runs them - fixing (round ${round + 1} of ${maxRounds})`);
        response = await ask(
          executor,
          [
            `The harness ran the whole conformance suite itself - \`${suite.command}\` - and it failed (exit ${recheck.exitCode}):`,
            "",
            recheck.output.trimEnd(),
            "",
            "Fix what is wrong - against the specification, the test or the code - and run it again.",
          ].join("\n"),
          options.onDelta,
        );
        continue;
      }
      if (codeChanged()) {
        stage("the code changed - checking its unit tests");
        const unit = await verifyUnitSuite(buildDir, unitRuns);
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
function conformanceFailingPrompt(command: string, exitCode: number, output: string, codeDir: string): string {
  return [
    `\`${command}\` exited ${exitCode}:`,
    "",
    output.trimEnd(),
    "",
    "Work out, against the specification, what is wrong - your test or the code - and fix that one:",
    "- A test that asserts something the specification does not require, or misreads it, is corrected.",
    `- Code that does not do what the specification says is fixed, in ${codeDir}. Then run its unit tests`,
    "  with run_unit_tests and keep them passing.",
    "Never change a test so it agrees with code that contradicts the specification, and never delete, skip or",
    "weaken a test to get a pass. Then run the tests again.",
  ].join("\n");
}
