import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { plainFileParser, withParseCache } from "../plain/parser.ts";
import {
  FUNCTIONAL_REQUIREMENTS,
  getFrids,
  getInheritedFunctionalSpecs,
  getSpecificationsForFrid,
  TEST_REQUIREMENTS,
  type MarshalledPlainSource,
  type Specifications,
} from "../plain/spec.ts";
import { ask, createExecutor } from "../pi.ts";
import { reportStage } from "./activity.ts";
import { codebaseMap, diffFiles, digestFiles } from "./codebase.ts";
import { confinedTools } from "./confine.ts";
import { conformanceDirFor, renderConformanceTests, type RenderConformanceTestsResult } from "./conformance.ts";
import { ensureRegressionPasses, type RegressionResult } from "./module.ts";
import { modulesRoot, specChangeTryDirFor } from "./paths.ts";
import { describeTryIt } from "./delivery.ts";
import { createTryItTool, settleTryIt, tryItPrompt, type TryIt } from "./try-it.ts";
import { buildSpecDiffPrompt } from "./prompt.ts";
import { recordHistory, startFromLastCommit } from "./history.ts";
import { notesForSession, withNotes } from "./notes.ts";
import { ATTEMPTS, describeStop } from "./stop-report.ts";
import { summarizeDiff } from "./job-panel.ts";
import { resolveTemplateDirs } from "./render.ts";
import { type ChainEntry, copyRequiredCode, findCodebaseTip } from "./requires.ts";
import { loadLinkedResources } from "./resources.ts";
import { rewriteRecord, sectionsOf, specStateFor } from "./state.ts";
import {
  chooseRegressionCommand,
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
   * The diff was already put in when it was written - how that went - and is not to be applied
   * again. A render queued behind the interview runs after later changes have gone on top of
   * it, so its diff no longer fits the file either way - but it is in, and that is what matters.
   */
  applied?: "applied" | "already applied";
  /** The spec as parsed with the diff in. Taken now, after applying it, when not given. */
  spec?: SpecSnapshot;
  /**
   * Once the unit tests pass, ask how the person can try what changed, and check the steps.
   * On when someone is there to try it; off for long unattended runs.
   */
  tryIt?: boolean;
  model?: string;
  onDelta?: (delta: string) => void;
}

export interface RenderSpecDiffResult {
  /** The codebase the change was rendered in. */
  moduleName: string;
  buildDir: string;
  diff: "applied" | "already applied";
  response: string;
  runs: TestRun[];
  testRemovals: TestRemoval[];
  files: { added: string[]; changed: string[]; removed: string[] };
  conformance?: RenderConformanceTestsResult;
  regression?: RegressionResult;
  /** How to try it, as checked. Only when asked for and the unit tests passed. */
  tryIt?: TryIt;
  passed: boolean;
  stoppedAt: "unit tests" | "conformance" | "regression" | null;
}

