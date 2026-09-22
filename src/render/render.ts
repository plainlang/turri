import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { ask, createExecutor } from "../pi.ts";
import { PLAIN_SOURCE_FILE_EXTENSION, plainFileParser } from "../plain/parser.ts";
import { getFrids, getSpecificationsForFrid, type MarshalledPlainSource } from "../plain/spec.ts";
import { reportStage } from "./activity.ts";
import { confinedTools } from "./confine.ts";
import { defaultBuildDir, tryDirFor } from "./paths.ts";
import { recordFunctionality, specStateFor, STATE_FILE } from "./state.ts";
import { buildRenderPrompt } from "./prompt.ts";
import { loadLinkedResources } from "./resources.ts";
import {
  createRunTestsTool,
  failingTestsPrompt,
  findTestRemovals,
  inventoryTests,
  removalChallengePrompt,
  runCommand,
  type TestRemoval,
  type TestRun,
} from "./testing.ts";
import {
  checkTryIt,
  createTryItTool,
  failedStepsPrompt,
  prepareTryDir,
  tryItPrompt,
  type TryIt,
} from "./try-it.ts";

/** Tools the coding agent gets. Scoped to the build directory by the session's cwd. */
/**
 * The agent gets file tools fenced to its build directory and, where the platform can
 * enforce it, a sandboxed shell. See `confine.ts`: `cwd` alone is a starting point, not a
 * boundary, and this agent has no business anywhere but the module it is building.
 */
const EXTRA_CODING_TOOLS = ["run_unit_tests", "describe_how_to_try_it"];

/** How many times the harness will send the agent back before giving up. */
const DEFAULT_MAX_FOLLOW_UPS = 4;

export interface RenderFunctionalityOptions {
  /** Path to the .plain file. */
  plainFile: string;
  /** Functionality to build. Defaults to the first one. */
  frid?: string;
  /** Extra template directories, after the plain file's own directory. */
  templateDirs?: string[];
  /** Where the agent works. Defaults to `<cwd>/plain_modules/<module>/code`. */
  buildDir?: string;
  /** Stream the agent's output. */
  onDelta?: (delta: string) => void;
  /** Build the prompt and stop, without starting a session. */
  dryRun?: boolean;
  /** Times the harness may send the agent back for failing tests or removed tests. */
  maxFollowUps?: number;
  onRun?: (command: string, exitCode: number) => void;
  /** "provider/model-id". Omitted: whatever pi is configured to use. */
  model?: string;
}

export interface RenderFunctionalityResult {
  moduleName: string;
  frid: string;
  buildDir: string;
  prompt: string;
  /** The agent's closing message. Empty for a dry run. */
  response: string;
  /** Files in the build directory after the run. */
  files: string[];
  /** Files that were not there before it. */
  added: string[];
  /** The functionality's own text, for telling the user what was just built. */
  functionality: string;
  /** Every test run the harness observed, in order. */
  runs: TestRun[];
  /** Whether the last observed run passed. False when the agent never ran the tests. */
  passed: boolean;
  /** Tests that went missing mid-run and had to be justified. */
  testRemovals: TestRemoval[];
  /** How a person runs it and sees this functionality, checked by the harness. */
  tryIt?: TryIt;
}

/**
 * Template search order, matching file_utils.get_template_directories: the plain file's
 * own directory first, then a sibling `template/` directory if there is one (the
 * convention `config.yaml` uses), then anything passed in, then PLAIN_TEMPLATE_DIRS.
 */
export function resolveTemplateDirs(plainFile: string, extra: string[] = []): string[] {
  const own = dirname(resolve(plainFile));
  const dirs = [own];

  const sibling = join(own, "template");
  if (existsSync(sibling)) dirs.push(sibling);

  dirs.push(...extra.map((dir) => resolve(dir)));

  const fromEnv = process.env.PLAIN_TEMPLATE_DIRS;
  if (fromEnv) dirs.push(...fromEnv.split(":").filter(Boolean).map((dir) => resolve(dir)));

  return [...new Set(dirs)];
}

export function listFrids(plainFile: string, templateDirs?: string[]): {
  moduleName: string;
  tree: MarshalledPlainSource;
  frids: string[];
} {
  const dirs = resolveTemplateDirs(plainFile, templateDirs);
  const [moduleName, tree] = plainFileParser(basename(plainFile), dirs);
  return { moduleName, tree, frids: [...getFrids(tree)] };
}

function listFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      // The state file is the harness's own bookkeeping, not part of the codebase: it is
      // never shown to an agent as a file it wrote, copied forward to a requiring module,
      // or counted when asking whether anything has been built.
      if (entry === ".git" || entry === "node_modules" || entry === "__pycache__" || entry === STATE_FILE)
        continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else found.push(relative(root, full));
    }
  };
  if (existsSync(root)) walk(root);
  return found.sort();
}

/**
 * Parse a .plain file, build the context for one functionality, and hand it to a coding
 * agent in its own working directory.
 */
