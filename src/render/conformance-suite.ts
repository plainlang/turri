import { resolve } from "node:path";
import { getRenderRange, type MarshalledPlainSource } from "../plain/spec.ts";
import { conformanceDirFor, renderConformanceTests, type RenderConformanceTestsResult } from "./conformance.ts";
import { ensureRegressionPasses, type RegressionResult } from "./module.ts";
import { resolveRequiresChain, type ChainEntry } from "./requires.ts";
import { recordFunctionality, readState, specStateFor } from "./state.ts";
import { plainFileParser } from "../plain/parser.ts";
import { resolveTemplateDirs } from "./render.ts";
import { modulesRoot } from "./paths.ts";

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
  skipped: boolean;
  result?: RenderConformanceTestsResult;
}

export interface ConformanceSuiteResult {
  targets: ConformanceTarget[];
  outcomes: ConformanceSuiteOutcome[];
  regression: Record<string, RegressionResult>;
  passed: boolean;
}

export interface ConformanceSuiteOptions extends ConformanceSelection {
  plainFile: string;
  templateDirs?: string[];
  buildDir?: string;
  conformanceRoot?: string;
  model?: string;
  /** Rewrite suites that already pass. */
  force?: boolean;
  /** Run the merged suite for each module afterwards. */
  regression?: boolean;
  onDelta?: (delta: string) => void;
  onEvent?: (event: ConformanceSuiteEvent) => void;
}

export type ConformanceSuiteEvent =
  | { type: "targets"; targets: ConformanceTarget[] }
  | { type: "start"; module: string; frid: string; index: number; total: number }
  | { type: "skipped"; module: string; frid: string }
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

  const conformanceRoot = resolve(options.conformanceRoot ?? modulesRoot());
  const outcomes: ConformanceSuiteOutcome[] = [];
  const regression: Record<string, RegressionResult> = {};
  let passed = true;

  const total = targets.reduce((sum, target) => sum + target.frids.length, 0);
  let index = 0;

  for (const target of targets) {
    for (const frid of target.frids) {
      index += 1;

      const built = readState(target.buildDir)?.functionalities[frid];
      if (!options.force && built?.conformance === "passed") {
        options.onEvent?.({ type: "skipped", module: target.moduleName, frid });
        outcomes.push({ moduleName: target.moduleName, frid, skipped: true });
        continue;
      }

      options.onEvent?.({ type: "start", module: target.moduleName, frid, index, total });

      const result = await renderConformanceTests({
        plainFile: target.plainFile,
        frid,
        templateDirs: options.templateDirs,
        buildDir: target.buildDir,
        conformanceDir: conformanceDirFor(target.moduleName, frid, conformanceRoot),
        model: options.model,
        onDelta: options.onDelta,
      });

      outcomes.push({ moduleName: target.moduleName, frid, skipped: false, result });
      options.onEvent?.({ type: "done", module: target.moduleName, frid, passed: result.passed });

      // The build's record of this functionality gains its conformance verdict; whether
      // the code was rendered here or long ago does not change what is true of it now.
      const tree = treeFor(chain.find((entry) => entry.moduleName === target.moduleName)!);
      recordFunctionality(target.buildDir, target.moduleName, {
        frid,
        ...specStateFor(tree, frid),
        unitTests: built?.unitTests ?? "passed",
        conformance: result.passed ? "passed" : "failed",
      });

      if (!result.passed) passed = false;
    }

    if (options.regression === true && target.frids.length > 0) {
      const tree = treeFor(chain.find((entry) => entry.moduleName === target.moduleName)!);
      const last = outcomes.filter((o) => o.moduleName === target.moduleName).at(-1)?.result;
      regression[target.moduleName] = await ensureRegressionPasses({
        buildDir: target.buildDir,
        conformanceRoot,
        moduleName: target.moduleName,
        frids: target.frids,
        tree,
        command: last?.runs.filter((run) => run.exitCode === 0).at(-1)?.command ?? null,
        model: options.model,
        onDelta: options.onDelta,
      });
      if (!regression[target.moduleName]!.passed) passed = false;
    }
  }

  return { targets, outcomes, regression, passed };
}
