import { basename, resolve } from "node:path";
import { getRenderRange, type MarshalledPlainSource } from "../plain/spec.ts";
import { conformanceDirFor, renderConformanceTests, type RenderConformanceTestsResult } from "./conformance.ts";
import { ensureRegressionPasses, type RegressionResult } from "./module.ts";
import { findCodebaseTip, requiredFunctionalSpecs, resolveRequiresChain, type ChainEntry } from "./requires.ts";
import { plainFileParser } from "../plain/parser.ts";
import { resolveTemplateDirs } from "./render.ts";
import { findTestScripts, projectRootFor } from "./test-scripts.ts";
import { modulesRoot, projectDirOf } from "./paths.ts";

/**
 * Writing conformance tests for code that already exists.
 *
 * Rendering and conformance are separate jobs. A codebase can be built and only later
 * given a conformance suite - for one functionality, a few, a whole module, or a whole
 * requires chain - and that is what this covers. Nothing here renders code; the build has
 * to be there already.
 */

export interface ConformanceSelection {
  /** Named functionalities. */
  frids?: string[];
  /** A range in `getRenderRange` form: "2" or "2,5". */
  range?: string;
  /** Every functionality of the module. The default when nothing else is given. */
  all?: boolean;
  /** Every module in the requires chain, each with all of its functionalities. */
  chain?: boolean;
}

export interface ConformanceTarget {
  moduleName: string;
  plainFile: string;
  buildDir: string;
  frids: string[];
}

/**
 * Which functionalities of which modules to write tests for.
 *
 * Kept separate from the running so the selection can be checked on its own - it is the
 * part with the arithmetic in it.
 */
export function resolveConformanceTargets(
  chain: ChainEntry[],
  selection: ConformanceSelection,
  treeFor: (entry: ChainEntry) => MarshalledPlainSource,
): ConformanceTarget[] {
  const entries = selection.chain === true ? chain : chain.slice(-1);

  return entries.map((entry) => {
    const base = { moduleName: entry.moduleName, plainFile: entry.plainFile, buildDir: entry.buildDir };

    // A selection of specific functionalities only makes sense for the module that was
    // named; everything it requires is taken whole.
    const isNamedModule = entry === chain[chain.length - 1];
    if (!isNamedModule) return { ...base, frids: entry.frids };

    if (selection.frids !== undefined && selection.frids.length > 0) {
      const unknown = selection.frids.filter((frid) => !entry.frids.includes(frid));
      if (unknown.length > 0) {
        throw new Error(
          `Functionality ${unknown.join(", ")} does not exist in ${entry.moduleName}. ` +
            `Available: ${entry.frids.join(", ")}.`,
        );
      }
      return { ...base, frids: entry.frids.filter((frid) => selection.frids!.includes(frid)) };
    }

    if (selection.range !== undefined) {
      return { ...base, frids: getRenderRange(selection.range, treeFor(entry)) };
    }

    return { ...base, frids: entry.frids };
  });
}

export interface ConformanceSuiteOutcome {
  moduleName: string;
  frid: string;
  result?: RenderConformanceTestsResult;
}

export interface ConformanceSuiteResult {
  targets: ConformanceTarget[];
  outcomes: ConformanceSuiteOutcome[];
  regression: Record<string, RegressionResult>;
  passed: boolean;
  /** The codebase the tests were written and run in, when it is not each module's own. */
  codebaseOf?: string;
}

export interface ConformanceSuiteOptions extends ConformanceSelection {
  plainFile: string;
  templateDirs?: string[];
  buildDir?: string;
  /** The codebase to test in, when modules built on this one branch. */
  inModule?: string;
  conformanceRoot?: string;
  model?: string;
  /** The judge's and the test review's model. */
  judgeModel?: string;
  /** Run the merged suite for each module afterwards. */
  regression?: boolean;
  onDelta?: (delta: string) => void;
  onEvent?: (event: ConformanceSuiteEvent) => void;
}

export type ConformanceSuiteEvent =
  | { type: "targets"; targets: ConformanceTarget[] }
  | { type: "start"; module: string; frid: string; index: number; total: number }
  | { type: "done"; module: string; frid: string; passed: boolean };

