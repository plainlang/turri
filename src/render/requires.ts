import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { PLAIN_SOURCE_FILE_EXTENSION, plainFileParser } from "../plain/parser.ts";
import { getFrids } from "../plain/spec.ts";
import { buildDirUnder, modulesRoot } from "./paths.ts";
import { resolveTemplateDirs } from "./render.ts";
import { STATE_FILE } from "./state.ts";
import { listFiles } from "./testing.ts";

/**
 * `requires` chains.
 *
 * A module that `requires` another is built on top of that module's code: the required
 * module must be finished first, and its codebase is copied into the build before this
 * module starts. So rendering a module means rendering its chain, bottom first, carrying
 * the code forward at each step.
 *
 * What has already been built is not tracked here - that is per functionality, in
 * `state.ts`, because a module is routinely left part-built.
 */

export interface ChainEntry {
  moduleName: string;
  plainFile: string;
  buildDir: string;
  /** The module whose code is copied in before this one is built. */
  requires: string | null;
  frids: string[];
}

function locateModule(moduleName: string, templateDirs: string[]): string {
  for (const dir of templateDirs) {
    const candidate = join(dir, moduleName + PLAIN_SOURCE_FILE_EXTENSION);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Required module '${moduleName}' not found in: ${templateDirs.join(", ")}`);
}

/**
 * The chain to build, bottom first.
 *
 * Depth-first, post-order: everything a module requires is listed before the module
 * itself. The parser has already rejected circular requires, and a module reached twice is
 * emitted once.
 */
export function resolveRequiresChain(
  plainFile: string,
  templateDirs: string[] = [],
  buildRoot?: string,
): ChainEntry[] {
  const dirs = resolveTemplateDirs(plainFile, templateDirs);
  const root = resolve(buildRoot ?? modulesRoot());
  const chain: ChainEntry[] = [];
  const seen = new Set<string>();

  const visit = (file: string, requiredBy: string[]): string => {
    const [moduleName, tree, requires] = plainFileParser(basename(file), dirs);

    if (requiredBy.includes(moduleName)) {
      throw new Error(`Circular requires: ${[...requiredBy, moduleName].join(" -> ")}`);
    }
    if (seen.has(moduleName)) return moduleName;

    let previous: string | null = null;
    for (const required of requires) {
      previous = visit(locateModule(required, dirs), [...requiredBy, moduleName]);
    }

    seen.add(moduleName);
    chain.push({
      moduleName,
      plainFile: resolve(file),
      buildDir: buildDirUnder(root, moduleName),
      requires: previous,
      frids: [...getFrids(tree)],
    });
    return moduleName;
  };

  visit(resolve(plainFile), []);
  return chain;
}

/**
 * Copy a required module's codebase into the build that is about to be created.
 *
 * The build state is left behind: it describes which functionalities of *that* module are
 * built, and copying it would make the new build claim work it has not done.
 */
export function copyRequiredCode(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });

  const copied: string[] = [];
  for (const file of listFiles(from)) {
    if (basename(file) === STATE_FILE) continue;
    const target = join(to, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(from, file), target);
    copied.push(file);
  }
  return copied;
}

export function describeChain(chain: ChainEntry[]): string {
  return chain
    .map((entry, index) => {
      const from = entry.requires ? `, code from ${entry.requires}` : "";
      const count = `${entry.frids.length} functionalit${entry.frids.length === 1 ? "y" : "ies"}`;
      return `${index + 1}. ${entry.moduleName}  ${count}${from}`;
    })
    .join("\n");
}
