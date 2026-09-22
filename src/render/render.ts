import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { ask, createExecutor } from "../pi.ts";
import { PLAIN_SOURCE_FILE_EXTENSION, plainFileParser } from "../plain/parser.ts";
import { getFrids, getSpecificationsForFrid, type MarshalledPlainSource } from "../plain/spec.ts";
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

/** Tools the coding agent gets. Scoped to the build directory by the session's cwd. */
const CODING_TOOLS = ["read", "write", "edit", "bash", "ls", "grep", "find", "run_unit_tests"];

/** How many times the harness will send the agent back before giving up. */
const DEFAULT_MAX_FOLLOW_UPS = 4;

export interface RenderFunctionalityOptions {
  /** Path to the .plain file. */
  plainFile: string;
  /** Functionality to build. Defaults to the first one. */
  frid?: string;
  /** Extra template directories, after the plain file's own directory. */
  templateDirs?: string[];
  /** Where the agent works. Defaults to `<cwd>/build/<module>`. */
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
  /** Every test run the harness observed, in order. */
  runs: TestRun[];
  /** Whether the last observed run passed. False when the agent never ran the tests. */
  passed: boolean;
  /** Tests that went missing mid-run and had to be justified. */
  testRemovals: TestRemoval[];
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
      if (entry === ".git" || entry === "node_modules" || entry === "__pycache__") continue;
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
  const buildDir = resolve(options.buildDir ?? join(process.cwd(), "build", moduleName));

  if (options.dryRun) {
    return {
      moduleName,
      frid,
      buildDir,
      prompt,
      response: "",
      files: listFiles(buildDir),
      runs: [],
      passed: false,
      testRemovals: [],
    };
  }

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

  // The session's cwd is the build directory, so the agent's file tools and bash are
  // pointed at the code being built rather than at this repo.
  const executor = await createExecutor({
    cwd: buildDir,
    customTools: [runTests],
    tools: CODING_TOOLS,
    model: options.model,
  });

  try {
    // Tests already present belong to earlier functionalities. They are part of what
    // this run must not break, so the baseline is taken before the agent starts.
    let inventory = inventoryTests(buildDir);
    const testRemovals: TestRemoval[] = [];

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
        response = await ask(executor, removalChallengePrompt(removals, "unit tests"), options.onDelta);
        continue;
      }

      if (runs[runs.length - 1]?.exitCode !== 0) {
        response = await ask(executor, failingTestsPrompt(runs, "run_unit_tests"), options.onDelta);
        continue;
      }

      break;
    }

    return {
      moduleName,
      frid,
      buildDir,
      prompt,
      response,
      files: listFiles(buildDir),
      runs,
      passed: runs[runs.length - 1]?.exitCode === 0,
      testRemovals,
    };
  } finally {
    executor.dispose();
  }
}
