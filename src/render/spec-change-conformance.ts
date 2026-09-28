import { relative, resolve } from "node:path";
import { getFrids, getInheritedFunctionalSpecs, TEST_REQUIREMENTS } from "../plain/spec.ts";
import { reportActivity, reportStage, unitOf } from "./activity.ts";
import { conformanceDirFor, renderConformanceTests, type RenderConformanceTestsResult } from "./conformance.ts";
import { abandonWork, startWork } from "./history.ts";
import { ensureRegressionPasses, type RegressionResult } from "./module.ts";
import { modulesRoot, projectDirOf } from "./paths.ts";
import { applySpecDiff, snapshotSpec, type SpecSnapshot } from "./spec-change.ts";
import { sectionsOf } from "./state.ts";
import { describeStop } from "./stop-report.ts";
import { missingTestLabels } from "./test-kinds.ts";
import { findTestScripts, projectRootFor, requireTestScripts } from "./test-scripts.ts";

/**
 * The conformance tests brought in line with a spec change - the spec diff's counterpart of
 * render_functionality_conformance, as render spec diff is render functionality's.
 *
 * Rendering the code and conformance are separate jobs. A spec change can be rendered without
 * conformance and given it later, or be a change the code does not need at all - test reqs, an
 * acceptance test - and only the tests follow it. Either way one agent is given the diff and the
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
  /** A .plain file of the module the change is for. */
  plainFile: string;
  /** The change, as a git diff of the .plain files. */
  diff: string;
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
  const scripts = findTestScripts(root);
  requireTestScripts(moduleName, scripts, { conformance: true });
  reportActivity(`  conformance testing script: ${relative(root, scripts.conformance!)}`);

  const buildDir = tip.buildDir;
  const conformanceRoot = modulesRoot(projectDirOf(tip.plainFile));
  const conformanceDir = conformanceDirFor(moduleName, conformanceRoot);
  // From the codebase's last commit, the tests' too: the change is made to the last known good
  // state, not to what an interrupted run left half-written. The tests and the whole suite are
  // one unit, landed whole or undone whole.
  const unit = startWork([buildDir, conformanceDir], moduleName);
  const conformance = await renderConformanceTests({
    plainFile: tip.plainFile,
    frid: lastFrid,
    templateDirs,
    buildDir,
    conformanceDir,
    diff: options.diff,
    spec: { moduleName, tree },
    model: options.model,
    onDelta: options.onDelta,
  });

  // What the codebase now has conformance tests for, as their labels say.
  const tested = () => frids.filter((frid) => missingTestLabels(conformanceDir, frid, []).length === 0);
  const base = { moduleName, buildDir, conformanceDir, diff: applied, conformance };

  if (!conformance.passed) {
    abandonWork(unit, moduleName, "the conformance tests for the spec change do not pass");
    return { ...base, tested: tested(), passed: false, stoppedAt: "conformance" };
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
    "",
    "<agent report>",
    result.conformance.response,
    "</agent report>",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
