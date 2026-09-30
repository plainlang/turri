import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { IMPORT_DIRECTIVE, plainFileParser, readPlainSourceMetadata, withParseCache } from "../plain/parser.ts";
import {
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
import { ask, createExecutor } from "../pi.ts";
import { reportActivity, reportStage, unitOf } from "./activity.ts";
import { codebaseMap, diffFiles, digestFiles, wroteNothing } from "./codebase.ts";
import { confinedTools } from "./confine.ts";
import { conformanceDirFor, renderConformanceTests, type RenderConformanceTestsResult } from "./conformance.ts";
import { ensureRegressionPasses, type RegressionResult } from "./module.ts";
import { modulesRoot, projectDirOf } from "./paths.ts";
import { buildSpecDiffPrompt, describeSpecChange, reviewedSpec } from "./prompt.ts";
import { abandonWork, recordHistory, startWork } from "./history.ts";
import { notesForSession, withNotes } from "./notes.ts";
import {
  createScriptTool,
  findTestScripts,
  projectRootFor,
  requireTestScripts,
  runUnitScript,
  withoutConformance,
  withTestingScripts,
} from "./test-scripts.ts";
import { createWebTools, WEB_TOOLS } from "./web.ts";
import { ATTEMPTS, describeStop } from "./stop-report.ts";
import { summarizeDiff } from "./job-panel.ts";
import { resolveTemplateDirs } from "./render.ts";
import { type ChainEntry, copyRequiredCode, findCodebaseTip, newlyRequired } from "./requires.ts";
import { loadLinkedResources } from "./resources.ts";
import { misplacedConformanceTests, misplacedTestsPrompt } from "./test-kinds.ts";
import { readBuiltTree, sectionsOf, writeBuiltTree } from "./state.ts";
import { changesBetween, sameSpec, serializeTree } from "./spec-steps.ts";
import { untilUnitTestsReviewed } from "./unit-review.ts";
import { configForSpec, inheritModel, modelSpec, splitModelSpec } from "../config.ts";
import {
  findTestRemovals,
  inventoryTests,
  listFiles,
  removalChallengePrompt,
  runCommand,
  type TestRemoval,
  type TestRun,
  verifyUnitSuite,
  draftPrompt,
  DRAFT_ASKS,
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
  const dir = mkdtempSync(join(tmpdir(), "plainwright-diff-"));
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
  const dir = mkdtempSync(join(tmpdir(), "plainwright-diff-"));
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

/**
 * The whole spec of a module as one change: every .plain file it is built from - its own and the
 * ones it imports, in the project - added from nothing. What a build that starts from nothing is
 * given, so it is told everything it builds, not only the last thing written.
 */
export function wholeSpecDiff(plainFile: string, cwd: string, templateDirs: string[] = [], except: string[] = []): string {
  const root = resolve(cwd);
  const skip = new Set(except.map((path) => resolve(root, path)));
  return specFilesOf(resolve(root, plainFile), templateDirs)
    .filter((path) => !relative(root, path).startsWith("..") && !skip.has(path))
    .map((path) => {
      const run = spawnSync("git", ["diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", relative(root, path)], { cwd: root, encoding: "utf8" });
      return run.stdout;
    })
    .join("");
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
  const [moduleName, tree] = plainFileParser(basename(tip.plainFile), resolveTemplateDirs(tip.plainFile, templateDirs), {
    allowNoFunctionalities: true,
  });
  return { moduleName, plainFile: tip.plainFile, tree, chain };
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
  /** Write and run conformance tests. Default: when the module has test reqs. */
  conformance?: boolean;
  /**
   * The conformance tests follow as a job of their own - render spec diff conformance, queued
   * behind this one. The change lands on its unit tests: the suite is run by that job, once the
   * tests are brought in line with the change, since the ones here may check what it changed.
   */
  conformanceLater?: boolean;
  /**
   * The diff was already put in when it was written - how that went - and is not to be applied
   * again. A render queued behind the interview runs after later changes have gone on top of
   * it, so its diff no longer fits the file either way - but it is in, and that is what matters.
   */
  applied?: "applied" | "already applied";
  /** The spec as parsed with the diff in. Taken now, after applying it, when not given. */
  spec?: SpecSnapshot;
  model?: string;
  /** Review the unit tests once they pass - that they test what the change says. Default true. */
  unitReview?: boolean;
  /** The unit test review's model. Default: the project's judge-model, else `model`. */
  judgeModel?: string;
  onDelta?: (delta: string) => void;
}

export interface RenderSpecDiffResult {
  /** The change section by section, as its agents were shown it - for the conformance job after it. */
  change?: string;
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
  conformance?: RenderConformanceTestsResult;
  regression?: RegressionResult;
  passed: boolean;
  stoppedAt: "unit tests" | "conformance" | "regression" | null;
  /** Conformance was left to a job of its own, which should run now. */
  conformanceLater?: boolean;
  /** The specs were only restructured: nothing was rendered, the spec as now laid out was recorded. */
  restructured?: boolean;
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
        `Render the module instead (render_module ${relative(cwd, tip.plainFile)}): it builds ${fresh.modules.join(", ")} and starts ` +
        `${fresh.rebuild.map((entry) => entry.moduleName).join(", ")} again from scratch on it.`,
    );
  }
  stage(`the spec diff is ${applied === "applied" ? "applied to the .plain files" : "already in the .plain files"} - rendering it in ${moduleName}'s codebase`);
  // The change is made to the codebase's last known good state, not to what an interrupted
  // run left half-written.
  stage("starting from the codebase's last commit");
  // The change is one unit - its code, its conformance tests, the whole suite - landed whole,
  // with the spec it was built from, or undone whole.
  const unit = startWork([tip.buildDir, conformanceDirFor(moduleName, modulesRoot(projectDirOf(tip.plainFile)))], moduleName);
  // Only laid out differently - definitions moved to a common module, specs moved between modules
  // of the chain: the code already is what the spec says. Nothing to render; the spec is recorded
  // as it is now laid out.
  const builtBefore = readBuiltTree(tip.buildDir);
  if (builtBefore !== null && sameSpec(builtBefore, tree)) {
    stage("the specs were only restructured - nothing to render; recording the spec as it is now laid out");
    writeBuiltTree(tip.buildDir, tree);
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
  // Turned off, the conformance testing script is not used at all, found or not.
  const scripts = options.conformance === false ? withoutConformance(findTestScripts(root, tip.plainFile, tip.buildDir)) : findTestScripts(root, tip.plainFile, tip.buildDir);
  const conformanceOn = options.conformance !== false && (sectionsOf(tree)[TEST_REQUIREMENTS] ?? []).length > 0;
  requireTestScripts(moduleName, scripts, { conformance: conformanceOn });
  reportActivity(`  unit testing script: ${relative(root, scripts.unit)}`);
  if (scripts.conformance !== undefined && conformanceOn) reportActivity(`  conformance testing script: ${relative(root, scripts.conformance)}`);
  if (options.conformance === false) reportActivity("  conformance is off: no conformance tests are written or run");
  const frids = [...getFrids(tree)];
  const lastFrid = frids.at(-1);
  const sections = sectionsOf(tree);
  const buildDir = tip.buildDir;
  // From scratch there is no build directory yet, and everything the agent runs runs in it.
  mkdirSync(buildDir, { recursive: true });
  const empty = listFiles(buildDir).length === 0;
  if (empty && tip.requires !== null) {
    const source = chain.find((entry) => entry.moduleName === tip.requires);
    if (source !== undefined) {
      stage(`no code here yet - starting from ${source.moduleName}'s code`);
      copyRequiredCode(source.buildDir, buildDir, moduleName, source.moduleName);
    }
  }

  const specifications: Specifications =
    lastFrid !== undefined ? getSpecificationsForFrid(tree, lastFrid)[0] : { ...sections, [FUNCTIONAL_REQUIREMENTS]: [] };
  const required = getInheritedFunctionalSpecs(tree);
  stage("mapping the codebase and writing the prompt");
  // The agent is given the spec the code is built from - the state before the change - and the change: the spec
  // before it, plus the diff, is the spec after it. Read from the codebase as it is now, code copied up from a
  // required module included; with nothing built, there is no spec before, and the change is all of it.
  const builtNow = readBuiltTree(buildDir) ?? {};
  // The change as it is to the code - from what it is built from to the spec this job records - section by section:
  // what every agent of this change is shown, in place of the raw diff.
  const changes = changesBetween(serializeTree(builtNow), serializeTree(tree));
  const changeText = changes.length > 0 ? describeSpecChange(changes) : undefined;
  const builtFrids = [...getFrids(builtNow)];
  const specificationsBefore: Specifications =
    builtFrids.length > 0 ? getSpecificationsForFrid(builtNow, builtFrids.at(-1)!)[0] : { ...sectionsOf(builtNow), [FUNCTIONAL_REQUIREMENTS]: [] };
  const prompt = buildSpecDiffPrompt({
    moduleName,
    diff: options.diff,
    // The change as it is to the code: from what it is built from to the spec this job records, section by section.
    changes,
    specifications: specificationsBefore,
    required: getInheritedFunctionalSpecs(builtNow),
    linkedResources: loadLinkedResources(tree, lastFrid ?? null, resolveTemplateDirs(tip.plainFile, templateDirs)),
    codebase: codebaseMap(buildDir),
    empty: listFiles(buildDir).length === 0,
  });

  const digestsBefore = digestFiles(buildDir);
  const runs: TestRun[] = [];
  const fence = confinedTools({ workdir: buildDir });
  const notes = notesForSession(buildDir, `${moduleName} spec change`);
  stage(`starting the coding agent${options.model ? ` (${options.model})` : ""}`);
  const executor = await createExecutor({
    cwd: buildDir,
    customTools: [
      notes.tool,
      ...createWebTools(),
      createScriptTool({ kind: "unit", script: scripts.unit, run: () => runUnitScript(buildDir, scripts.unit!), runs }),
      ...fence.tools,
    ],
    tools: [...fence.names, "run_unit_tests", "update_notes", ...WEB_TOOLS],
    model: options.model,
    label: `${moduleName} spec change coding agent`,
    system: fence.note,
  });

  let response: string;
  let verified = false;
  let unitReviewStopped = false;
  let followUp = 0;
  /** The harness's runs of the unit testing script: each is an attempt it judged. */
  let attempts = 0;
  /** How many times the agent, having written nothing, was asked for a draft. */
  let draftAsks = 0;
  const testRemovals: TestRemoval[] = [];
  try {
    stage("plainwright is implementing the spec change");
    let inventory = inventoryTests(buildDir);
    response = await ask(
      executor,
      // The scripts its work is judged by: the conformance testing script only when conformance runs.
      withNotes(withTestingScripts(prompt, scripts, conformanceOn ? ["unit", "conformance"] : ["unit"], root), buildDir),
      options.onDelta,
    );
    // Back and forth until the harness's run of the unit testing script passes - whatever the
    // agent ran, and whether it ran anything - or the rounds run out. Picks up where it left off
    // when called again.
    const untilPassing = async (): Promise<boolean> => {
      for (; followUp < MAX_FOLLOW_UPS; followUp += 1) {
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
        if (draftAsks < DRAFT_ASKS.change && wroteNothing(buildDir, digestsBefore)) {
          draftAsks += 1;
          stage("the coding agent has changed nothing yet - asking for a best-guess draft, or why the change needs no code");
          response = await ask(executor, draftPrompt(true), options.onDelta);
          continue;
        }

        stage(`running the unit testing script (attempt ${attempts + 1})`);
        attempts += 1;
        const verdict = await verifyUnitSuite(buildDir, runs, scripts.unit);
        if (verdict.ok) stage(`unit tests pass (attempt ${attempts})`);
        if (!verdict.ok) {
          stage(`unit tests not passing - fixing (round ${followUp + 1} of ${MAX_FOLLOW_UPS})`);
          response = await ask(executor, verdict.prompt, options.onDelta);
          continue;
        }
        return true;
      }
      return false;
    };
    verified = await untilPassing();

    // The unit tests pass - now whether they test what the change says, so they fail when it breaks.
    if (verified && options.unitReview !== false) {
      const reviewed = await untilUnitTestsReviewed({
        buildDir,
        atStart: digestsBefore,
        what: `the spec change to module \`${moduleName}\``,
        // As the coding agent had it: the spec the code was built from, and the change.
        spec: reviewedSpec({ moduleName, specifications: specificationsBefore, required: getInheritedFunctionalSpecs(builtNow), change: changeText ?? options.diff }),
        forChange: true,
        label: `${moduleName} spec change`,
        model: options.judgeModel ?? modelSpec(inheritModel(configForSpec(tip.plainFile).judgeModel, splitModelSpec(options.model))),
        send: async (next) => {
          response = await ask(executor, next, options.onDelta);
        },
        untilPassing,
        stage,
        onDelta: options.onDelta,
      });
      verified = reviewed.passed;
      if (!reviewed.passed) unitReviewStopped = true;
    }

    stage("checking the working notes were left");
    await notes.ensureWritten((next) => ask(executor, next, options.onDelta));
  } finally {
    executor.dispose();
  }

  // Passing means the harness's own run of the unit testing script passed, last.
  const unitPassed = verified;
  const files = diffFiles(digestsBefore, digestFiles(buildDir));
  const base = { moduleName, buildDir, diff: applied, response, runs, attempts, testRemovals, files, ...(changeText !== undefined ? { change: changeText } : {}) };

  /** The change landed: what the code is built from is now the spec with the change in, committed with it. */
  const land = () => {
    stage("recording what the code is built from, and committing it");
    writeBuiltTree(buildDir, tree);
    recordHistory(buildDir, `spec diff: ${summarizeDiff(options.diff)}`, options.diff);
  };

  if (!unitPassed) {
    stage(unitReviewStopped ? "the unit tests pass but still leave the change untested - undoing the change" : "unit tests NOT passing - undoing the change");
    abandonWork(unit, moduleName, "the spec change did not pass its unit tests");
    return { ...base, passed: false, stoppedAt: "unit tests" };
  }

  const conformanceRoot = modulesRoot(projectDirOf(tip.plainFile));
  // Conformance tests follow the change, whatever it touches - a definition, a req, the test reqs -
  // with or without a functional spec yet. Only with conformance off, or no test reqs to write them
  // from, are none written; the ones already here are kept passing all the same.
  const hasTestReqs = specifications[TEST_REQUIREMENTS].length > 0;
  if (options.conformance === false || !hasTestReqs) {
    // No conformance tests written for the change - but the ones already here are kept
    // passing: the change must not break what they check.
    stage(options.conformance === false ? "conformance is off - done" : "no conformance tests to write for this change - keeping the existing ones passing");
    const regression = await ensureRegressionPasses({
      start: unit,
      step: `${moduleName} spec change`,
      buildDir, conformanceRoot, moduleName, frids, tree, required, scripts,
      model: options.model, onDelta: options.onDelta,
    });
    if (regression.passed) land();
    return { ...base, regression, passed: regression.passed, stoppedAt: regression.passed ? null : "regression" };
  }

  if (options.conformanceLater === true) {
    stage("unit tests pass - landing the change; its conformance tests follow as a job of their own");
    land();
    return { ...base, passed: true, stoppedAt: null, conformanceLater: true };
  }

  stage("unit tests pass - bringing the conformance tests in line with the change");
  const conformance = await renderConformanceTests({
    plainFile: tip.plainFile,
    frid: lastFrid,
    templateDirs,
    buildDir,
    conformanceDir: conformanceDirFor(moduleName, conformanceRoot),
    diff: options.diff,
    ...(changeText !== undefined ? { change: changeText } : {}),
    spec: { moduleName, tree },
    // The implementation of the change is not committed yet: it is committed with the record.
    continuing: true,
    model: options.model,
    onDelta: options.onDelta,
  });
  if (!conformance.passed) {
    abandonWork(unit, moduleName, "the spec change's conformance tests do not pass");
    return { ...base, conformance, passed: false, stoppedAt: "conformance" };
  }

  stage("conformance tests pass - running the codebase's whole conformance suite");
  const regression = await ensureRegressionPasses({
    start: unit,
    step: `${moduleName} spec change`,
    buildDir,
    conformanceRoot,
    moduleName,
    frids,
    tree,
    required,
    scripts,
    model: options.model,
    onDelta: options.onDelta,
  });
  if (regression.passed) land();
  return { ...base, conformance, regression, passed: regression.passed, stoppedAt: regression.passed ? null : "regression" };
}

/** What a rendered spec change did, for the agent and the person. */
export function describeSpecDiff(result: RenderSpecDiffResult): string {
  const { added, changed, removed } = result.files;
  const repairs = result.regression?.repairs.length ?? 0;
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
          conformance: result.conformance,
          repairs: result.regression?.repairs.length,
        }),
    result.diff === "applied" ? "The diff was applied to the .plain files." : "The diff was already applied.",
    `Files: ${added.length} added, ${changed.length} changed, ${removed.length} removed.`,
    result.conformanceLater === true
      ? "Its conformance tests follow as a job of their own, queued behind this one."
      : result.conformance === undefined
      ? "Conformance tests were not run: the module has no test reqs, or they were turned off."
      : result.conformance.passed
        ? "Conformance tests were brought in line with the change and pass."
        : "Conformance tests are NOT passing.",
    repairs > 0 ? `${repairs} regression repair(s) changed the code beyond the change itself.` : "",
    result.testRemovals.length > 0 ? `Unit tests removed and justified: ${result.testRemovals.map((r) => r.file).join(", ")}.` : "",
    "",
    "<agent report>",
    result.response,
    "</agent report>",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