export async function renderSpecDiff(options: RenderSpecDiffOptions): Promise<RenderSpecDiffResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const templateDirs = options.templateDirs ?? [];
  const applied = options.applied ?? applySpecDiff(options.diff, cwd);
  const spec = options.spec ?? snapshotSpec(options.plainFile, { cwd, templateDirs, inModule: options.inModule });
  const { moduleName, tree, chain } = spec;
  const tip = chain.at(-1)!;
  // The change is made to the codebase's last known good state, not to what an interrupted
  // run left half-written.
  startFromLastCommit(tip.buildDir, moduleName);
  const frids = [...getFrids(tree)];
  const lastFrid = frids.at(-1);
  const sections = sectionsOf(tree);
  const buildDir = tip.buildDir;
  // From scratch there is no build directory yet, and everything the agent runs runs in it.
  mkdirSync(buildDir, { recursive: true });
  const empty = listFiles(buildDir).length === 0;
  if (empty && tip.requires !== null) {
    const source = chain.find((entry) => entry.moduleName === tip.requires);
    if (source !== undefined) copyRequiredCode(source.buildDir, buildDir, moduleName, sections);
  }

  const specifications: Specifications =
    lastFrid !== undefined ? getSpecificationsForFrid(tree, lastFrid)[0] : { ...sections, [FUNCTIONAL_REQUIREMENTS]: [] };
  const required = getInheritedFunctionalSpecs(tree);
  const prompt = buildSpecDiffPrompt({
    moduleName,
    diff: options.diff,
    specifications,
    required,
    linkedResources: loadLinkedResources(tree, lastFrid ?? null, resolveTemplateDirs(tip.plainFile, templateDirs)),
    codebase: codebaseMap(tree, buildDir),
    empty: listFiles(buildDir).length === 0,
  });

  const digestsBefore = digestFiles(buildDir);
  const runs: TestRun[] = [];
  const fence = confinedTools({ workdir: buildDir });
  let tryIt: TryIt | undefined;
  const notes = notesForSession(buildDir);
  const executor = await createExecutor({
    cwd: buildDir,
    customTools: [
      notes.tool,
      createTryItTool((submitted) => (tryIt = submitted)),
      createRunTestsTool({
        name: "run_unit_tests",
        label: "Run unit tests",
        description: "Run the unit test suite in the working directory and return the exit code and output.",
        run: (command) => runCommand(buildDir, command),
        runs,
      }),
      ...fence.tools,
    ],
    tools: [...fence.names, "run_unit_tests", "describe_how_to_try_it", "update_notes"],
    model: options.model,
  });

  let response: string;
  let verified = false;
  const testRemovals: TestRemoval[] = [];
  try {
    reportStage(`${moduleName}: implementing the spec change`);
    let inventory = inventoryTests(buildDir);
    response = await ask(executor, withNotes(prompt, buildDir), options.onDelta);
    for (let followUp = 0; followUp < MAX_FOLLOW_UPS; followUp += 1) {
      const current = inventoryTests(buildDir);
      const removals = findTestRemovals(inventory, current);
      if (removals.length > 0) {
        // A removed spec takes its tests with it; the agent says which and why, as always.
        testRemovals.push(...removals);
        inventory = current;
        reportStage(`${moduleName}: justifying ${removals.length} removed test${removals.length === 1 ? "" : "s"}`);
        response = await ask(executor, removalChallengePrompt(removals, "unit tests"), options.onDelta);
        continue;
      }
      if (runs.at(-1)?.exitCode !== 0) {
        reportStage(`${moduleName}: unit tests not passing yet - fixing (round ${followUp + 1} of ${MAX_FOLLOW_UPS})`);
        response = await ask(executor, failingTestsPrompt(runs, "run_unit_tests"), options.onDelta);
        continue;
      }
      // The agent's own run passed. Whether the change is done is the harness's run.
      reportStage(`${moduleName}: checking the whole unit test suite`);
      const verdict = await verifyUnitSuite(buildDir, runs);
      if (!verdict.ok) {
        reportStage(`${moduleName}: unit tests not passing when the harness runs them - fixing (round ${followUp + 1} of ${MAX_FOLLOW_UPS})`);
        response = await ask(executor, verdict.prompt, options.onDelta);
        continue;
      }
      verified = true;
      break;
    }

    // Asked only once the tests pass: instructions for software that does not work yet would
    // be instructions for something else.
    if (options.tryIt === true && verified) {
      tryIt = await settleTryIt({
        buildDir,
        tryDir: specChangeTryDirFor(buildDir, moduleName),
        prompt: tryItPrompt("The spec change"),
        ask: async (next) => {
          tryIt = undefined;
          await ask(executor, next, options.onDelta);
          return tryIt;
        },
        stage: (label) => reportStage(`${moduleName}: ${label}`),
      });
    }
    await notes.ensureWritten((next) => ask(executor, next, options.onDelta));
  } finally {
    executor.dispose();
  }

  // Passing means the harness's own run of the whole suite passed - again after try-it, which
  // may have touched the code.
  const unitPassed = verified && (tryIt === undefined || (await verifyUnitSuite(buildDir, runs)).ok);
  const files = diffFiles(digestsBefore, digestFiles(buildDir));
  const base = { moduleName, buildDir, diff: applied, response, runs, testRemovals, files, tryIt };

  /** The record, rewritten to the spec the change was rendered from - whatever happened - and committed. */
  const record = (conformance: "passed" | "failed" | "skipped") => {
    rewriteRecord(buildDir, moduleName, {
      specDiff: options.diff,
      sections,
      required,
      functionalities: frids.map((frid) => ({
        frid,
        ...specStateFor(tree, frid),
        unitTests: unitPassed ? ("passed" as const) : ("failed" as const),
        conformance,
        testCommand: runs.filter((run) => run.exitCode === 0).at(-1)?.command,
      })),
    });
    const outcome = runs.at(-1)?.exitCode === 0 ? `conformance ${conformance}` : "unit tests NOT passing";
    recordHistory(buildDir, `spec diff: ${summarizeDiff(options.diff)} (${outcome})`, options.diff);
  };

  if (!unitPassed) {
    record("skipped");
    return { ...base, passed: false, stoppedAt: "unit tests" };
  }

  const conformanceRoot = modulesRoot(cwd);
  // Conformance tests are written for functionalities; a change with none to test writes
  // none, but still keeps the existing ones passing.
  const hasTestReqs = specifications[TEST_REQUIREMENTS].length > 0;
  if (options.conformance === false || !hasTestReqs || lastFrid === undefined) {
    // No conformance tests written for the change - but the ones already here are kept
    // passing: the change must not break what they check.
    const regression = await ensureRegressionPasses({
      buildDir, conformanceRoot, moduleName, frids, tree, required, command: null,
      model: options.model, onDelta: options.onDelta,
    });
    record("skipped");
    return { ...base, regression, passed: regression.passed, stoppedAt: regression.passed ? null : "regression" };
  }

  reportStage(`${moduleName}: bringing the conformance tests in line with the change`);
  const conformance = await renderConformanceTests({
    plainFile: tip.plainFile,
    frid: lastFrid,
    templateDirs,
    buildDir,
    conformanceDir: conformanceDirFor(moduleName, conformanceRoot),
    diff: options.diff,
    spec: { moduleName, tree },
    // The implementation of the change is not committed yet: it is committed with the record.
    continuing: true,
    model: options.model,
    onDelta: options.onDelta,
  });
  if (!conformance.passed) {
    record("failed");
    return { ...base, conformance, passed: false, stoppedAt: "conformance" };
  }

  const regression = await ensureRegressionPasses({
    buildDir,
    conformanceRoot,
    moduleName,
    frids,
    tree,
    required,
    ...chooseRegressionCommand(conformance.runs),
    model: options.model,
    onDelta: options.onDelta,
  });
  record(regression.passed ? "passed" : "failed");
  return { ...base, conformance, regression, passed: regression.passed, stoppedAt: regression.passed ? null : "regression" };
}

