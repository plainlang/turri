import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { ask, BEGIN, createExecutor, refuseIfModelIsBlind } from "../pi.ts";
import { warmVm } from "./vm.ts";
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
import { reportActivity, reportSpec, reportStage, unitOf, type BuildingSpec } from "./activity.ts";
import { confinedTools } from "./confine.ts";
import { abandonWork, diffSinceSnapshot, moduleDirOf, recordHistory, startWork, workDiff, workSnapshot, type WorkStart } from "./lineage.ts";
import { createWorkLedger, describeAccounts, SUBMIT_WORK_NOTE, unanswered, unansweredPrompt } from "./submit-work.ts";
import type { JobCases } from "./drift.ts";
import { CONFORMANCE_COMPACTION } from "./compaction.ts";
import { notesForSession, readNotes, reflectOnReview, withNotes } from "./notes.ts";
import { labelsPrompt, misplacedConformanceTests, misplacedTestsPrompt, missingTestLabels } from "./test-kinds.ts";
import {
  createScriptTool,
  findTestScripts,
  projectRootFor,
  requireTestScripts,
  runConformanceScript,
  runUnitScript,
  type ScriptRun,
  missingToolchain,
  scriptFailure,
  withTestingScripts,
} from "./test-scripts.ts";
import { createWebTools, WEB_TOOLS } from "./web.ts";
import { createMyDiffTool } from "./self-check.ts";
import { createServiceTools } from "./services.ts";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  codeFixPrompt,
  conflictKey,
  createCodeFixer,
  answerAsExplorer,
  createAskExplorerTool,
  exploreInvocation,
  judgeFailure,
  SPEC_CONFLICT_RAISES,
  ENVIRONMENT_RAISES,
  environmentCheckPrompt,
  createTestReviewer,
  testReviewRequest,
  type TestReviewer,
  reviewFeedbackPrompt,
  type ReviewProblem,
  testsFixPrompt,
  sortedRefs,
  type ConflictScope,
  type SpecContext,
} from "./conformance-agents.ts";
import { resolveRequiresChain } from "./requires.ts";
import { notesToRead, recordNote } from "./notes.ts";
import { reportSpecConflict } from "./activity.ts";
import { ATTEMPTS } from "./stop-report.ts";
import { ARBITER_AFTER, arbitrateReview, dismissedNote, REVIEW_LIMIT } from "./arbiter.ts";
import { sectionsOf, type RequiredSpec } from "./state.ts";
import { configForSpec, inheritModel, modelSpec, splitModelSpec } from "../config.ts";
import { defaultBuildDir, modulesRoot, testsDirUnder, vmScratchDir, projectDirOf } from "./paths.ts";
import { buildConformancePrompt, functionalitiesByModule, section, specChangeBlock } from "./prompt.ts";
import { diffFiles, digestFiles } from "./codebase.ts";
import { loadLinkedResources, resourceImages } from "./resources.ts";
import { resolveTemplateDirs } from "./paths.ts";
import {
  findTestRemovals,
  inventoryTests,
  listFiles,
  removalChallengePrompt,
  shownOutput,
  truncateOutput,
  type TestRemoval,
  type TestRun,
  verifyUnitSuite,
} from "./testing.ts";

const DEFAULT_MAX_ROUNDS = ATTEMPTS.conformance;

/**
 * A module's conformance tests: one directory, `plain_modules/<module>/tests`, organised
 * however the tests are best organised. It holds the tests of the modules it requires too,
 * copied up with their code, so running it is the regression suite of the whole chain.
 */
export function conformanceDirFor(moduleName: string, root?: string): string {
  return testsDirUnder(root ?? modulesRoot(), moduleName);
}

export interface RenderConformanceTestsOptions {
  /** What the job does to each functional spec (work.ts): its agents are told case by case. */
  cases?: JobCases;
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
  /** The judge's and the test review's model. Omitted: the project's judge-model, else `model`. */
  judgeModel?: string;
  dryRun?: boolean;
  /** Update the tests for a spec change, given as a diff, rather than for one functionality. */
  diff?: string;
  /** That change section by section, as the agents are shown it in place of the diff. */
  change?: string;
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
  /**
   * The spec contradicts itself: two functionalities that cannot both hold, raised by the judge
   * the times it takes to count. The run stopped on it - nothing in the code or the tests can fix it.
   */
  specConflict?: { functionalities: Array<{ module: string; frid: string }>; reason: string };
  /**
   * The run failed the same way, judged the same way, round after round - and again after the
   * explorer was asked what the tests lacked. It stopped rather than spend its attempts on it.
   */
  stuck?: { failure: string; rounds: number; error: string; times: number; changedNothing?: boolean };
  /**
   * The run's environment is what is wrong - a credential missing or rejected, say - judged so ENVIRONMENT_RAISES
   * times in a row: only the person can fix it, so the run stopped.
   */
  environment?: { reason: string; times: number };
  /** The tests were sent back to be written and labelled, and never were: what was missing the last time. */
  unlabelled?: string[];
  /** The tests were optimised as far as REVIEW_ROUNDS reviews could take them: what the last one still suggested. */
  reviewWaived?: ReviewProblem[];
  /** The suite passed, but the tests never passed review: what the review last found. */
  review?: Array<{ file: string; test?: string; kind: "missing" | "bad"; what: string }>;
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
  // The agents that give a verdict - the judge, the test review - may run on a stronger model than the rest.
  const judgeModel =
    options.judgeModel ?? modelSpec(inheritModel(configForSpec(options.plainFile).judgeModel, splitModelSpec(options.model)));
  const conformanceDir = resolve(options.conformanceDir ?? conformanceDirFor(moduleName, modulesRoot(projectDirOf(options.plainFile))));
  const stage = (label: string) => {
    if (!options.dryRun) reportStage(`${forChange ? unitOf(moduleName) : unitOf(moduleName, frid)}: ${label}`);
  };
  stage(options.diff !== undefined ? "conformance tests for the spec change" : `conformance tests for functionality ${frid}`);
  if (!options.dryRun && !forChange) reportSpec(buildingSpec(moduleName, frid!, frids.length, getSpecificationsForFrid(tree, frid!)[0]));
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
        `Build the code first: turri regrow ${relative(process.cwd(), options.plainFile)}.`,
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
  const scripts = findTestScripts(root, options.plainFile, buildDir);
  if (!options.dryRun) requireTestScripts(moduleName, scripts, { conformance: true });

