import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { IMPORT_DIRECTIVE, plainFileParser, readPlainSourceMetadata, withParseCache } from "../plain/parser.ts";
import {
  FUNCTIONAL_REQUIREMENTS,
  getFrids,
  getInheritedFunctionalSpecs,
  getSpecificationsForFrid,
  TEST_REQUIREMENTS,
  type MarshalledPlainSource,
  type Specifications,
} from "../plain/spec.ts";
import { ask, BEGIN, createExecutor, refuseIfModelIsBlind } from "../pi.ts";
import { warmVm } from "./vm.ts";
import { reportActivity, reportStage, unitOf } from "./activity.ts";
import { codebaseMap, diffFiles, digestFiles, wroteNothing } from "./codebase.ts";
import { confinedTools } from "./confine.ts";
import { buildSpecDiffPrompt, describeSpecChange, reviewedSpec } from "./prompt.ts";
import { abandonWork, recordHistory, startWork } from "./lineage.ts";
import { createWorkLedger, SUBMIT_WORK_NOTE } from "./submit-work.ts";
import type { JobCases } from "./drift.ts";
import { CODER_COMPACTION } from "./compaction.ts";
import { notesForSession, withNotes } from "./notes.ts";
import {
  createScriptTool,
  findStaticChecks,
  findTestScripts,
  projectRootFor,
  requireTestScripts,
  runUnitScript,
  withoutConformance,
  withTestingScripts,
} from "./test-scripts.ts";
import { createWebTools, WEB_TOOLS } from "./web.ts";
import { createCanItFailTool, createMyDiffTool, createStaticChecksTool, selfCheckNote } from "./self-check.ts";
import { createServiceTools } from "./services.ts";
import { ATTEMPTS, describeStop } from "./stop-report.ts";
import { summarizeDiff } from "./job-panel.ts";
import { resolveTemplateDirs } from "./paths.ts";
import { type ChainEntry, copyRequiredCode, findCodebaseTip, newlyRequired } from "./requires.ts";
import { loadLinkedResources, resourceImages } from "./resources.ts";
import { markTold, waitingSteer, type JobSteering } from "./steering.ts";
import { misplacedConformanceTests, misplacedTestsPrompt } from "./test-kinds.ts";
import { sectionsOf } from "./state.ts";
import { inheritedRecord, readRecord, withResourceDigests, writeCodeRecord } from "./records.ts";
import { changesBetween, sameSpec, serializeTree } from "./spec-steps.ts";
import { untilUnitTestsReviewed } from "./unit-review.ts";
import { configForSpec, inheritModel, modelSpec, splitModelSpec } from "../config.ts";
import {
  findTestRemovals,
  inventoryTests,
  listFiles,
  removalChallengePrompt,
  type TestRemoval,
  type TestRun,
  verifyUnitSuite,
  draftPrompt,
  DRAFT_ASKS,
  type MissingToolchain,
} from "./testing.ts";

/**
 * Render a change to the specs, given as a git diff of the .plain files.
 *
 * The change is whatever the person made - specs added, changed or removed, in any section,
 * across any number of them - and it is rendered the way a developer would take a spec
 * change: one agent, given the diff and every spec it touches as it now stands, makes the
 * code match. Starting from nothing is the same operation, with a diff that adds everything.
 *
 * It is given two things: the diff, and the whole spec as parsed right after the diff went in.
 * The render works from that parse and the build record is written from it - every section,
 * not only the functional specs - because that is what the codebase holds once the change is
 * built. A change rendered from a queue runs after later ones have gone into the files, so
 * the files are not what it is about; the parse taken with the diff is.
 *
 * After it, the order that makes the result trustworthy: the conformance tests are brought
 * in line with the change, the whole suite runs with repairs, and the build record is
 * rewritten.
 */

const MAX_FOLLOW_UPS = ATTEMPTS["unit tests"];


/**
 * Bring the .plain files to the state the diff describes, with git. A diff that is already
 * applied is fine - the person may have made the edit themselves and sent its diff - but
 * one that fits neither way is refused: rendering it would mean guessing.
 */
