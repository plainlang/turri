import { relative, resolve } from "node:path";
import { digestFiles } from "./codebase.ts";
import type { JobCases } from "./drift.ts";
import { getFrids, getInheritedFunctionalSpecs, TEST_REQUIREMENTS } from "../plain/spec.ts";
import { reportActivity, reportLogNote, reportStage, unitOf } from "./activity.ts";
import { conformanceDirFor, notLandedWhy, renderConformanceTests, type RenderConformanceTestsResult } from "./conformance.ts";
import { abandonWork, startWork } from "./lineage.ts";
import { ensureRegressionPasses, type RegressionResult } from "./regression.ts";
import { modulesRoot, projectDirOf } from "./paths.ts";
import { applySpecDiff, snapshotSpec, specGapsText, type SpecSnapshot } from "./regrow.ts";
import { linesAddedSince, readNotes } from "./notes.ts";
import { sectionsOf } from "./state.ts";
import { describeStop } from "./stop-report.ts";
import { missingTestLabels } from "./test-kinds.ts";
import { findTestScripts, projectRootFor, requireTestScripts } from "./test-scripts.ts";

/**
 * The conformance tests brought in line with a spec change: a conformance job of the work loop
 * (docs/growing.md).
 *
 * Rendering the code and conformance are separate jobs. A spec change is built in the code first
 * and its tests follow, or it is a change the code does not need at all - test reqs, an acceptance
 * test - and only the tests follow it. Either way one agent is given the diff and the
 * spec as it stands, and brings the tests in line: writes, changes and removes them. It can fix
 * the code where a test shows the code does not do what the spec says, as it can when it writes a
 * functionality's tests; nothing here renders the change itself.
 *
 * Nothing records which changes the tests have followed: the tests carry that themselves, each
 * labelled with its functionality, and the agent reads them against the whole spec.
 *
 * The tests are written in the chain's current codebase - the furthest-built module whose chain
 * includes the one the change is to - because that is where the code they check lives, and
 * where they are carried up from as later modules are built. A change to a module low in the
 * chain is tested in the latest module built on it.
 */

export interface RenderSpecDiffConformanceOptions {
  /** What the job does to each functional spec (work.ts): its agents are told case by case. */
  cases?: JobCases;
  /** A .plain file of the module the change is for. */
  plainFile: string;
  /** The change, as a git diff of the .plain files. */
  diff: string;
  /** That change section by section, as the render that landed it worked it out: shown to the agents in place of the diff. */
  change?: string;
  /** Where the diff's paths are relative to. Default: the working directory. */
  cwd?: string;
  templateDirs?: string[];
  /** The codebase to test in, when modules built on this one branch. */
  inModule?: string;
  /** The diff was already put in when the job was asked for, and how that went. */
  applied?: "applied" | "already applied";
  /** The spec as parsed with the diff in. Taken now, after applying it, when not given. */
  spec?: SpecSnapshot;
  model?: string;
  onDelta?: (delta: string) => void;
}

export interface RenderSpecDiffConformanceResult {
  /** The codebase the tests were written and run in. */
  moduleName: string;
  buildDir: string;
  conformanceDir: string;
  diff: "applied" | "already applied";
  conformance: RenderConformanceTestsResult;
  regression?: RegressionResult;
  /** The functionalities the codebase has conformance tests for, as their labels say, after the change. */
  tested: string[];
  passed: boolean;
  stoppedAt: "conformance" | "regression" | null;
  /** Spec gaps its agents added to the notes: what the spec should say and does not, for the person to decide. */
  specGaps?: string[];
}