  const linkedResources = loadLinkedResources(tree, forChange ? null : frid!, templateDirs);
  // The spec's images need a model that reads them: refused before any of its agents starts.
  if (!options.dryRun) await refuseIfModelIsBlind(options.model, resourceImages(linkedResources).length);
  const required = getInheritedFunctionalSpecs(tree);
  const prompt = withTestingScripts(buildConformancePrompt({
    ...(options.cases !== undefined ? { cases: options.cases } : {}),
    moduleName,
    frid,
    specifications,
    linkedResources,
    manifest,
    codeDir: buildDir,
    existingTests: listFiles(conformanceDir),
    required,
    diff: options.change ?? options.diff,
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

  // The code and its tests are rendered apart: the tests in their own folder and VM, by an agent that
  // may read the code but writes only tests. An explorer reads the code first and writes down how the
  // software is invoked, which is what the tests are written against.
  const label = `${moduleName} ${options.diff !== undefined ? "spec change" : frid}`;
  const specContext: SpecContext = { moduleName, text: specText(specifications, moduleName, frids, required, options.change ?? options.diff) };
  // For a spec change: the functionalities it touches, whose acceptance tests are labelled, checked and reviewed.
  const touched = forChange ? touchedFunctionalities(tree, frids, options.diff!) : [];
  // Any functionality of the codebase - this module's, and those of the modules it requires. A
  // functionality's run may raise a spec conflict only with that functionality; a spec diff's, between any two.
  const own = (forChange ? frids : frids.slice(0, frids.indexOf(frid!) + 1)).map((id) => ({ module: moduleName, frid: id }));
  const scope: ConflictScope = {
    functionalities: [...required.map((spec) => ({ module: spec.module, frid: spec.frid })), ...own],
    ...(forChange ? {} : { tested: { module: moduleName, frid: frid! } }),
  };
  /** How many times each spec conflict has been raised in this run, by the two functionalities it names. */
  const conflicts = new Map<string, string[]>();
  /**
   * How many times each failure has come back in this run - in a row or not: a run that swings
   * between two failures, each side undoing the other, is as stuck as one that repeats one.
   */
  const seenFailures = new Map<string, number>();
  let reExplored = false;
  let stuck: RenderConformanceTestsResult["stuck"];
  /** What the review last found, while it has not passed. */
  let lastReview: ReviewProblem[] | undefined;
  /** The run's test reviewer, made at its first review and kept; what it saw last; what the arbiter let go of its last review. */
  let reviewer: TestReviewer | undefined;
  let reviewSeen: string | undefined;
  let reviewLetGo: ReviewProblem[] = [];
  let failedReviews = 0;
  let reviewWaived: ReviewProblem[] | undefined;
  /** What each review that sent the tests back found, oldest first: what the arbiter weighs the next one against. */
  // The config's `review:` - off, the tests are not reviewed.
  const reviewOn = configForSpec(options.plainFile).review !== false;
  const reviewHistory: ReviewProblem[][] = [];
  let specConflict: RenderConformanceTestsResult["specConflict"];
  let environment: RenderConformanceTestsResult["environment"];
  /** How many times in a row the run's environment was judged what is wrong. */
  let environmentRaises = 0;
  /** How many fixes in a row - the code's or the tests' - changed no file: an agent that will not, or cannot, act on the verdict. */
  let idleFixes = 0;
  /**
   * One attempt at the failing run, written into the notes' pitfalls - what the next judge reads
   * first - as cause and effect: what failed, how it was judged, and what was changed; the next
   * attempt's line shows what came of it. Numbered in the line itself: two attempts that went the
   * same way are two lines, not one.
   */
  const recordAttempt = (attempt: number, run: ScriptRun | string, judged: string, change: { who: string; files: string[] }) => {
    const files = change.files.length === 0 ? "nothing" : `${change.files.slice(0, 6).join(", ")}${change.files.length > 6 ? ` and ${change.files.length - 6} more` : ""}`;
    recordNote(
      buildDir,
      "pitfalls",
      `attempt ${attempt}: ${typeof run === "string" ? run : `failed with ${failureLine(run)}`} → judged ${judged.replace(/\s+/g, " ").slice(0, 240)} → the ${change.who} changed ${files}`,
      `${label} conformance attempt ${attempt}`,
    );
  };
  /** Run a fix, and say which files of the code and the tests it changed. */
  const changing = async <T>(work: () => Promise<T>): Promise<{ result: T; files: string[] }> => {
    const code = digestFiles(buildDir);
    const tests = digestFiles(conformanceDir);
    const result = await work();
    const named = (prefix: string, diff: { added: string[]; changed: string[]; removed: string[] }) => [
      ...diff.added.map((file) => `${prefix}/${file} (added)`),
      ...diff.changed.map((file) => `${prefix}/${file}`),
      ...diff.removed.map((file) => `${prefix}/${file} (removed)`),
    ];
    return { result, files: [...named("code", diffFiles(code, digestFiles(buildDir))), ...named("tests", diffFiles(tests, digestFiles(conformanceDir)))] };
  };
  stage(`exploring the code for how it is invoked${options.model ? ` (${options.model})` : ""}`);
  // The explorer reads the conformance testing script too: it is how the tests are built and run, and so how they reach the software.
  const testingScripts = [
    { path: relative(root, scripts.conformance!), runs: "<script> <copy of the build> <copy of the whole conformance suite>", content: readFileSync(scripts.conformance!, "utf8") },
  ];
  // The acceptance tests the explorer's plan has to carry out, step by step.
  const toCarryOut = (forChange ? touched : [{ frid: frid!, acceptanceTests: specifications[ACCEPTANCE_TESTS] ?? [] }])
    .map((item) => ({ module: moduleName, frid: item.frid, count: item.acceptanceTests.length }))
    .filter((item) => item.count > 0);
  // The tests' VM, where the conformance agent's shell runs, boots while the explorer works.
  warmVm(conformanceDir);
  let invocation = await exploreInvocation({ buildDir, spec: specContext, scope, testingScripts, acceptance: toCarryOut, label, model: options.model, onDelta: options.onDelta });
  reportActivity(`  how to invoke it: ${invocation.split("\n")[0]!.slice(0, 120)}`);
  const agentPrompt = withTestingScripts(
    buildConformancePrompt({
      ...(options.cases !== undefined ? { cases: options.cases } : {}),
      moduleName,
      frid,
      specifications,
      linkedResources,
      manifest,
      existingTests: listFiles(conformanceDir),
      required,
      diff: options.change ?? options.diff,
      invocation,
      readCode: buildDir,
      manifests: buildManifests(buildDir),
      touched,
    }),
    scripts,
    ["conformance"],
    root,
  );

  // The conformance agent: its file tools write the tests folder and read the code too; its shell holds only the tests.
  // The full outputs of the test runs, too long to be shown whole: readable by the agents that fix what they show.
  const logsDir = join(vmScratchDir(buildDir), "logs");
  mkdirSync(logsDir, { recursive: true });
  // It reads the code too - how it is reached, what it is called - and writes only tests.
  const fence = confinedTools({ workdir: conformanceDir, read: [conformanceDir, buildDir, logsDir], write: [conformanceDir] });
  const notes = notesForSession(buildDir, `${label} conformance`);
  // Each agent runs the suite three times a turn at most: the third ends its turn, and the harness runs it and judges.
  const conformanceRuns = turnLimited(
    createScriptTool({
      kind: "conformance",
      script: scripts.conformance,
      run: () => runConformanceScript(buildDir, [conformanceDir], scripts),
      runs,
      onRun: options.onRun,
    }),
    RUNS_PER_TURN,
  );
  const fixerConformanceRuns = turnLimited(
    createScriptTool({ kind: "conformance", script: scripts.conformance, run: () => runConformanceScript(buildDir, [conformanceDir], scripts), runs: [] }),
    RUNS_PER_TURN,
  );
  // What the code fixer starts to try the code - a server - stopped when the run ends.
  const fixerServices = createServiceTools({ dir: buildDir });
  // What it hands over at the end of a turn, for its reviewer.
  const work = createWorkLedger();
  stage(`starting the conformance agent${options.model ? ` (${options.model})` : ""}`);
  // One session for the whole run: its task is its instructions, its work compacted as it grows.
  const executor = await createExecutor({
    cwd: conformanceDir,
    customTools: [
      notes.tool,
      work.tool,
      ...createWebTools(),
      ...fence.tools,
      conformanceRuns.tool,
      createMyDiffTool({ dir: conformanceDir, what: "tests" }),
      createAskExplorerTool({
        ask: (question) => {
          stage("the conformance agent asks the explorer");
          return answerAsExplorer({ buildDir, spec: specContext, account: invocation, question, label, model: options.model, onDelta: options.onDelta });
        },
      }),
    ],
    tools: [...fence.names, "run_conformance_tests", "my_diff", "ask_explorer", "update_notes", "submit_work", ...WEB_TOOLS],
    model: options.model,
    label: `${label} conformance agent`,
    system: fence.note,
    task: [withNotes(agentPrompt, buildDir), "", ...SUBMIT_WORK_NOTE].join("\n"),
    compaction: { instructions: CONFORMANCE_COMPACTION },
    images: resourceImages(linkedResources),
  });

  /** A turn of the conformance agent: a fresh count of its runs of the suite. */
  const askConformance = (text: string, onDelta?: (delta: string) => void) => {
    conformanceRuns.newTurn();
    return ask(executor, text, onDelta);
  };

  // The coding agent, made the first time the code is what is wrong.
  let fixer: AgentSession | undefined;
  const fixerNotes = notesForSession(buildDir, `${label} conformance code fix`);
  const askFixer = async (text: string) => {
    fixer ??= await createCodeFixer({
      buildDir,
      conformanceDir,
      logsDir,
      label,
      model: options.model,
      spec: specContext,
      // The unit tests, and the conformance suite - to reproduce the failure and check the fix, seeing only its output.
      tools: [
        fixerNotes.tool,
        createScriptTool({ kind: "unit", script: scripts.unit, run: () => runUnitScript(buildDir, scripts.unit!), runs: unitRuns }),
        fixerConformanceRuns.tool,
        ...fixerServices.tools,
      ],
      toolNames: ["run_unit_tests", "run_conformance_tests", ...fixerServices.names, "update_notes"],
    });
    fixerConformanceRuns.newTurn();
    return ask(fixer, withNotes(text, buildDir), options.onDelta);
  };

  try {
    let inventory = inventoryTests(conformanceDir);
    // What the tests were when this run began: what it adds or changes is what the review gate reads.
    const testsAtStart = digestFiles(conformanceDir);
    let unitInventory = inventoryTests(buildDir);
    // Acceptance tests only when the spec has them for this functionality.
    const acceptance = options.diff === undefined ? (specifications[ACCEPTANCE_TESTS] ?? []).length : 0;
    stage(
      acceptance > 0
        ? `turri is writing conformance tests from the spec, and its ${acceptance} acceptance test${acceptance === 1 ? "" : "s"} apart from them`
        : options.diff !== undefined
          ? "turri is bringing the conformance tests in line with the spec change"
          : "turri is writing conformance tests from the spec",
    );
    let response = await askConformance(BEGIN, options.onDelta);

    const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
    let verified = false;
    let rounds = 0;
    let labelAsks = 0;
    let unlabelled: string[] | undefined;
    for (let round = 0; round < maxRounds; round += 1) {
      const current = inventoryTests(conformanceDir);
      const removals = findTestRemovals(inventory, current);
      if (removals.length > 0) {
        stage(`justifying ${removals.length} removed conformance test${removals.length === 1 ? "" : "s"}`);
        testRemovals.push(...removals);
        inventory = current;
        response = await askConformance(removalChallengePrompt(removals, "conformance tests"), options.onDelta);
        continue;
      }
      // The coding agent keeps the unit tests it found.
      const unitNow = inventoryTests(buildDir);
      const unitRemovals = findTestRemovals(unitInventory, unitNow);
      unitInventory = unitNow;
      if (unitRemovals.length > 0 && fixer !== undefined) {
        stage(`justifying ${unitRemovals.length} removed unit test${unitRemovals.length === 1 ? "" : "s"}`);
        testRemovals.push(...unitRemovals);
        await askFixer(removalChallengePrompt(unitRemovals, "unit tests"));
        continue;
      }

      // The conformance tests and each acceptance test have to be there, and labelled as what
      // they are, before anything else counts.
      if (options.diff === undefined) {
        const missing = missingTestLabels(conformanceDir, frid!, specifications[ACCEPTANCE_TESTS] ?? []);
        if (missing.length > 0) {
          if (labelAsks >= LABEL_ASKS) {
            stage(`the tests were sent back ${LABEL_ASKS} times to be written and labelled, and still are not - stopping`);
            unlabelled = missing;
            break;
          }
          labelAsks += 1;
          stage(listFiles(conformanceDir).length === 0 ? "no tests in the tests folder - the conformance agent writes them" : "labelling the conformance and acceptance tests");
          response = await askConformance(labelsPrompt(frid!, missing, listFiles(conformanceDir).length === 0), options.onDelta);
          continue;
        }
      } else {
        // A spec change: every functionality it touches, as a functionality's own run would have it.
        const pending = touched
          .map((item) => ({ frid: item.frid, missing: missingTestLabels(conformanceDir, item.frid, item.acceptanceTests) }))
          .find((item) => item.missing.length > 0);
        if (pending !== undefined) {
          if (labelAsks >= LABEL_ASKS) {
            stage(`the tests were sent back ${LABEL_ASKS} times to be written and labelled, and still are not - stopping`);
            unlabelled = pending.missing;
            break;
          }
          labelAsks += 1;
          stage(`labelling the conformance and acceptance tests of functionality ${pending.frid}, which the change touches`);
          response = await askConformance(labelsPrompt(pending.frid, pending.missing, listFiles(conformanceDir).length === 0), options.onDelta);
          continue;
        }
      }

      // The suite is the tests folder: a conformance test in the code folder is in the wrong place,
      // and not the coding agent's to write.
      const misplaced = misplacedConformanceTests(buildDir);
      if (misplaced.length > 0) {
        stage(`conformance tests in the code folder - the coding agent removes ${misplaced.length === 1 ? "it" : "them"}`);
        await askFixer(misplacedTestsPrompt(misplaced, buildDir, conformanceDir));
        continue;
      }

      // Whether it is done is the harness's run of the project's conformance testing script, on
      // every functionality's tests, in the tests VM - and the code's unit testing script.
      stage(`running the conformance testing script on the whole suite (attempt ${rounds + 1} of ${maxRounds})`);
      rounds += 1;
      let recheck = await runConformanceScript(buildDir, [conformanceDir], scripts);
      runs.push({ command: recheck.command, exitCode: recheck.exitCode });
      options.onRun?.(recheck.command, recheck.exitCode);
      if (recheck.exitCode !== 0) {
        // Nothing changing: the same failure, taken the same way, round after round. Once, the explorer
        // is asked what the tests lack - most often how they reach the software; after that, it stops.
        const unmoved = async (): Promise<"asked" | "stuck" | undefined> => {
          const key = failureSignature(recheck);
          const seen = (seenFailures.get(key) ?? 0) + 1;
          seenFailures.set(key, seen);
          if (seen < STUCK_ROUNDS) return undefined;
          seenFailures.clear();
          if (reExplored) {
            stuck = { failure: truncateOutput(recheck.output, undefined).slice(-4000), rounds, error: failureLine(recheck), times: STUCK_ROUNDS };
            stage(`the same failure ${STUCK_ROUNDS} times again, after the explorer was asked - stopping`);
            recordNote(buildDir, "pitfalls", `stuck after ${rounds} attempts: failed with ${failureLine(recheck)} ${STUCK_ROUNDS} times, before and after the explorer was asked again`, `${label} conformance`);
            return "stuck";
          }
          reExplored = true;
          stage(`the same failure ${STUCK_ROUNDS} times - asking the explorer again what the tests lack`);
          invocation = await exploreInvocation({
            buildDir,
            spec: specContext,
            scope,
            testingScripts,
            question: { failure: shownOutput(buildDir, "conformance-stuck", recheck.output), account: invocation },
            acceptance: toCarryOut,
            label,
            model: options.model,
            onDelta: options.onDelta,
          });
          const asked = await changing(() => ask(
            executor,
            [
              `The conformance tests have failed the same way ${STUCK_ROUNDS} times, so the explorer was asked again what they`,
              "lack. This is its new account - it replaces the one you had. Read it, and the conformance testing script at",
              "the top of your prompt, for how the tests reach the software; then fix the tests accordingly.",
              "",
              `<how to invoke it>\n${invocation.trim()}\n</how to invoke it>`,
              "",
              ...buildManifests(buildDir).map((manifest) => `<code build file path="${manifest.path}">\n${manifest.content.trimEnd()}\n</code build file>\n`),
              "<failing run>",
              recheck.output.trimEnd().slice(-6000),
              "</failing run>",
            ].join("\n"),
            options.onDelta,
          ));
          response = asked.result;
          recordAttempt(rounds, recheck, `the same failure ${STUCK_ROUNDS} times - the explorer was asked again what the tests lack`, { who: "conformance agent", files: asked.files });
          return "asked";
        };
        // A toolchain missing, or a run out of time, is not a question of test or code: the tests'
        // environment is the conformance agent's.
        if (missingToolchain(recheck) !== undefined || recheck.timedOut === true) {
          const moved = await unmoved();
          if (moved === "stuck") break;
          if (moved === "asked") continue;
          stage("the conformance run did not get to the tests - back to the conformance agent");
          const fixed = await changing(() => askConformance(scriptFailure(recheck, "conformance testing"), options.onDelta));
          response = fixed.result;
          recordAttempt(rounds, recheck, `not a question of code or tests (${recheck.timedOut === true ? "the time limit" : `exit ${recheck.exitCode}`})`, { who: "conformance agent", files: fixed.files });
          continue;
        }
        stage(`conformance tests failing - working out whether the code, the tests or the spec are wrong${judgeModel ? ` (${judgeModel})` : ""}`);
        // A fix that changed no file leaves the next run as this one: IDLE_FIXES of them in a row, and nothing will change.
        const idle = (files: string[]): boolean => {
          idleFixes = files.length === 0 ? idleFixes + 1 : 0;
          if (idleFixes < IDLE_FIXES) return false;
          stuck = { failure: truncateOutput(recheck.output, undefined).slice(-4000), rounds, error: failureLine(recheck), times: idleFixes, changedNothing: true };
          stage(`${IDLE_FIXES} fixes in a row changed nothing - stopping`);
          recordNote(buildDir, "pitfalls", `stuck after ${rounds} attempts: failed with ${failureLine(recheck)}, and ${IDLE_FIXES} fixes in a row changed nothing`, `${label} conformance`);
          return true;
        };
        const verdict = await judgeFailure({
          buildDir,
          conformanceDir,
          spec: specContext,
          run: recheck,
          invocation,
          scope,
          notes: notesToRead(buildDir),
          label,
          model: judgeModel,
          onDelta: options.onDelta,
        });
        const reason = verdict.reason.split("\n")[0]!.slice(0, 160);
        // The environment - what the run is given - is the person's to fix: once judged so twice in a row, the run stops.
        if (verdict.culprit === "environment") {
          environmentRaises += 1;
          reportActivity(`  the environment (judged ${environmentRaises} of ${ENVIRONMENT_RAISES} in a row): ${reason}`);
          if (environmentRaises >= ENVIRONMENT_RAISES) {
            stage("the run's environment is what is wrong, and only the person can fix it - stopping");
            environment = { reason: verdict.reason, times: environmentRaises };
            recordNote(buildDir, "pitfalls", `the conformance run's environment is wrong, for the person to fix: ${verdict.reason.replace(/\s+/g, " ").slice(0, 300)}`, `${label} conformance`);
            break;
          }
          stage(`the run's environment is judged wrong (${environmentRaises} of ${ENVIRONMENT_RAISES}) - the conformance agent checks the tests do not cause it`);
          const fixed = await changing(() => askConformance(environmentCheckPrompt({ run: recheck, reason: verdict.reason }), options.onDelta));
          response = fixed.result;
          recordAttempt(rounds, recheck, `the environment: ${verdict.reason}`, { who: "conformance agent", files: fixed.files });
          continue;
        }
        environmentRaises = 0;
        // A spec conflict has counting of its own; code or tests the same way, again and again, is nothing changing.
        if (verdict.culprit !== "spec") {
          const moved = await unmoved();
          if (moved === "stuck") break;
          if (moved === "asked") continue;
        }
        if (verdict.culprit === "spec") {
          // Counted per pair of functionalities: it stops the run only when the same two are named often enough.
          const pair = sortedRefs(verdict.functionalities!);
          const key = conflictKey(pair);
          const said = [...(conflicts.get(key) ?? []), verdict.reason.trim()];
          conflicts.set(key, said);
          const raised = said.length;
          reportActivity(`  the spec, functionalities ${key} (raised ${raised} of ${SPEC_CONFLICT_RAISES}): ${reason}`);
          if (raised >= SPEC_CONFLICT_RAISES) {
            stage(`the spec contradicts itself: functionalities ${key} cannot both hold - stopping`);
            specConflict = { functionalities: pair, reason: verdict.reason };
            // For the person, whole: both functional specs as their modules have them, and every time it was raised.
            const ownSpecs = specifications[FUNCTIONAL_REQUIREMENTS];
            const files = plainFilesOf(options.plainFile, templateDirs);
            reportSpecConflict({
              moduleName,
              plainFile: options.plainFile,
              specs: pair.map((ref) => ({
                ...ref,
                plainFile: files.get(ref.module) ?? options.plainFile,
                text:
                  ref.module === moduleName
                    ? (ownSpecs[frids.indexOf(ref.frid)] ?? "")
                    : (required.find((spec) => spec.module === ref.module && spec.frid === ref.frid)?.spec ?? ""),
              })),
              reasons: said,
            });
            recordNote(buildDir, "pitfalls", `functionalities ${key} of the spec conflict: ${verdict.reason.replace(/\s+/g, " ").slice(0, 300)}`, `${label} conformance`);
            break;
          }
          // Recorded, and the round still changes something: the tests are looked at again, so the
          // next judgement is of a new run rather than the same one asked about again.
          stage(`a spec conflict between functionalities ${key} is recorded (${raised} of ${SPEC_CONFLICT_RAISES}) - the conformance agent looks at the tests again`);
          const fixed = await changing(() => ask(
            executor,
            testsFixPrompt({
              run: recheck,
              reason:
                `Functionalities ${key} of the specification may conflict: ${verdict.reason}\n\n` +
                "Before that is taken as the answer, check the tests of both against the specification once more: " +
                "that each asserts only what its functionality says, and sets up what it needs without undoing what the other relies on.",
            }),
            options.onDelta,
          ));
          response = fixed.result;
          recordAttempt(rounds, recheck, `a spec conflict between functionalities ${key}: ${verdict.reason}`, { who: "conformance agent", files: fixed.files });
        } else if (verdict.culprit === "code") {
          reportActivity(`  the code: ${reason}`);
          stage("the code is wrong - the coding agent fixes it");
          // One fixer for the run, starting each fix from what the ones before it tried: its work is compacted as it
          // grows, so a session carried through the run does not re-read every earlier fix and suite output whole.
          const fixed = await changing(() => askFixer(codeFixPrompt({ run: recheck, reason: verdict.reason })));
          recordAttempt(rounds, recheck, `the code wrong: ${verdict.reason}`, { who: "coding agent", files: fixed.files });
          if (idle(fixed.files)) break;
          // The fix has to build and pass its own unit tests before the suite runs again: a build
          // error is the coding agent's to fix, not a judge's to work out from the suite's output.
          for (let again = 0; again < FIX_UNIT_CHECKS; again += 1) {
            stage("checking the fix: the code's unit tests");
            const unit = await verifyUnitSuite(buildDir, unitRuns, scripts.unit!);
            if (unit.ok) break;
            stage("the fix does not build or pass its unit tests - back to the coding agent");
            await changing(() =>
              askFixer(`Your fix does not build or pass the code's unit tests - it has to before the conformance suite runs again.\n\n${unit.prompt}`),
            );
          }
        } else {
          reportActivity(`  the tests: ${reason}`);
          stage("the tests are wrong - the conformance agent fixes them");
          const fixed = await changing(() => askConformance(testsFixPrompt({ run: recheck, reason: verdict.reason }), options.onDelta));
          response = fixed.result;
          recordAttempt(rounds, recheck, `the tests wrong: ${verdict.reason}`, { who: "conformance agent", files: fixed.files });
          if (idle(fixed.files)) break;
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
        await askFixer(`The conformance tests pass, but the code's unit tests do not - and both have to.\n\n${unit.prompt}`);
        continue;
      }
      stage("unit tests pass too");
      // The review gate: passing tests prove nothing when they assert nothing, mock the software, or leave out
      // what the spec asks for. It has to pass, as the suite and the unit tests do.
      const testChanges = diffFiles(testsAtStart, digestFiles(conformanceDir));
      const changedTests = [...testChanges.added, ...testChanges.changed];
      // After the last review's problems were worked on, the tests go on once they pass: not reviewed again. With
      // the review off in the config, they go on once they pass from the first.
      if (reviewOn && changedTests.length > 0 && failedReviews < REVIEW_LIMIT) {
        stage(`optimising the tests (review ${failedReviews + 1} of at most ${REVIEW_LIMIT}): black box, and the acceptance tests doing what the spec says`);
        // One reviewer for the run, made the first time the tests are reviewed.
        reviewer ??= await createTestReviewer({
          ...(options.cases !== undefined ? { cases: options.cases } : {}),
          buildDir,
          conformanceDir,
          spec: specContext,
          functionalities: forChange ? touched : [{ frid: frid!, acceptanceTests: specifications[ACCEPTANCE_TESTS] ?? [] }],
          forChange,
          invocation,
          label,
          model: judgeModel,
          onDelta: options.onDelta,
        });
        const account = describeAccounts(work.take(), lastReview);
        const request =
          reviewSeen === undefined || lastReview === undefined
            ? testReviewRequest({ diff: workDiff(conformanceDir), changed: changedTests, account })
            : testReviewRequest({ diff: diffSinceSnapshot(conformanceDir, reviewSeen), changed: changedTests, account, earlier: lastReview, letGo: reviewLetGo });
        reviewSeen = workSnapshot(conformanceDir);
        reviewLetGo = [];
        const review = await reviewer.review(request);
        if (!review.pass) {
          failedReviews += 1;
          let problems = review.problems;
          const letGo = (why: string, waived: ReviewProblem[]) => {
            stage(why);
            reviewWaived = [...(reviewWaived ?? []), ...waived];
            lastReview = undefined;
            verified = true;
          };
          // After the first REVIEW_ROUNDS reviews that send them back, the arbiter weighs each: only what it upholds goes to the conformance agent.
          if (failedReviews > REVIEW_ROUNDS) {
            stage(`the review sent the tests back ${failedReviews === 1 ? "once" : `${failedReviews} times`} - the arbiter weighs what it found`);
            const ruling = await arbitrateReview({
              subject: `the conformance tests of ${forChange ? `the spec change in module \`${moduleName}\`` : `functionality ${frid} of module \`${moduleName}\``}`,
              workdir: conformanceDir,
              read: [conformanceDir, buildDir],
              uphold: [
                "- uphold it when because of it the functionality is not tested black box - a test or an acceptance test",
                "  the specification states missing, cut down or skipping what it checks, the software mocked or not reached",
                "  from outside, a test that cannot fail. Then the reviewer is right, and the conformance agent fixes it.",
              ],
              changed: changedTests,
              spec: `<specification>\n${specContext.text.trim()}\n</specification>`,
              problems: review.problems,
              history: reviewHistory,
              label: `${label} conformance`,
              ...(judgeModel !== undefined ? { model: judgeModel } : {}),
              ...(options.onDelta !== undefined ? { onDelta: options.onDelta } : {}),
            });
            // No ruling: the review stands.
            if (ruling !== undefined) {
              if (ruling.dismissed.length > 0) recordNote(buildDir, "pitfalls", dismissedNote(ruling, "conformance test"), `${label} conformance`);
              if (ruling.upheld.length === 0) {
                letGo("the arbiter approved the tests as they are - what the review still raised is let go, and in the notes", ruling.dismissed.map((entry) => entry.problem));
                break;
              }
              reviewWaived = [...(reviewWaived ?? []), ...ruling.dismissed.map((entry) => entry.problem)];
              stage(`the arbiter upheld ${ruling.upheld.length} of the review's ${review.problems.length} problem${review.problems.length === 1 ? "" : "s"} - the conformance agent fixes ${ruling.upheld.length === 1 ? "it" : "those"}`);
              problems = ruling.upheld.map((entry) => entry.problem);
              reviewLetGo = ruling.dismissed.map((entry) => entry.problem);
            }
          }
          // An optimiser, not a gate: what the last review sends back goes to the conformance agent once more, and the
          // tests go on once the suite and the unit tests pass - they are not reviewed again.
          if (failedReviews >= REVIEW_LIMIT) {
            recordNote(
              buildDir,
              "pitfalls",
              `the conformance tests went on after ${REVIEW_LIMIT} reviews, the last one's problems worked on but not reviewed again: ${problems.map((problem) => `${problem.file}${problem.test ? ` ${problem.test}` : ""}: ${problem.what.trim()}`).join("; ").slice(0, 600)}`,
              `${label} conformance`,
            );
            stage(`the last of ${REVIEW_LIMIT} reviews sends the tests back once more - after that they go on once they pass, without another review`);
          }
          reviewHistory.push(review.problems);
          lastReview = problems;
          const blocking = problems.filter((problem) => problem.blocking === true);
          reportActivity(`  the review found ${problems.length} problem${problems.length === 1 ? "" : "s"}: ${problems[0]!.what.slice(0, 140)}`);
          stage(
            blocking.length > 0
              ? `the review found the functionality not yet tested black box (${blocking.length} of ${problems.length} problem${problems.length === 1 ? "" : "s"}) - the conformance agent completes the tests`
              : `the review found ${problems.length} way${problems.length === 1 ? "" : "s"} to improve the tests - the conformance agent improves them`,
          );
          const pitfalls = readNotes(buildDir).pitfalls;
          const fixed = await changing(async () => {
            const answered = await askConformance(reviewFeedbackPrompt(problems), options.onDelta);
            // Every problem answered - fixed, or declined and why - so the reviewer knows what became of each: sent back once.
            const missing = unanswered(work.peek(), problems.length);
            return missing.length > 0 ? askConformance(unansweredPrompt(missing), options.onDelta) : answered;
          });
          // The lesson, left for the agents after it: the next functionality's conformance tests start from it.
          await reflectOnReview(buildDir, pitfalls, (prompt) => askConformance(prompt, options.onDelta));
          response = fixed.result;
          recordAttempt(
            rounds,
            "passed, but the review found " + problems.map((problem) => `${problem.kind} ${problem.file}: ${problem.what}`).join("; ").slice(0, 220),
            "the tests",
            { who: "conformance agent", files: fixed.files },
          );
          continue;
        }
        stage("the review has nothing left to improve in the tests");
      }
      lastReview = undefined;
      verified = true;
      break;
    }

    stage("checking the working notes were left");
    await notes.ensureWritten((next) => askConformance(next, options.onDelta));
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
      ...(specConflict !== undefined ? { specConflict } : {}),
      ...(stuck !== undefined ? { stuck } : {}),
      ...(environment !== undefined ? { environment } : {}),
      ...(unlabelled !== undefined ? { unlabelled } : {}),
      ...(reviewWaived !== undefined ? { reviewWaived } : {}),
      ...(!verified && lastReview !== undefined ? { review: lastReview } : {}),
    };
  } finally {
    executor.dispose();
    fixer?.dispose();
    reviewer?.dispose();
    await fixerServices.stopAll();
  }
}

/** Each module of the chain, by name, and its .plain file - for a conflict that crosses modules. */
function plainFilesOf(plainFile: string, templateDirs: string[]): Map<string, string> {
  try {
    return new Map(resolveRequiresChain(plainFile, templateDirs).map((entry) => [entry.moduleName, entry.plainFile]));
  } catch {
    return new Map();
  }
}

/**
 * The functionalities a spec change touches - its functional spec, or one of its acceptance tests,
 * has a line the change adds or removes - with their acceptance tests: what a spec diff's
 * conformance run labels, checks and reviews, as a functionality's run does for its one.
 */
export function touchedFunctionalities(tree: MarshalledPlainSource, frids: string[], diff: string): Array<{ frid: string; acceptanceTests: string[] }> {
  const bare = (line: string) => line.trim().replace(/^-\s+/, "").replace(/\s+/g, " ");
  const changed = new Set(
    diff
      .split("\n")
      .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line))
      .map((line) => bare(line.slice(1)))
      .filter((line) => line.length > 12),
  );
  return frids.flatMap((frid) => {
    const specifications = getSpecificationsForFrid(tree, frid)[0];
    const spec = specifications[FUNCTIONAL_REQUIREMENTS].at(-1) ?? "";
    const acceptanceTests = specifications[ACCEPTANCE_TESTS] ?? [];
    const lines = [spec, ...acceptanceTests].flatMap((text) => text.split("\n")).map(bare);
    return lines.some((line) => changed.has(line)) ? [{ frid, acceptanceTests }] : [];
  });
}

/** From the how-manieth review that sends the tests back the arbiter weighs each one (see arbiter.ts). */
export const REVIEW_ROUNDS = ARBITER_AFTER;

/** How many times the tests are sent back to be written and labelled before the run stops. */
export const LABEL_ASKS = 3;

/** How many times a code fix that does not build or pass its unit tests goes back to the coding agent before the suite runs again. */
export const FIX_UNIT_CHECKS = 3;

/** How many times an agent runs the conformance suite in a turn before its turn ends and the harness takes over. */
export const RUNS_PER_TURN = 3;

/**
 * A testing script tool an agent may call so many times a turn. The last allowed call ends its turn
 * with the result - the harness then runs the suite itself and judges what is wrong - so an agent
 * cannot spend its turn rerunning a failure it cannot fix. `newTurn` starts the count again.
 */
export function turnLimited(tool: ToolDefinition, limit: number): { tool: ToolDefinition; newTurn: () => void } {
  let calls = 0;
  const limited = {
    ...tool,
    execute: async (...args: Parameters<ToolDefinition["execute"]>) => {
      calls += 1;
      if (calls > limit) {
        return {
          content: [{ type: "text" as const, text: `Not run: that is ${limit} runs this turn. Your turn ends here - the harness runs the suite itself and works out what is wrong.` }],
          details: {},
          terminate: true,
        };
      }
      const result = (await tool.execute(...args)) as { content: Array<{ type: "text"; text: string }>; details?: unknown };
      if (calls < limit) return result;
      return {
        ...result,
        content: [...result.content, { type: "text" as const, text: `\n\nThat was your ${limit}rd run this turn: your turn ends here. The harness runs the suite itself, works out whether the code or the tests are wrong, and sends it to whichever it is.` }],
        terminate: true,
      };
    },
  } as ToolDefinition;
  return { tool: limited, newTurn: () => void (calls = 0) };
}

/** How many rounds running the same failure, taken the same way, is nothing changing. */
export const STUCK_ROUNDS = 3;

/** How many fixes in a row that change no file - the code's or the tests' - is nothing changing. */
export const IDLE_FIXES = 2;

/**
 * A failing run, as a fingerprint: the lines that say what went wrong, without what changes from run
 * to run - numbers, times, paths, ids. Two runs failing the same way have the same one.
 */
export function failureSignature(run: ScriptRun): string {
  if (run.timedOut === true) return "the run did not finish in the time limit";
  const lines = run.output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const telling = lines.filter((line) => /error|exception|fail|refused|timed out|cannot|unable|not found|denied/i.test(line));
  const normal = (line: string) =>
    line
      // Colour codes, and ids a service makes up for each response - a request's UUID, a correlation id in hex.
      .replace(/\x1B\[[0-9;]*m/g, "")
      .replace(/\/[^\s:'"]+/g, "<path>")
      .replace(/\b[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "<id>")
      .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{4,}\b/gi, "<id>")
      .replace(/\b[0-9a-f]{8,}\b/gi, "<id>")
      .replace(/\d+(\.\d+)?/g, "<n>")
      .replace(/\s+/g, " ");
  return [...new Set((telling.length > 0 ? telling : lines.slice(-20)).map(normal))].slice(0, 30).join("\n");
}

/** The build files a project's name, coordinates and version live in, by ecosystem. */
const BUILD_MANIFESTS = [
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "package.json",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "go.mod",
  "Cargo.toml",
  "composer.json",
  "Gemfile",
  "mix.exs",
];

/**
 * The code's own build files, at the top of its folder, as they are - read by the harness, for the
 * author of the conformance tests, who cannot read the code. They are interface, not implementation:
 * what a separate test project has to point at - the name, the coordinates, the version.
 */
export function buildManifests(buildDir: string): Array<{ path: string; content: string }> {
  return BUILD_MANIFESTS.filter((name) => existsSync(join(buildDir, name))).map((name) => {
    const content = readFileSync(join(buildDir, name), "utf8");
    return { path: name, content: content.length > 20_000 ? `${content.slice(0, 20_000)}\n… [${content.length - 20_000} more characters]` : content };
  });
}

/** What a failing run failed with, in one line as it said it: its first line that says what went wrong. */
export function failureLine(run: ScriptRun): string {
  if (run.timedOut === true) return "the time limit - the run did not finish";
  const lines = run.output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  // The error itself - `AssertionError: …`, `ConnectException: …` - says more than a summary line: up to two, each once.
  const errors = [...new Set(lines.filter((line) => /\w(Error|Exception)\b[^\n]*:/.test(line)))];
  const telling = errors.length > 0 ? errors : lines.filter((line) => /error|exception|fail|refused|cannot|unable|not found|denied/i.test(line));
  const picked = telling.length > 0 ? telling.slice(0, 2) : [lines.at(-1) ?? `exit ${run.exitCode}`];
  return picked.map((line) => `"${line.length > 160 ? `${line.slice(0, 159)}…` : line}"`).join(" and ");
}

/**
 * The spec as the explorer, the judge and the coding agent are shown it - its functional specs
 * numbered with their ids, so a spec conflict can name them.
 */
function specText(specifications: Specifications, moduleName: string, frids: string[], required: RequiredSpec[], diff?: string): string {
  // Every functionality in the codebase, each with its module: the required modules' first, then this one's.
  const numbered = (key: string, items: string[]) =>
    key === FUNCTIONAL_REQUIREMENTS
      ? [
          functionalitiesByModule(
            [...required, ...items.map((item, index) => ({ module: moduleName, frid: frids[index] ?? String(index + 1), spec: item }))],
            moduleName,
          ),
        ]
      : items;
  // Each section in its tag, as every agent is shown it (see specPrimer).
  const sections = [DEFINITIONS, NON_FUNCTIONAL_REQUIREMENTS, TEST_REQUIREMENTS, FUNCTIONAL_REQUIREMENTS, ACCEPTANCE_TESTS]
    .map((key) => [key, (specifications as unknown as Record<string, string[] | undefined>)[key] ?? []] as const)
    .filter(([, items]) => items.length > 0)
    .map(([key, items]) => section(key, numbered(key, items))!);
  if (diff !== undefined) sections.push(specChangeBlock(diff));
  return sections.join("\n\n");
}

/**
 * The functional spec a conformance run writes tests for, for the person watching: which one of how
 * many, and its text as the spec has it, with its acceptance tests after it.
 */
export function buildingSpec(
  moduleName: string,
  frid: string,
  total: number,
  specifications: { "functional specs": string[]; [ACCEPTANCE_TESTS]?: string[] },
): BuildingSpec {
  const acceptance = specifications[ACCEPTANCE_TESTS] ?? [];
  return {
    label: `${moduleName} functionality ${frid} of ${total}`,
    text: [(specifications["functional specs"].at(-1) ?? "").trim(), ...(acceptance.length > 0 ? ["", "acceptance tests:", ...acceptance.map((test) => test.trim())] : [])].join("\n"),
  };
}