/** What a rendered spec change did, for the agent and the person. */
export function describeSpecDiff(result: RenderSpecDiffResult): string {
  const { added, changed, removed } = result.files;
  const repairs = result.regression?.repairs.length ?? 0;
  return [
    result.passed
      ? `Rendered the spec change in ${result.moduleName}'s codebase (${result.buildDir}).`
      : describeStop({
          moduleName: result.moduleName,
          at: result.stoppedAt!,
          runs: result.runs,
          conformance: result.conformance,
          repairs: result.regression?.repairs.length,
        }),
    result.diff === "applied" ? "The diff was applied to the .plain files." : "The diff was already applied.",
    `Files: ${added.length} added, ${changed.length} changed, ${removed.length} removed.`,
    result.conformance === undefined
      ? "Conformance tests were not run: the module has no test reqs, or they were turned off."
      : result.conformance.passed
        ? "Conformance tests were brought in line with the change and pass."
        : "Conformance tests are NOT passing.",
    repairs > 0 ? `${repairs} regression repair(s) changed the code beyond the change itself.` : "",
    result.testRemovals.length > 0 ? `Unit tests removed and justified: ${result.testRemovals.map((r) => r.file).join(", ")}.` : "",
    // Instructions for software that is not working would send the person after something
    // that does not exist yet.
    ...(result.passed && result.tryIt !== undefined ? describeTryIt(result.tryIt, result.buildDir) : []),
    "",
    "<agent report>",
    result.response,
    "</agent report>",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
