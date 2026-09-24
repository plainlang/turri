import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { ask, createExecutor } from "../pi.ts";
import { PLAIN_SOURCE_FILE_EXTENSION, plainFileParser } from "../plain/parser.ts";
import { ACCEPTANCE_TESTS, getFrids, getSpecificationsForFrid, type MarshalledPlainSource, getInheritedFunctionalSpecs } from "../plain/spec.ts";
import { reportStage } from "./activity.ts";
import { codebaseMap, diffFiles, digestFiles } from "./codebase.ts";
import { recordHistory, startFromLastCommit } from "./history.ts";
import { notesForSession, withNotes } from "./notes.ts";
import { createWebTools, WEB_TOOLS } from "./web.ts";
import { ATTEMPTS } from "./stop-report.ts";
import { requiredFunctionalSpecs } from "./requires.ts";
import { confinedTools } from "./confine.ts";
import { defaultBuildDir, tryDirFor } from "./paths.ts";
import { readState, recordFunctionality, recordRegeneration, specStateFor, STATE_FILE, type RequiredSpec } from "./state.ts";
import { buildRegeneratePrompt, buildRenderPrompt } from "./prompt.ts";
import { loadLinkedResources } from "./resources.ts";
import {
  createRunTestsTool,
  failingTestsPrompt,
  findTestRemovals,
  inventoryTests,
  listFiles,
  removalChallengePrompt,
  runCommand,
  type TestRemoval,
  type TestRun,
  verifyUnitSuite,
} from "./testing.ts";
import { createTryItTool, settleTryIt, tryItPrompt, type TryIt } from "./try-it.ts";

/** Tools the coding agent gets. Scoped to the build directory by the session's cwd. */
/**
 * The agent gets file tools fenced to its build directory and, where the platform can
 * enforce it, a sandboxed shell. See `confine.ts`: `cwd` alone is a starting point, not a
 * boundary, and this agent has no business anywhere but the module it is building.
 */
const EXTRA_CODING_TOOLS = ["run_unit_tests", "describe_how_to_try_it"];

