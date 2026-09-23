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
  type Specifications,
} from "../plain/spec.ts";
import { ask, createExecutor } from "../pi.ts";
import { reportStage } from "./activity.ts";
import { codebaseMap, diffFiles, digestFiles } from "./codebase.ts";
import { confinedTools } from "./confine.ts";
import { conformanceDirFor, renderConformanceTests, type RenderConformanceTestsResult } from "./conformance.ts";
import { ensureRegressionPasses, type RegressionResult } from "./module.ts";
import { modulesRoot } from "./paths.ts";
import { buildSpecDiffPrompt } from "./prompt.ts";
import { resolveTemplateDirs } from "./render.ts";
import { copyRequiredCode, findCodebaseTip } from "./requires.ts";
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
} from "./testing.ts";

/**
 * Render a change to the specs, given as a git diff of the .plain files.
 *
 * The change is whatever the person made - specs added, changed or removed, in any section,
 * across any number of them - and it is rendered the way a developer would take a spec
 * change: one agent, given the diff and every spec it touches as it now stands, makes the
 * code match. Starting from nothing is the same operation, with a diff that adds everything.
 *
 * After it, the order that makes the result trustworthy: the conformance tests are brought
 * in line with the change, the whole suite runs with repairs, and the build record is
 * rewritten to the specs as they now stand.
 */

const MAX_FOLLOW_UPS = 4;

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
   * The diff was applied when it was written, and is not to be applied again. A render queued
   * behind the interview runs after later changes have gone on top of it, so its diff no
   * longer fits the file either way - but it was applied, and that is what matters.
   */
  applied?: boolean;
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
  passed: boolean;
  stoppedAt: "unit tests" | "conformance" | "regression" | null;
}

export async function renderSpecDiff(options: RenderSpecDiffOptions): Promise<RenderSpecDiffResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const templateDirs = options.templateDirs ?? [];
  const applied = options.applied === true ? "already applied" : applySpecDiff(options.diff, cwd);

  // The change lands in the chain's current codebase. A module with no build of its own
  // starts from the code of the module it requires, as a render would.
  // A spec change is built whatever it touches - a definition, a req, a functional spec - so
  // a module with no functional specs yet is still a module to build.
  const { tip, chain } = withParseCache(() =>
    findCodebaseTip(resolve(cwd, options.plainFile), { templateDirs, inModule: options.inModule, allowNoFunctionalities: true }),
  );
  const [moduleName, tree] = plainFileParser(basename(tip.plainFile), resolveTemplateDirs(tip.plainFile, templateDirs), {
    allowNoFunctionalities: true,
  });
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
  const fence = confinedTools({ workdir: buildDir, read: [], write: [buildDir] });
  const executor = await createExecutor({
    cwd: buildDir,
    customTools: [
      createRunTestsTool({
        name: "run_unit_tests",
        label: "Run unit tests",
        description: "Run the unit test suite in the working directory and return the exit code and output.",
        run: (command) => runCommand(buildDir, command),
        runs,
      }),
      ...fence.tools,
    ],
    tools: [...fence.names, "run_unit_tests"],
    model: options.model,
  });

  let response: string;
  const testRemovals: TestRemoval[] = [];
  try {
    reportStage(`${moduleName}: implementing the spec change`);
    let inventory = inventoryTests(buildDir);
    response = await ask(executor, prompt, options.onDelta);
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
      break;
    }
  } finally {
    executor.dispose();
  }

  const unitPassed = runs.at(-1)?.exitCode === 0;
  const files = diffFiles(digestsBefore, digestFiles(buildDir));
  const base = { moduleName, buildDir, diff: applied, response, runs, testRemovals, files };

  /** The record, rewritten to the specs as they now stand - whatever happened. */
  const record = (conformance: "passed" | "failed" | "skipped") =>
    rewriteRecord(buildDir, moduleName, {
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
      : `The spec change in ${result.moduleName}'s codebase stopped at ${result.stoppedAt}.`,
    result.diff === "applied" ? "The diff was applied to the .plain files." : "The diff was already applied.",
    `Files: ${added.length} added, ${changed.length} changed, ${removed.length} removed.`,
    result.conformance === undefined
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