export function applySpecDiff(diff: string, cwd: string): "applied" | "already applied" {
  const dir = mkdtempSync(join(tmpdir(), "turri-diff-"));
  const patch = join(dir, "spec.diff");
  writeFileSync(patch, diff.endsWith("\n") ? diff : `${diff}\n`);
  // --recount: a diff written by hand, or by a model, rarely has its hunk line counts right,
  // and they carry no information the hunk itself does not.
  const git = (...args: string[]) => spawnSync("git", ["apply", "--recount", ...args, patch], { cwd, encoding: "utf8" });
  try {
    const forward = git("--check");
    if (forward.status === 0) {
      const applied = git();
      if (applied.status !== 0) throw new Error(`git apply failed: ${applied.stderr.trim()}`);
      return "applied";
    }
    if (git("--reverse", "--check").status === 0) return "already applied";
    throw new Error(
      `The spec diff does not apply to the .plain files here, and is not already applied: ${forward.stderr.trim()}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Undo a spec diff this process applied, when what it produced cannot be used. */
export function revertSpecDiff(diff: string, cwd: string): void {
  const dir = mkdtempSync(join(tmpdir(), "turri-diff-"));
  const patch = join(dir, "spec.diff");
  writeFileSync(patch, diff.endsWith("\n") ? diff : `${diff}\n`);
  try {
    spawnSync("git", ["apply", "--recount", "--reverse", patch], { cwd, encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The .plain files a diff writes to, relative to where it applies. */
export function plainFilesOf(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split("\n")) {
    const match = /^\+\+\+ (?:b\/)?(.+\.plain)\s*$/.exec(line);
    if (match) files.add(match[1]!);
  }
  return [...files];
}

/** A module's .plain file and every one it imports, transitively - the files its spec is read from. */
export function specFilesOf(plainFile: string, templateDirs: string[] = []): string[] {
  const dirs = resolveTemplateDirs(resolve(plainFile), templateDirs);
  const files: string[] = [];
  const visit = (path: string) => {
    if (files.includes(path) || !existsSync(path)) return;
    files.push(path);
    const imports = (readPlainSourceMetadata(readFileSync(path, "utf8")).metadata[IMPORT_DIRECTIVE] as string[] | undefined) ?? [];
    for (const name of imports) {
      const found = [dirname(path), ...dirs].map((dir) => join(dir, `${name}.plain`)).find((candidate) => existsSync(candidate));
      if (found !== undefined) visit(resolve(found));
    }
  };
  visit(resolve(plainFile));
  return files;
}

/** A git diff cut into what it does to each file, in order: the file's path (the new side's), and its part of the diff. */
export function diffByFile(diff: string): Array<{ file: string; diff: string }> {
  const lines = diff.split("\n");
  const starts: number[] = [];
  const headed = lines.some((line) => line.startsWith("diff --git "));
  lines.forEach((line, index) => {
    if (headed ? line.startsWith("diff --git ") : line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) starts.push(index);
  });
  return starts.map((start, index) => {
    const part = lines.slice(start, starts[index + 1] ?? lines.length);
    const target = part.map((line) => /^\+\+\+ (?:b\/)?(.+?)\s*$/.exec(line)?.[1]).find((path) => path !== undefined && path !== "/dev/null");
    const source = part.map((line) => /^--- (?:a\/)?(.+?)\s*$/.exec(line)?.[1]).find((path) => path !== undefined && path !== "/dev/null");
    const text = part.join("\n");
    return { file: target ?? source ?? "", diff: text.endsWith("\n") ? text : `${text}\n` };
  });
}

/**
 * The spec as it stands with a change in: the codebase the change is rendered in, and that
 * module parsed - its sections, the functional specs it inherits and its own.
 */
export interface SpecSnapshot {
  moduleName: string;
  plainFile: string;
  tree: MarshalledPlainSource;
  /** The codebase's requires chain, bottom first; the last entry is the codebase itself. */
  chain: ChainEntry[];
}

/** Parse the spec as it stands now, for a change to `plainFile`'s module. */
export function snapshotSpec(
  plainFile: string,
  options: { cwd?: string; templateDirs?: string[]; inModule?: string } = {},
): SpecSnapshot {
  const cwd = resolve(options.cwd ?? process.cwd());
  const templateDirs = options.templateDirs ?? [];
  // The change lands in the chain's current codebase. A spec change is built whatever it
  // touches - a definition, a req, a functional spec - so a module with no functional specs
  // yet is still a module to build.
  const { tip, chain } = withParseCache(() =>
    findCodebaseTip(resolve(cwd, plainFile), { templateDirs, inModule: options.inModule, allowNoFunctionalities: true }),
  );
  const dirs = resolveTemplateDirs(tip.plainFile, templateDirs);
  const [moduleName, parsed] = plainFileParser(basename(tip.plainFile), dirs, { allowNoFunctionalities: true });
  // What a linked resource holds is part of the spec: hashed beside its link, as the work loop has it.
  return { moduleName, plainFile: tip.plainFile, tree: withResourceDigests(parsed, dirs), chain };
}

export interface RenderSpecDiffOptions {
  /** A .plain file of the module the change is rendered for. */
  plainFile: string;
  /** The change, as a git diff of the .plain files. */
  diff: string;
  /** Where the diff's paths are relative to. Default: the working directory. */
  cwd?: string;
  templateDirs?: string[];
  /** The codebase to render in, when modules built on this one branch. */
  inModule?: string;
  /**
   * The diff was already put in when it was written - how that went - and is not to be applied
   * again. A render queued behind the interview runs after later changes have gone on top of
   * it, so its diff no longer fits the file either way - but it is in, and that is what matters.
   */
  applied?: "applied" | "already applied";
  /** The spec as parsed with the diff in. Taken now, after applying it, when not given. */
  spec?: SpecSnapshot;
  model?: string;
  /** Review the code and unit tests once they pass - that they do what the change says. Default: the config's `review:`, else true. */
  unitReview?: boolean;
  /** What the job does to each functional spec (work.ts): its agents are told case by case. Not given: in general. */
  cases?: JobCases;
  /** Build the coding agent's task and stop there: nothing is started, and what the render did is rolled back. */
  dryRun?: boolean;
  /** The unit test review's model. Default: the project's judge-model, else `model`. */
  judgeModel?: string;
  onDelta?: (delta: string) => void;
  /** The loop's: steers the coding agent when the spec changes inside what it grows, and holds the record it lands. */
  steering?: JobSteering;
}

export interface RenderSpecDiffResult {
  /** The codebase the change was rendered in. */
  moduleName: string;
  buildDir: string;
  diff: "applied" | "already applied";
  response: string;
  runs: TestRun[];
  /** How many times the harness ran the unit testing script on it: the attempts it judged. */
  attempts: number;
  testRemovals: TestRemoval[];
  files: { added: string[]; changed: string[]; removed: string[] };
  passed: boolean;
  stoppedAt: "unit tests" | null;
  /** Stopped because the unit testing script cannot run: what it needs is not installed where it runs. */
  missingToolchain?: MissingToolchain;
  /** What the spec changed while it grew that its agent was told - a line each. */
  steered?: string[];
  /** The specs were only restructured: nothing was rendered, the spec as now laid out was recorded. */
  restructured?: boolean;
  /** A dry run: the task the coding agent would be given. */
  task?: string;
}

export async function renderSpecDiff(options: RenderSpecDiffOptions): Promise<RenderSpecDiffResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const templateDirs = options.templateDirs ?? [];
  const applied = options.applied ?? applySpecDiff(options.diff, cwd);
  const spec = options.spec ?? snapshotSpec(options.plainFile, { cwd, templateDirs, inModule: options.inModule });
  const { moduleName, tree, chain } = spec;
  const tip = chain.at(-1)!;
  const stage = (label: string) => reportStage(`${unitOf(moduleName)}: ${label}`);
  // A module required now that the code was not built on is not something a change to the code can
  // bring in: the code has to start again, on that module's.
  const fresh = newlyRequired(chain);
  if (fresh !== undefined) {
    throw new Error(
      `${tip.moduleName} now requires ${fresh.modules.join(", ")}, which its code was not built on, so a spec diff cannot bring the change in. ` +
        `Its code has to be started over on it - ${fresh.rebuild.map((entry) => entry.moduleName).join(", ")} taken out, kept in the history, and built ` +
        `again from the bottom of the chain: rejuvenate in the chat, once the user agrees, or turri regrow ${relative(cwd, tip.plainFile)} --rejuvenate.`,
    );
  }
  stage(`the spec diff is ${applied === "applied" ? "applied to the .plain files" : "already in the .plain files"} - rendering it in ${moduleName}'s codebase`);
  // The change is made to the codebase's last known good state, not to what an interrupted
  // run left half-written.
  // A dry run only reads: another job may be at work in the codebase.
  const dryRun = options.dryRun === true;
  if (!dryRun) stage("starting from the codebase's last commit");
  // The change is one unit - its code and its unit tests - landed whole, with the spec it was built from, or
  // undone whole. Its conformance tests are a job of their own, after it (docs/growing.md).
  const unit = dryRun ? undefined : startWork([tip.buildDir], moduleName);
  // Only laid out differently - definitions moved to a common module, specs moved between modules
  // of the chain: the code already is what the spec says. Nothing to render; the spec is recorded
  // as it is now laid out.
  const builtBefore = readRecord(tip.buildDir, { onDisk: true });
  if (builtBefore !== null && sameSpec(builtBefore, tree) && !dryRun) {
    stage("the specs were only restructured - nothing to render; recording the spec as it is now laid out");
    writeCodeRecord(tip.buildDir, tree);
    recordHistory(tip.buildDir, `spec restructured: ${summarizeDiff(options.diff)}`, options.diff);
    return {
      moduleName,
      buildDir: tip.buildDir,
      diff: applied,
      response: "The specs were only restructured: the code is already built from the same spec, so nothing was rendered.",
      runs: [],
      attempts: 0,
      testRemovals: [],
      files: { added: [], changed: [], removed: [] },
      passed: true,
      stoppedAt: null,
      restructured: true,
    };
  }
  // Whether the change is done is the project's testing scripts: without them, nothing is built.
  stage("finding the project's testing scripts");
  const root = projectRootFor(tip.plainFile, tip.buildDir);
  // The code is judged by its unit tests alone: the conformance testing script is the conformance job's.
  const scripts = withoutConformance(findTestScripts(root, tip.plainFile, tip.buildDir));
  requireTestScripts(moduleName, scripts, { conformance: false });
  reportActivity(`  unit testing script: ${relative(root, scripts.unit)}`);
  const lastFrid = [...getFrids(tree)].at(-1);
  const buildDir = tip.buildDir;
  // From scratch there is no build directory yet, and everything the agent runs runs in it.
  if (!dryRun) mkdirSync(buildDir, { recursive: true });
  const empty = listFiles(buildDir).length === 0;
  const source = empty && tip.requires !== null ? chain.find((entry) => entry.moduleName === tip.requires) : undefined;
  if (source !== undefined && !dryRun) {
    stage(`no code here yet - starting from ${source.moduleName}'s code`);
    copyRequiredCode(source.buildDir, buildDir, moduleName, source.moduleName);
  }
  // What the agent is shown it starts from: a dry run copies nothing, and reads the code it would start from where it is.
  const seen = dryRun && source !== undefined ? source.buildDir : buildDir;

  stage("mapping the codebase and writing the prompt");
  // The agent is given the spec the code is built from - the state before the change - and the change: the spec
  // before it, plus the diff, is the spec after it. Read from the codebase as it is now, code copied up from a
  // required module included; with nothing built, there is no spec before, and the change is all of it.
  const builtNow =
    (seen === buildDir ? readRecord(buildDir, { onDisk: true }) : (() => {
      const below = readRecord(seen);
      return below !== null ? inheritedRecord(below, source!.moduleName) : null;
    })()) ?? {};
  // The change as it is to the code - from what it is built from to the spec this job records - section by section:
  // what every agent of this change is shown, in place of the raw diff.
  const changes = changesBetween(serializeTree(builtNow), serializeTree(tree));
  const changeText = changes.length > 0 ? describeSpecChange(changes) : undefined;
  // The coding agent's view of the change leaves its test reqs out: they say how the conformance tests are written -
  // the conformance job's to read, from the whole change (`changeText`), not the code's.
  const codingChanges = changes.filter((change) => change.section !== TEST_REQUIREMENTS);
  const codingText = codingChanges.length > 0 ? describeSpecChange(codingChanges) : undefined;
  /** Steered, the change as its agent has it now: from what the code is built from to what it was steered to. */
  const steeredChange = (): string | undefined => {
    if (options.steering === undefined || options.steering.steers === 0) return undefined;
    const now = changesBetween(serializeTree(builtNow), serializeTree(options.steering.agent)).filter((change) => change.section !== TEST_REQUIREMENTS);
    return now.length > 0 ? describeSpecChange(now) : undefined;
  };
  const builtFrids = [...getFrids(builtNow)];
  const specificationsBefore: Specifications =
    builtFrids.length > 0 ? getSpecificationsForFrid(builtNow, builtFrids.at(-1)!)[0] : { ...sectionsOf(builtNow), [FUNCTIONAL_REQUIREMENTS]: [] };
  const linkedResources = loadLinkedResources(tree, lastFrid ?? null, resolveTemplateDirs(tip.plainFile, templateDirs));
  const prompt = buildSpecDiffPrompt({
    moduleName,
    diff: options.diff,
    // The change as it is to the code: from what it is built from to the spec this job records, section by section.
    changes: codingChanges,
    specifications: specificationsBefore,
    required: getInheritedFunctionalSpecs(builtNow),
    linkedResources,
    codebase: codebaseMap(seen),
    empty: listFiles(seen).length === 0,
    ...(options.cases !== undefined ? { cases: options.cases } : {}),
  });

  const digestsBefore = digestFiles(buildDir);
  const runs: TestRun[] = [];
  const fence = confinedTools({ workdir: buildDir });
  const notes = notesForSession(buildDir, `${moduleName} spec change`);
  // What it hands over at the end of a turn, for its reviewer.
  const work = createWorkLedger();
  // What it checks its own work with: the diff its reviewer is shown, the static checks when the project has them,
  // and whether a test catches a bug - none of them decides anything.
  const staticChecks = findStaticChecks(root, tip.plainFile, buildDir);
  const selfChecks = [
    createMyDiffTool({ dir: buildDir, what: "code" }),
    ...(staticChecks !== undefined ? [createStaticChecksTool({ buildDir, script: staticChecks })] : []),
    ...(scripts.runTestingScriptsIn !== "host" ? [createCanItFailTool({ buildDir, script: scripts.unit! })] : []),
  ];
  // A server it built, it can start and try from outside - stopped when it is done.
  const services = createServiceTools({ dir: buildDir });
  // The script its work is judged by.
  const task = [withNotes(withTestingScripts(prompt, scripts, ["unit"], root), buildDir), "", ...selfCheckNote([...selfChecks.map((tool) => tool.name), "start_service"]), ...SUBMIT_WORK_NOTE].join("\n");
  if (dryRun) {
    return { moduleName, buildDir, diff: applied, response: "", runs: [], attempts: 0, testRemovals: [], files: { added: [], changed: [], removed: [] }, passed: false, stoppedAt: null, task };
  }
  // The spec's images need a model that reads them: refused before the agent starts.
  await refuseIfModelIsBlind(options.model, resourceImages(linkedResources).length);
  // Its shell's VM boots while it reads and writes: ready by its first command.
  warmVm(buildDir);
  stage(`starting the coding agent${options.model ? ` (${options.model})` : ""}`);
  // One session for the whole change: its task is its instructions, its work compacted as it grows.
  const executor = await createExecutor({
    cwd: buildDir,
    customTools: [
      notes.tool,
      work.tool,
      ...createWebTools(),
      createScriptTool({ kind: "unit", script: scripts.unit, run: () => runUnitScript(buildDir, scripts.unit!), runs }),
      ...selfChecks,
      ...services.tools,
      ...fence.tools,
    ],
    tools: [...fence.names, "run_unit_tests", ...selfChecks.map((tool) => tool.name), ...services.names, "update_notes", "submit_work", ...WEB_TOOLS],
    model: options.model,
    label: `${moduleName} spec change coding agent`,
    system: fence.note,
    task,
    compaction: { instructions: CODER_COMPACTION },
    images: resourceImages(linkedResources),
  });

  let response: string;
  let verified = false;
  let unitReviewStopped = false;
  let followUp = 0;
  /** The harness's runs of the unit testing script: each is an attempt it judged. */
  let attempts = 0;
  /** How many times the agent, having written nothing, was asked for a draft. */
  let draftAsks = 0;
  /** What the unit testing script needs and does not find, last run. */
  let missing: MissingToolchain | undefined;
  const testRemovals: TestRemoval[] = [];
  const steering = options.steering;
  // The loop reaches the agent in its turn while there is one; between turns a steer waits for the next.
  if (steering !== undefined) {
    steering.deliver = (text) => {
      if (!executor.isStreaming) return false;
      void Promise.resolve(executor.steer(text)).catch(() => undefined);
      stage("the spec changed inside what it grows - the coding agent is told, in its turn");
      return true;
    };
  }
  /** A steer the agent has not had yet, given as its next turn: true when there was one. */
  const steerIfWaiting = async (): Promise<boolean> => {
    const text = steering !== undefined ? waitingSteer(steering) : undefined;
    if (text === undefined) return false;
    markTold(steering!);
    stage("the spec changed inside what it grows - the coding agent is told");
    response = await ask(executor, text, options.onDelta);
    return true;
  };
  try {
    stage("turri is implementing the spec change");
    let inventory = inventoryTests(buildDir);
    response = await ask(executor, BEGIN, options.onDelta);
    // Back and forth until the harness's run of the unit testing script passes - whatever the
    // agent ran, and whether it ran anything - or the rounds run out. Picks up where it left off
    // when called again.
    const untilPassing = async (): Promise<boolean> => {
      for (; followUp < MAX_FOLLOW_UPS; followUp += 1) {
        // A steer that came between its turns: its own turn, then the tests run again.
        if (await steerIfWaiting()) continue;
        const current = inventoryTests(buildDir);
        const removals = findTestRemovals(inventory, current);
        if (removals.length > 0) {
          // A removed spec takes its tests with it; the agent says which and why, as always.
          testRemovals.push(...removals);
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
        // Nothing written - a turn spent planning - leaves nothing to test or review: ask for a best-guess draft, or why none.
        if (draftAsks < DRAFT_ASKS && wroteNothing(buildDir, digestsBefore)) {
          draftAsks += 1;
          stage("the coding agent has changed nothing yet - asking for a best-guess draft, or why the change needs no code");
          response = await ask(executor, draftPrompt(), options.onDelta);
          continue;
        }

        stage(`running the unit testing script (attempt ${attempts + 1})`);
        attempts += 1;
        const verdict = await verifyUnitSuite(buildDir, runs, scripts.unit);
        if (verdict.ok) stage(`unit tests pass (attempt ${attempts})`);
        // A toolchain the script cannot find is no failure of the code, and the agents install nothing: the person sets it
        // up - on this machine, or in the VM's image - so the job stops now and asks them.
        missing = verdict.ok ? undefined : verdict.missing;
        if (missing !== undefined) {
          stage(`the unit testing script cannot run: ${missing.command ?? "a toolchain it needs"} is not installed ${missing.where === "host" ? "on this machine" : "in the VM"} - stopping`);
          return false;
        }
        if (!verdict.ok) {
          stage(`unit tests not passing - fixing (round ${followUp + 1} of ${MAX_FOLLOW_UPS})`);
          response = await ask(executor, verdict.prompt, options.onDelta);
          continue;
        }
        // Passing on what it was told before - a steer since, and they run again.
        if (await steerIfWaiting()) continue;
        return true;
      }
      return false;
    };
    verified = await untilPassing();

    // The unit tests pass - now whether they test what the change says, so they fail when it breaks.
    if (verified && (options.unitReview ?? configForSpec(tip.plainFile).review) !== false) {
      const reviewed = await untilUnitTestsReviewed({
        buildDir,
        atStart: digestsBefore,
        what: `the spec change to module \`${moduleName}\``,
        // As the coding agent had it: the spec the code was built from, and the change.
        // Steered before the review, the change as the agent has it now.
        spec: reviewedSpec({ moduleName, specifications: specificationsBefore, required: getInheritedFunctionalSpecs(builtNow), change: steeredChange() ?? codingText ?? changeText ?? options.diff }),
        forChange: true,
        ...(options.cases !== undefined ? { cases: options.cases } : {}),
        label: `${moduleName} spec change`,
        ...(scripts.runTestingScriptsIn !== "host" ? { unitScript: scripts.unit! } : {}),
        model: options.judgeModel ?? modelSpec(inheritModel(configForSpec(tip.plainFile).judgeModel, splitModelSpec(options.model))),
        send: async (next) => {
          response = await ask(executor, next, options.onDelta);
        },
        untilPassing,
        stage,
        onDelta: options.onDelta,
        work,
      });
      stage(`the review took ${reviewed.reviews} review${reviewed.reviews === 1 ? "" : "s"}`);
      verified = reviewed.passed;
      if (!reviewed.passed) unitReviewStopped = true;
    }
    // A steer that came during the review: the agent's turn, and the tests until they pass - within its rounds.
    while (verified && steering !== undefined && waitingSteer(steering) !== undefined) verified = await untilPassing();

    stage("checking the working notes were left");
    await notes.ensureWritten((next) => ask(executor, next, options.onDelta));
  } finally {
    if (steering !== undefined) steering.deliver = undefined;
    executor.dispose();
    await services.stopAll();
  }

  // Passing means the harness's own run of the unit testing script passed, last.
  const unitPassed = verified;
  const files = diffFiles(digestsBefore, digestFiles(buildDir));
  const base = {
    moduleName,
    buildDir,
    diff: applied,
    response,
    runs,
    attempts,
    testRemovals,
    files,
    ...(steering !== undefined && steering.steers > 0 ? { steered: [...steering.notes] } : {}),
  };

  /** The change landed: what the code is built from is now the spec with the change in, committed with it. */
  const land = () => {
    stage("recording what the code is built from, and committing it");
    // Steered, it is built from the spec as it was steered to - the record the loop moved with it.
    writeCodeRecord(buildDir, steering?.target ?? tree);
    recordHistory(buildDir, `spec diff: ${summarizeDiff(options.diff)}`, options.diff);
  };

  if (!unitPassed) {
    stage(unitReviewStopped ? "the unit tests pass but still leave the change untested - undoing the change" : "unit tests NOT passing - undoing the change");
    abandonWork(unit, moduleName, missing !== undefined ? "the unit testing script could not run" : "the spec change did not pass its unit tests");
    return { ...base, passed: false, stoppedAt: "unit tests", ...(missing !== undefined ? { missingToolchain: missing } : {}) };
  }

  stage("unit tests pass - landing the change on them");
  land();
  return { ...base, passed: true, stoppedAt: null };
}

/** What a rendered spec change did, for the agent and the person. */
export function describeSpecDiff(result: RenderSpecDiffResult): string {
  const { added, changed, removed } = result.files;
  if (result.restructured === true) {
    return `The specs were only restructured: ${result.moduleName}'s code (${result.buildDir}) is already built from the same spec, so nothing was rendered - the spec is recorded as it is now laid out.`;
  }
  return [
    result.passed
      ? `Rendered the spec change in ${result.moduleName}'s codebase (${result.buildDir}).`
      : describeStop({
          moduleName: result.moduleName,
          at: result.stoppedAt!,
          runs: result.runs,
          attempts: result.attempts,
          ...(result.missingToolchain !== undefined ? { missingToolchain: result.missingToolchain } : {}),
        }),
    result.diff === "applied" ? "The diff was applied to the .plain files." : "The diff was already applied.",
    `Files: ${added.length} added, ${changed.length} changed, ${removed.length} removed.`,
    result.testRemovals.length > 0 ? `Unit tests removed and justified: ${result.testRemovals.map((r) => r.file).join(", ")}.` : "",
    ...(result.steered !== undefined ? [`Steered while it grew - the spec changed inside what it was growing, and its agent was told: ${result.steered.join("; ")}.`] : []),
    "",
    "<agent report>",
    result.response,
    "</agent report>",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
