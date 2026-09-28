import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { ask, createExecutor } from "../pi.ts";
import { PLAIN_SOURCE_FILE_EXTENSION, plainFileParser } from "../plain/parser.ts";
import {
  ACCEPTANCE_TESTS,
  FUNCTIONAL_REQUIREMENTS,
  getFrids,
  getInheritedFunctionalSpecs,
  getSpecificationItemMarkdown,
  getSpecificationsForFrid,
  TEST_REQUIREMENTS,
  type MarshalledPlainSource,
  type SpecificationItem,
} from "../plain/spec.ts";
import { reportActivity, reportSpec, reportStage, reportTryIt, type BuildingSpec, unitOf } from "./activity.ts";
import { codebaseMap } from "./codebase.ts";
import { abandonWork, recordHistory, startFromLastCommit, type WorkStart } from "./history.ts";
import { notesForSession, withNotes } from "./notes.ts";
import { createScriptTool, findTestScripts, projectRootFor, requireTestScripts, runUnitScript, withTestingScripts } from "./test-scripts.ts";
import { createWebTools, WEB_TOOLS } from "./web.ts";
import { ATTEMPTS } from "./stop-report.ts";
import { requiredFunctionalSpecs } from "./requires.ts";
import { confinedTools } from "./confine.ts";
import { defaultBuildDir, tryDirFor, projectDirOf } from "./paths.ts";
import { readBuiltTree, recordBuiltFunctionality, recordBuiltRequiredFunctionality, STATE_FILE, type RequiredSpec } from "./state.ts";
import { buildRegeneratePrompt, buildRenderPrompt } from "./prompt.ts";
import { loadLinkedResources } from "./resources.ts";
import { misplacedConformanceTests, misplacedTestsPrompt } from "./test-kinds.ts";
import {
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
   * Whether conformance tests are written for this build - so the conformance testing script is
   * in the agent's prompt too. Default: when the module has test reqs.
   */
  conformance?: boolean;
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
  /** How many times the harness ran the unit testing script on it: the attempts it judged. */
  attempts?: number;
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
  const buildDir = resolve(host?.buildDir ?? options.buildDir ?? defaultBuildDir(moduleName, projectDirOf(options.plainFile)));
  const stage = (label: string) => {
    if (!options.dryRun) reportStage(`${unitOf(moduleName, frid)}: ${label}`);
  };
  stage(`${options.regenerate ? "regenerating" : "building"} functionality ${frid} of ${frids.length}${host ? ` in ${host.moduleName}'s codebase` : ""}`);
  // Whether the code is done is the project's unit testing script: without one, nothing is built.
  stage("finding the project's testing scripts");
  const root = projectRootFor(options.plainFile, buildDir);
  const scripts = findTestScripts(root, options.plainFile, buildDir);
  if (!options.dryRun) requireTestScripts(moduleName, scripts, { conformance: false });
  if (!options.dryRun) reportActivity(`  unit testing script: ${relative(root, scripts.unit!)}`);
  const conformance = options.conformance ?? specifications[TEST_REQUIREMENTS].length > 0;
  if (!options.dryRun) reportSpec(buildingSpec(moduleName, frid, frids.length, specifications, conformance));
  const required = getInheritedFunctionalSpecs(tree);
  // Work starts from the last known good state of the codebase it is done in: whatever an
  // interrupted run left half-written is gone before anything reads the code.
  stage("starting from the codebase's last commit");
  const start: WorkStart | undefined = options.dryRun ? undefined : startFromLastCommit(buildDir, host?.moduleName ?? moduleName);

  stage(options.regenerate === undefined ? "mapping the codebase and writing the prompt" : "working out what changed, and writing the prompt");
  let prompt: string;
  if (options.regenerate === undefined) {
    const codebase = codebaseMap(buildDir);
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
  // The scripts its work is judged by: the unit testing script, and the conformance testing
  // script when conformance tests are written for this build.
  prompt = withTestingScripts(prompt, scripts, conformance ? ["unit", "conformance"] : ["unit"], root);
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

  mkdirSync(buildDir, { recursive: true });

  const runs: TestRun[] = [];
  const runTests = createScriptTool({
    kind: "unit",
    script: scripts.unit,
    run: () => runUnitScript(buildDir, scripts.unit!),
    runs,
    onRun: options.onRun,
  });

  // The build directory is the whole world for this agent: it reads and writes there and
  // nowhere else. Nothing above `plain_modules` is reachable, including this repo.
  const fence = confinedTools({ workdir: buildDir });
  let tryIt: TryIt | undefined;
  const notes = notesForSession(buildDir, `${moduleName} ${frid}`);
  stage(`starting the coding agent${options.model ? ` (${options.model})` : ""}`);
  const executor = await createExecutor({
    cwd: buildDir,
    customTools: [runTests, createTryItTool((submitted) => (tryIt = submitted)), notes.tool, ...createWebTools(), ...fence.tools],
    tools: [...fence.names, ...EXTRA_CODING_TOOLS, "update_notes", ...WEB_TOOLS],
    model: options.model,
    label: `${moduleName} ${frid} coding agent`,
    system: fence.note,
  });

  try {
    // Tests already present belong to earlier functionalities. They are part of what
    // this run must not break, so the baseline is taken before the agent starts.
    let inventory = inventoryTests(buildDir);
    const testRemovals: TestRemoval[] = [];

    stage("plainwright is writing the code and its unit tests");
    let response = await ask(executor, prompt, options.onDelta);

    const maxFollowUps = options.maxFollowUps ?? DEFAULT_MAX_FOLLOW_UPS;
    let followUp = 0;
    /** The harness's runs of the unit testing script: each is an attempt it judged. */
    let attempts = 0;
    // Back and forth until the harness's run of the unit testing script passes - whatever the
    // agent ran, and whether it ran anything - or the rounds run out. Picks up where it left off
    // when called again.
    const untilPassing = async (): Promise<boolean> => {
      for (; followUp < maxFollowUps; followUp += 1) {
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

        // Conformance tests are the conformance step's, in the tests folder: none of them here.
        const misplaced = misplacedConformanceTests(buildDir);
        if (misplaced.length > 0) {
          stage(`conformance tests in the code folder - sending ${misplaced.length === 1 ? "it" : "them"} back`);
          response = await ask(executor, misplacedTestsPrompt(misplaced, buildDir), options.onDelta);
          continue;
        }

        stage(`running the unit testing script (attempt ${attempts + 1})`);
        attempts += 1;
        const verdict = await verifyUnitSuite(buildDir, runs, scripts.unit!);
        if (verdict.ok) stage(`unit tests pass (attempt ${attempts})`);
        if (!verdict.ok) {
          stage(`unit tests not passing - fixing (round ${followUp + 1} of ${maxFollowUps})`);
          response = await ask(executor, verdict.prompt, options.onDelta);
          continue;
        }
        return true;
      }
      return false;
    };
    let verified = await untilPassing();

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
      // Working out how to try it may have touched the code: the harness checks again, and a run
      // that fails goes back to the agent like any other - it does not end the build.
      if (tryIt !== undefined) reportTryIt({ tryIt, buildDir });
      if (tryIt !== undefined) verified = await untilPassing();
    }
    stage("checking the working notes were left");
    await notes.ensureWritten((next) => ask(executor, next, options.onDelta));
    const files = listFiles(buildDir);

    // Passing means the harness's own run of the unit testing script passed, last.
    const passed = verified;

    // What the code is now built from, recorded here rather than in each caller - every route
    // into a render, the render queue, the CLI, renderModule, lands the same way. A render that
    // does not pass lands nothing: the codebase goes back to where it started, as if it had
    // never been tried, and the tree still says what the code is built from.
    const what = targetFunctionality(specifications).split("\n")[0]!.replace(/^- /, "");
    if (!passed) {
      stage("unit tests NOT passing - undoing the render");
      abandonWork(start, host?.moduleName ?? moduleName, `functionality ${frid} did not pass its unit tests`);
    } else if (host === undefined) {
      stage("recording what the code is built from, and committing it");
      recordBuiltFunctionality(buildDir, tree, frid);
      recordHistory(buildDir, `${options.regenerate ? "regenerate" : "render"} ${moduleName} fs ${frid}: ${what}`);
    } else {
      // Rebuilt in a later module's codebase: that codebase's tree says so. This module's own
      // build is left as it was - an older snapshot, no longer where the code lives.
      stage("recording what the code is built from, and committing it");
      const item = (tree[FUNCTIONAL_REQUIREMENTS] as SpecificationItem[])[Number(frid) - 1]!;
      recordBuiltRequiredFunctionality(buildDir, moduleName, frid, item);
      recordHistory(buildDir, `regenerate ${moduleName} fs ${frid} in ${host.moduleName}: ${what}`);
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
      attempts,
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
  const built = readBuiltTree(input.buildDir);

  // What the codebase holds: what it inherits, and what of the owner's own is built.
  const ownBuilt: RequiredSpec[] = ((built?.[FUNCTIONAL_REQUIREMENTS] as SpecificationItem[] | undefined) ?? []).map((item, index) => ({
    module: owner.moduleName,
    frid: String(index + 1),
    ...asSpec(item),
  }));
  const everything = [...requiredFunctionalSpecs(owner.plainFile, input.templateDirs), ...ownBuilt];
  const implemented = everything.filter((spec) => !(spec.module === input.moduleName && spec.frid === input.frid));

  const recorded =
    input.host === undefined
      ? ownBuilt.find((spec) => spec.frid === input.frid)
      : built === null
        ? undefined
        : getInheritedFunctionalSpecs(built).find((spec) => spec.module === input.moduleName && spec.frid === input.frid);
  // Missing from a tree that holds everything else means it is new since the build. No tree -
  // or one without the inherited specs - says nothing either way, so it is treated as a change.
  const listsEverything = input.host === undefined ? built !== null : getInheritedFunctionalSpecs(built ?? {}).length > 0;
  const added = recorded === undefined && listsEverything;

  const unchanged =
    recorded !== undefined &&
    recorded.spec === input.current.spec &&
    JSON.stringify(recorded.acceptanceTests ?? []) === JSON.stringify(input.current.acceptanceTests ?? []);

  return { implemented, previous: recorded?.spec, added, unchanged, codebase: codebaseMap(input.buildDir) };
}

/** A functional spec item as text, its acceptance tests with it. */
function asSpec(item: SpecificationItem): { spec: string; acceptanceTests?: string[] } {
  const tests = item[ACCEPTANCE_TESTS];
  return {
    spec: getSpecificationItemMarkdown(item, {}, true),
    ...(tests !== undefined ? { acceptanceTests: tests.map((test) => getSpecificationItemMarkdown(test, {}, true)) } : {}),
  };
}

/** The functionality just built: the last of the ones in scope. */
function targetFunctionality(specifications: { "functional specs": string[] }): string {
  return specifications["functional specs"].at(-1) ?? "";
}

/**
 * The functional spec a step builds, for the person watching: which one of how many, and its
 * text as the spec has it - with its acceptance tests after it when conformance is on, since
 * only then are they built.
 */
export function buildingSpec(
  moduleName: string,
  frid: string,
  total: number,
  specifications: { "functional specs": string[]; [ACCEPTANCE_TESTS]?: string[] },
  conformance: boolean,
): BuildingSpec {
  const acceptance = conformance ? (specifications[ACCEPTANCE_TESTS] ?? []) : [];
  return {
    label: `${moduleName} functionality ${frid} of ${total}`,
    text: [targetFunctionality(specifications).trim(), ...(acceptance.length > 0 ? ["", "acceptance tests:", ...acceptance.map((test) => test.trim())] : [])].join("\n"),
  };
}