export async function renderConformanceSuite(
  options: ConformanceSuiteOptions,
): Promise<ConformanceSuiteResult> {
  const chain = resolveRequiresChain(options.plainFile, options.templateDirs, options.buildDir);
  const trees = new Map<string, MarshalledPlainSource>();
  const treeFor = (entry: ChainEntry) => {
    const cached = trees.get(entry.moduleName);
    if (cached !== undefined) return cached;
    const dirs = resolveTemplateDirs(entry.plainFile, options.templateDirs);
    const [, tree] = plainFileParser(entry.plainFile.split("/").pop()!, dirs);
    trees.set(entry.moduleName, tree);
    return tree;
  };

  const targets = resolveConformanceTargets(chain, options, treeFor);
  options.onEvent?.({ type: "targets", targets });

  // Conformance tests are written and run in the chain's current codebase, not in the named
  // module's older build: that is where the code they check now lives, and where they are
  // carried on up from as later modules are built. An explicit build directory is taken at
  // its word.
  const codebase =
    options.buildDir === undefined
      ? findCodebaseTip(options.plainFile, { templateDirs: options.templateDirs, inModule: options.inModule }).tip
      : undefined;
  const conformanceRoot = resolve(options.conformanceRoot ?? modulesRoot(projectDirOf(options.plainFile)));
  const outcomes: ConformanceSuiteOutcome[] = [];
  const regression: Record<string, RegressionResult> = {};
  let passed = true;

  const total = targets.reduce((sum, target) => sum + target.frids.length, 0);
  let index = 0;

  for (const target of targets) {
    for (const frid of target.frids) {
      index += 1;

      const buildDir = codebase?.buildDir ?? target.buildDir;
      const holder = codebase?.moduleName ?? target.moduleName;

      options.onEvent?.({ type: "start", module: target.moduleName, frid, index, total });

      const result = await renderConformanceTests({
        plainFile: target.plainFile,
        frid,
        templateDirs: options.templateDirs,
        buildDir,
        conformanceDir: conformanceDirFor(holder, conformanceRoot),
        model: options.model,
        judgeModel: options.judgeModel,
        onDelta: options.onDelta,
      });

      outcomes.push({ moduleName: target.moduleName, frid, result });
      options.onEvent?.({ type: "done", module: target.moduleName, frid, passed: result.passed });

      if (!result.passed) passed = false;
    }

    if (codebase === undefined && options.regression === true && target.frids.length > 0) {
      const tree = treeFor(chain.find((entry) => entry.moduleName === target.moduleName)!);
      const last = outcomes.filter((o) => o.moduleName === target.moduleName).at(-1)?.result;
      regression[target.moduleName] = await ensureRegressionPasses({
        buildDir: target.buildDir,
        conformanceRoot,
        moduleName: target.moduleName,
        frids: target.frids,
        tree,
        required: requiredFunctionalSpecs(target.plainFile, options.templateDirs),
        scripts: findTestScripts(projectRootFor(target.plainFile, target.buildDir), target.plainFile, target.buildDir),
        model: options.model,
        onDelta: options.onDelta,
      });
      if (!regression[target.moduleName]!.passed) passed = false;
    }
  }

  // In the current codebase, one suite holds every module's tests: it runs once, at the end.
  if (codebase !== undefined && options.regression === true) {
    const [, tipTree] = plainFileParser(basename(codebase.plainFile, codebase.buildDir), resolveTemplateDirs(codebase.plainFile, options.templateDirs));
    const last = outcomes.filter((o) => o.result !== undefined).at(-1)?.result;
    regression[codebase.moduleName] = await ensureRegressionPasses({
      buildDir: codebase.buildDir,
      conformanceRoot,
      moduleName: codebase.moduleName,
      frids: codebase.frids,
      tree: tipTree,
      required: requiredFunctionalSpecs(codebase.plainFile, options.templateDirs),
      scripts: findTestScripts(projectRootFor(codebase.plainFile, codebase.buildDir), codebase.plainFile, codebase.buildDir),
      model: options.model,
      onDelta: options.onDelta,
    });
    if (!regression[codebase.moduleName]!.passed) passed = false;
  }

  return { targets, outcomes, regression, passed, codebaseOf: codebase?.moduleName };
}

/** What a conformance suite run did, for the agent and the person. */
export function describeConformanceSuite(result: ConformanceSuiteResult): string {
  const written = result.outcomes;
  const failing = written.filter((o) => o.result && !o.result.passed);

  const lines = [
    ...(result.codebaseOf !== undefined
      ? [`Written and run in the codebase of ${result.codebaseOf}, where the chain's code now lives; carried up to every module built on it.`, ""]
      : []),
    result.passed
      ? `Conformance suite passes for ${result.targets.map((t) => t.moduleName).join(", ")}.`
      : `Conformance suite is NOT passing. ${failing.length} of ${written.length} failed.`,
    "",
    "<targets>",
    ...result.targets.map((t) => `${t.moduleName}: ${t.frids.join(", ")}`),
    "</targets>",
    "",
    "<results>",
    ...result.outcomes.map((o) => `${o.moduleName} ${o.frid}: ${o.result?.passed ? "pass" : "fail"}`),
    "</results>",
  ];

  const last = written.at(-1)?.result;
  if (last !== undefined) lines.push("", conformanceReport(last));
  return lines.join("\n");
}

function conformanceReport(result: RenderConformanceTestsResult): string {
  return [
    result.passed
      ? `Conformance tests pass for ${result.moduleName} functionality ${result.frid}.`
      : `Conformance tests are NOT passing for ${result.moduleName} functionality ${result.frid}.`,
    `Tests in ${result.conformanceDir}, run against ${result.buildDir}.`,
    result.specConflict !== undefined
      ? `The spec contradicts itself: functionalities ${result.specConflict.functionalities.map((ref) => `${ref.module} ${ref.frid}`).join(" and ")} cannot both hold. ${result.specConflict.reason.trim()}`
      : "",
    result.codeChanged
      ? "The implementation was changed to make the conformance tests pass."
      : "",
    result.reviewWaived !== undefined
      ? `The tests were optimised as far as the review could take them; its last suggestions are in the notes: ${result.reviewWaived.map((problem) => problem.what.trim()).join(" ").slice(0, 400)}`
      : "",
    "",
    "<files>",
    ...result.files,
    "</files>",
    "",
    "<runs>",
    ...result.runs.map((run) => `exit ${run.exitCode}: ${run.command}`),
    "</runs>",
    "",
    "<agent report>",
    result.response,
    "</agent report>",
  ]
    .filter(Boolean)
    .join("\n");
}