export async function renderSpecDiffConformance(options: RenderSpecDiffConformanceOptions): Promise<RenderSpecDiffConformanceResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const templateDirs = options.templateDirs ?? [];
  const applied = options.applied ?? applySpecDiff(options.diff, cwd);
  const spec = options.spec ?? snapshotSpec(options.plainFile, { cwd, templateDirs, inModule: options.inModule });
  const { moduleName, tree, chain } = spec;
  const tip = chain.at(-1)!;
  const stage = (label: string) => reportStage(`${unitOf(moduleName)}: ${label}`);
  stage(
    `the spec diff is ${applied === "applied" ? "applied to the .plain files" : "already in the .plain files"} - ` +
      `bringing the conformance tests in ${moduleName}'s codebase in line with it`,
  );

  // The change is tested whatever it touches - with or without a functional spec yet.
  const frids = [...getFrids(tree)];
  const lastFrid = frids.at(-1);
  if ((sectionsOf(tree)[TEST_REQUIREMENTS] ?? []).length === 0) {
    throw new Error(
      `${moduleName} has no ${TEST_REQUIREMENTS}, so conformance tests cannot be written: they say how conformance tests ` +
        "are written and run. Add them first - a change to them is a spec diff like any other.",
    );
  }

  stage("finding the project's testing scripts");
  const root = projectRootFor(tip.plainFile, tip.buildDir);
  const scripts = findTestScripts(root, tip.plainFile, tip.buildDir);
  requireTestScripts(moduleName, scripts, { conformance: true });
  reportLogNote(`  conformance testing script: ${relative(root, scripts.conformance!)}`);

  const buildDir = tip.buildDir;
  const conformanceRoot = modulesRoot(projectDirOf(tip.plainFile));
  const conformanceDir = conformanceDirFor(moduleName, conformanceRoot);
  // From the codebase's last commit, the tests' too: the change is made to the last known good
  // state, not to what an interrupted run left half-written. The tests and the whole suite are
  // one unit, landed whole or undone whole.
  const unit = startWork([buildDir, conformanceDir], moduleName);
  // The notes as its agents find them: a spec gap they add is told with the result.
  const notesBefore = readNotes(buildDir);
  const conformance = await renderConformanceTests({
    plainFile: tip.plainFile,
    frid: lastFrid,
    templateDirs,
    buildDir,
    conformanceDir,
    diff: options.diff,
    ...(options.change !== undefined ? { change: options.change } : {}),
    ...(options.cases !== undefined ? { cases: options.cases } : {}),
    spec: { moduleName, tree },
    model: options.model,
    onDelta: options.onDelta,
  });

  // What the codebase now has conformance tests for, as their labels say.
  const tested = () => frids.filter((frid) => missingTestLabels(conformanceDir, frid, []).length === 0);
  // Read before a rollback takes the notes back: a gap is the person's to decide, whether the tests passed or not.
  const base = { moduleName, buildDir, conformanceDir, diff: applied, conformance, specGaps: linesAddedSince(notesBefore, buildDir, "gaps") };

  if (!conformance.passed) {
    abandonWork(unit, moduleName, notLandedWhy("for the spec change", conformance.unlabelled));
    return { ...base, tested: tested(), passed: false, stoppedAt: "conformance" };
  }

  // The run that passed was of the whole suite - the module's tests folder holds the chain's, copied up - and the unit
  // tests with it: on code and tests still as they were then, a second run would only say it again.
  if (conformance.green !== undefined && sameFiles(conformance.green.code, digestFiles(buildDir)) && sameFiles(conformance.green.tests, digestFiles(conformanceDir))) {
    stage("the whole conformance suite and the unit tests passed on the code and the tests as they are - not run again");
    const regression = { passed: true, runs: [], repairs: [], command: scripts.conformance! };
    return { ...base, tested: tested(), regression, passed: true, stoppedAt: null };
  }
  stage("conformance tests pass - running the codebase's whole conformance suite");
  const regression = await ensureRegressionPasses({
    start: unit,
    step: `${moduleName} spec change conformance`,
    buildDir,
    conformanceRoot,
    moduleName,
    frids,
    tree,
    required: getInheritedFunctionalSpecs(tree),
    scripts,
    model: options.model,
    onDelta: options.onDelta,
  });
  return { ...base, tested: tested(), regression, passed: regression.passed, stoppedAt: regression.passed ? null : "regression" };
}

/** Whether two digests of a folder hold the same files, each with the same content. */
function sameFiles(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [file, digest] of a) if (b.get(file) !== digest) return false;
  return true;
}

/** What the conformance for a spec change did, for the agent and the person. */
export function describeSpecDiffConformance(result: RenderSpecDiffConformanceResult): string {
  const repairs = result.regression?.repairs.length ?? 0;
  return [
    result.passed
      ? `The conformance tests in ${result.moduleName}'s codebase (${result.conformanceDir}) are in line with the spec change, and the whole suite passes.`
      : describeStop({
          moduleName: result.moduleName,
          at: result.stoppedAt!,
          runs: [],
          attempts: 0,
          conformance: result.conformance,
          repairs: result.regression?.repairs.length,
        }),
    result.diff === "applied" ? "The diff was applied to the .plain files." : "The diff was already applied.",
    result.tested.length > 0
      ? `Functionalities with conformance tests: ${result.tested.join(", ")}.`
      : "No functionality has labelled conformance tests yet.",
    result.conformance.codeChanged ? "The code was changed where a test showed it did not do what the spec says." : "",
    result.conformance.reviewWaived !== undefined
      ? `The tests were optimised as far as the review could take them; its last suggestions are in the notes: ${result.conformance.reviewWaived.map((problem) => problem.what.trim()).join(" ").slice(0, 400)}`
      : "",
    repairs > 0 ? `${repairs} regression repair(s) changed the code.` : "",
    result.conformance.testRemovals.length > 0
      ? `Conformance tests removed and justified: ${result.conformance.testRemovals.map((r) => r.file).join(", ")}.`
      : "",
    ...specGapsText(result.specGaps),
    "",
    "<agent report>",
    result.conformance.response,
    "</agent report>",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