export async function renderFunctionality(
  options: RenderFunctionalityOptions,
): Promise<RenderFunctionalityResult> {
  if (extname(options.plainFile) !== PLAIN_SOURCE_FILE_EXTENSION) {
    throw new Error(
      `Expected a ${PLAIN_SOURCE_FILE_EXTENSION} file, got '${options.plainFile}'.`,
    );
  }

  const templateDirs = resolveTemplateDirs(options.plainFile, options.templateDirs);
  const [moduleName, tree] = plainFileParser(basename(options.plainFile), templateDirs);

  const frids = [...getFrids(tree)];
  const frid = options.frid ?? frids[0];
  if (frid === undefined) throw new Error(`Module '${moduleName}' has no functionalities.`);
  if (!frids.includes(frid)) {
    throw new Error(`Functionality ${frid} does not exist. Available: ${frids.join(", ")}.`);
  }

  const [specifications] = getSpecificationsForFrid(tree, frid);
  const linkedResources = loadLinkedResources(tree, frid, templateDirs);

  const prompt = buildRenderPrompt({ moduleName, frid, specifications, linkedResources });
  const buildDir = resolve(options.buildDir ?? defaultBuildDir(moduleName));

  if (options.dryRun) {
    return {
      moduleName,
      frid,
      buildDir,
      prompt,
      response: "",
      files: listFiles(buildDir),
      added: [],
      functionality: targetFunctionality(specifications),
      runs: [],
      passed: false,
      testRemovals: [],
    };
  }

  const filesBefore = new Set(listFiles(buildDir));

  mkdirSync(buildDir, { recursive: true });

  const runs: TestRun[] = [];
  const runTests = createRunTestsTool({
    name: "run_unit_tests",
    label: "Run unit tests",
    description:
      "Run the unit test suite in the working directory and return the exit code and output. " +
      "Use the command the test reqs specify.",
    run: (command) => runCommand(buildDir, command),
    runs,
    onRun: options.onRun,
  });

  // The build directory is the whole world for this agent: it reads and writes there and
  // nowhere else. Nothing above `plain_modules` is reachable, including this repo.
  const fence = confinedTools({ workdir: buildDir, read: [], write: [buildDir] });
  let tryIt: TryIt | undefined;
  const executor = await createExecutor({
    cwd: buildDir,
    customTools: [runTests, createTryItTool((submitted) => (tryIt = submitted)), ...fence.tools],
    tools: [...fence.names, ...EXTRA_CODING_TOOLS],
    model: options.model,
  });

  try {
    // Tests already present belong to earlier functionalities. They are part of what
    // this run must not break, so the baseline is taken before the agent starts.
    let inventory = inventoryTests(buildDir);
    const testRemovals: TestRemoval[] = [];

    const stage = (label: string) => reportStage(`${moduleName} ${frid}: ${label}`);
    stage("writing code and unit tests");
    let response = await ask(executor, prompt, options.onDelta);

    const maxFollowUps = options.maxFollowUps ?? DEFAULT_MAX_FOLLOW_UPS;
    for (let followUp = 0; followUp < maxFollowUps; followUp += 1) {
      const current = inventoryTests(buildDir);
      const removals = findTestRemovals(inventory, current);

      if (removals.length > 0) {
        testRemovals.push(...removals);
        // Re-baseline so a removal is challenged once; restoring it shows up as a pass
        // on the next lap rather than as a second accusation.
        inventory = current;
        stage(`justifying ${removals.length} removed test${removals.length === 1 ? "" : "s"}`);
        response = await ask(executor, removalChallengePrompt(removals, "unit tests"), options.onDelta);
        continue;
      }

      if (runs[runs.length - 1]?.exitCode !== 0) {
        stage(`unit tests not passing yet - fixing (round ${followUp + 1} of ${maxFollowUps})`);
        response = await ask(executor, failingTestsPrompt(runs, "run_unit_tests"), options.onDelta);
        continue;
      }

      break;
    }

    // Asked only once the tests pass: instructions for software that does not work yet
    // would be instructions for something else.
    let files = listFiles(buildDir);
    if (runs[runs.length - 1]?.exitCode === 0) {
      tryIt = undefined;
      stage("working out how you can try it");
      await ask(executor, tryItPrompt(frid), options.onDelta);
      files = listFiles(buildDir);
      if (tryIt !== undefined) {
        // In a copy made for the person, never the build: the next render works in the
        // build, and whatever trying it leaves behind - a database, installed packages -
        // stays out of the codebase. A fresh copy each time, so a fix is what gets checked.
        const tryDir = tryDirFor(buildDir, moduleName, frid);
        const check = (steps: TryIt) => checkTryIt(prepareTryDir(buildDir, tryDir), { ...steps, dir: tryDir });
        stage("running the try-it steps to check they work");
        let checked = check(tryIt);
        if (!checked.ok) {
          const first = checked;
          tryIt = undefined;
          stage("a try-it step failed - fixing it");
          await ask(executor, failedStepsPrompt(first.tryIt, first.outputs), options.onDelta);
          files = listFiles(buildDir);
          checked = tryIt !== undefined ? check(tryIt) : first;
        }
        tryIt = checked.tryIt;
      }
    }

    // A fix to the instructions may have touched the code, so this is the last run, not
    // the one before the question was asked.
    const passed = runs[runs.length - 1]?.exitCode === 0;

    // Record what this build now contains, here rather than in each caller. Every route
    // into a render - the queue behind start_render, the CLI, renderModule - has to leave
    // the state file behind it, or nothing downstream can tell a functionality that was
    // built from one that was never attempted.
    recordFunctionality(buildDir, moduleName, {
      frid,
      ...specStateFor(tree, frid),
      unitTests: passed ? "passed" : "failed",
    });

    return {
      moduleName,
      frid,
      buildDir,
      prompt,
      response,
      files,
      added: files.filter((file) => !filesBefore.has(file)),
      functionality: targetFunctionality(specifications),
      runs,
      passed,
      testRemovals,
      tryIt,
    };
  } finally {
    executor.dispose();
  }
}


/** The functionality just built: the last of the ones in scope. */
function targetFunctionality(specifications: { "functional specs": string[] }): string {
  return specifications["functional specs"].at(-1) ?? "";
}