/** How many times the harness will send the agent back before giving up. */
const DEFAULT_MAX_FOLLOW_UPS = ATTEMPTS["unit tests"];

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
  /**
   * Work out how a person tries it, and check those steps, once the tests pass. Off unless
   * asked for: it is an extra agent turn or two, worth it when someone is waiting to try
   * the result and pure cost on a long unattended run.
   */
  tryIt?: boolean;
  /**
   * The functionality is already in the code and its spec changed: update it rather than
   * build it. `in` is the codebase to update it in - the tip of the chain built on this
   * module - when that is not the module's own.
   */
  regenerate?: {
    in?: { moduleName: string; plainFile: string; buildDir: string };
  };
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
 * own directory first, then a sibling `template/` directory if there is one (where a
 * project keeps its import modules), then anything passed in, then PLAIN_TEMPLATE_DIRS.
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

  const host = options.regenerate?.in !== undefined && options.regenerate.in.moduleName !== moduleName
    ? options.regenerate.in
    : undefined;
  const buildDir = resolve(host?.buildDir ?? options.buildDir ?? defaultBuildDir(moduleName));
  const required = getInheritedFunctionalSpecs(tree);
  // Work starts from the last known good state of the codebase it is done in: whatever an
  // interrupted run left half-written is gone before anything reads the code.
  if (!options.dryRun) startFromLastCommit(buildDir, host?.moduleName ?? moduleName);

  let prompt: string;
  if (options.regenerate === undefined) {
    const codebase = codebaseMap(tree, buildDir, frid);
    prompt = buildRenderPrompt({ moduleName, frid, specifications, linkedResources, codebase, required });
  } else {
    const context = regenerationContext({
      moduleName,
      frid,
      plainFile: options.plainFile,
      templateDirs,
      buildDir,
      host,
      current: { spec: targetFunctionality(specifications), acceptanceTests: specifications[ACCEPTANCE_TESTS] },
    });
    prompt = buildRegeneratePrompt({
      moduleName,
      frid,
      specifications,
      linkedResources,
      previous: context.previous,
      added: context.added,
      unchanged: context.unchanged,
      implemented: context.implemented,
      codebaseOf: host?.moduleName,
      codebase: context.codebase,
    });
  }

  // Led by what earlier agents on this codebase left, and asked to leave the same.
  prompt = withNotes(prompt, buildDir);

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
  const digestsBefore = digestFiles(buildDir);

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
  const fence = confinedTools({ workdir: buildDir });
  let tryIt: TryIt | undefined;
  const notes = notesForSession(buildDir, `${moduleName} ${frid}`);
  const executor = await createExecutor({
    cwd: buildDir,
    customTools: [runTests, createTryItTool((submitted) => (tryIt = submitted)), notes.tool, ...createWebTools(), ...fence.tools],
    tools: [...fence.names, ...EXTRA_CODING_TOOLS, "update_notes", ...WEB_TOOLS],
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
    let verified = false;
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

      // The agent's own run passed. Whether the functionality is done is the harness's run.
      stage("checking the whole unit test suite");
      const verdict = await verifyUnitSuite(buildDir, runs);
      if (!verdict.ok) {
        stage(`unit tests not passing when the harness runs them - fixing (round ${followUp + 1} of ${maxFollowUps})`);
        response = await ask(executor, verdict.prompt, options.onDelta);
        continue;
      }
      verified = true;
      break;
    }

    // Asked only once the tests pass: instructions for software that does not work yet
    // would be instructions for something else.
    if (options.tryIt === true && verified) {
      tryIt = await settleTryIt({
        buildDir,
        tryDir: tryDirFor(buildDir, moduleName, frid),
        prompt: tryItPrompt(`Functionality ${frid}`),
        ask: async (next) => {
          tryIt = undefined;
          await ask(executor, next, options.onDelta);
          return tryIt;
        },
        stage,
      });
    }
    await notes.ensureWritten((next) => ask(executor, next, options.onDelta));
    const files = listFiles(buildDir);

    // Passing means the harness's own run of the whole suite passed. Working out how to try it
    // may have touched the code since, so that run is repeated when it did.
    const passed = verified && (tryIt === undefined || (await verifyUnitSuite(buildDir, runs)).ok);

    // Record what this build now contains, here rather than in each caller. Every route
    // into a render - the queue behind start_render, the CLI, renderModule - has to leave
    // the state file behind it, or nothing downstream can tell a functionality that was
    // built from one that was never attempted.
    const built = {
      unitTests: passed ? ("passed" as const) : ("failed" as const),
      // What the next render is told about where this functionality lives.
      files: diffFiles(digestsBefore, digestFiles(buildDir)),
      testCommand: runs.filter((run) => run.exitCode === 0).at(-1)?.command,
    };
    const outcome = passed ? "unit tests pass" : "unit tests NOT passing";
    const what = targetFunctionality(specifications).split("\n")[0]!.replace(/^- /, "");
    if (host === undefined) {
      recordFunctionality(buildDir, moduleName, { frid, ...specStateFor(tree, frid), ...built, required });
      recordHistory(
        buildDir,
        `${options.regenerate ? "regenerate" : "render"} ${moduleName} fs ${frid}: ${what} (${outcome})`,
      );
    } else {
      // Updated in a later module's codebase: that codebase's record says so. This module's
      // own build is left as it was - an older snapshot, no longer where the code lives.
      recordRegeneration(buildDir, host.moduleName, {
        module: moduleName,
        frid,
        required: requiredFunctionalSpecs(host.plainFile, options.templateDirs),
        build: { specHash: specStateFor(tree, frid).specHash, ...built },
      });
      recordHistory(buildDir, `regenerate ${moduleName} fs ${frid} in ${host.moduleName}: ${what} (${outcome})`);
    }

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


/**
 * What an update is made against: every other functional spec in the codebase, the spec
 * this code was built from, and the map of the codebase as it stands.
 *
 * The codebase is `host`'s when there is one: its required modules' specs, as it records
 * them, and its own built ones. Otherwise it is the module's own: what it requires, and
 * every functionality of it that is built - those after this one too, since they are in
 * the code and have to survive the change.
 */
function regenerationContext(input: {
  moduleName: string;
  frid: string;
  plainFile: string;
  templateDirs: string[];
  buildDir: string;
  host?: { moduleName: string; plainFile: string };
  /** The functionality's spec as it is now. */
  current: { spec: string; acceptanceTests?: string[] };
}): { implemented: RequiredSpec[]; previous?: string; added: boolean; unchanged: boolean; codebase: string | null } {
  const owner = input.host ?? { moduleName: input.moduleName, plainFile: input.plainFile };
  const state = readState(input.buildDir);
  const [, ownerTree] = plainFileParser(basename(owner.plainFile), resolveTemplateDirs(owner.plainFile, input.templateDirs));

  const ownBuilt: RequiredSpec[] = Object.values(state?.functionalities ?? {})
    .sort((a, b) => Number(a.frid) - Number(b.frid))
    .map((entry) => ({ module: owner.moduleName, frid: entry.frid, spec: entry.spec }));
  const everything = [...requiredFunctionalSpecs(owner.plainFile, input.templateDirs), ...ownBuilt];
  const implemented = everything.filter((spec) => !(spec.module === input.moduleName && spec.frid === input.frid));

  const recorded =
    input.host === undefined
      ? state?.functionalities[input.frid]
      : state?.required.find((spec) => spec.module === input.moduleName && spec.frid === input.frid);
  // Missing from a record that lists everything else means it is new since the build. A
  // record without the list says nothing either way, so it is treated as a change.
  const listsEverything = input.host === undefined ? state !== null : (state?.required.length ?? 0) > 0;
  const added = recorded === undefined && listsEverything;

  const unchanged =
    recorded !== undefined &&
    recorded.spec === input.current.spec &&
    JSON.stringify(recorded.acceptanceTests ?? []) === JSON.stringify(input.current.acceptanceTests ?? []);

  return { implemented, previous: recorded?.spec, added, unchanged, codebase: codebaseMap(ownerTree, input.buildDir) };
}

/** The functionality just built: the last of the ones in scope. */
function targetFunctionality(specifications: { "functional specs": string[] }): string {
  return specifications["functional specs"].at(-1) ?? "";
}
