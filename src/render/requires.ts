import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { PLAIN_SOURCE_FILE_EXTENSION, plainFileParser, withParseCache, type ParseOptions } from "../plain/parser.ts";
import { getFrids, getInheritedFunctionalSpecs } from "../plain/spec.ts";
import { buildDirUnder, modulesRoot } from "./paths.ts";
import { resolveTemplateDirs } from "./render.ts";
import { inheritRecord, STATE_FILE, type RequiredSpec, type SharedSections } from "./state.ts";
import { head, recordHistory } from "./history.ts";
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
  /** Accept the named module without functional specs yet. Those it requires must have them. */
  options: ParseOptions = {},
): ChainEntry[] {
  const dirs = resolveTemplateDirs(plainFile, templateDirs);
  const root = resolve(buildRoot ?? modulesRoot());
  const chain: ChainEntry[] = [];
  const seen = new Set<string>();

  const visit = (file: string, requiredBy: string[]): string => {
    const [moduleName, tree, requires] = plainFileParser(basename(file), dirs, requiredBy.length === 0 ? options : {});

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
 * The codebase a change to `plainFile`'s module lands in: the furthest-built module whose
 * requires chain includes it, with that chain.
 *
 * Code accumulates up a chain, so once modules have been built on top of this one, its own
 * build is only an early snapshot - the living codebase is the one at the tip. A change to
 * this module's spec is made there, where everything built since can be kept working, not
 * in the snapshot, where it would have to be copied up over newer work.
 *
 * Found by reading every .plain file beside this one. Where built descendants sit on
 * different branches there is no single tip, and choosing one is a decision: `inModule`
 * names it, and without it this refuses rather than guesses.
 */
export function findCodebaseTip(
  plainFile: string,
  options: { templateDirs?: string[]; buildRoot?: string; inModule?: string; allowNoFunctionalities?: boolean } = {},
): { tip: ChainEntry; chain: ChainEntry[] } {
  return withParseCache(() => findTip(plainFile, options));
}

function findTip(
  plainFile: string,
  options: { templateDirs?: string[]; buildRoot?: string; inModule?: string; allowNoFunctionalities?: boolean },
): { tip: ChainEntry; chain: ChainEntry[] } {
  const templateDirs = options.templateDirs ?? [];
  const own = resolveRequiresChain(plainFile, templateDirs, options.buildRoot, {
    allowNoFunctionalities: options.allowNoFunctionalities,
  });
  const self = own.at(-1)!;

  const candidates: ChainEntry[][] = [];
  const seen = new Set<string>();
  for (const dir of resolveTemplateDirs(plainFile, templateDirs)) {
    let names: string[];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(PLAIN_SOURCE_FILE_EXTENSION));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = join(dir, name);
      if (seen.has(file)) continue;
      seen.add(file);
      let chain: ChainEntry[];
      try {
        chain = resolveRequiresChain(file, templateDirs, options.buildRoot);
      } catch {
        // Import modules, and anything that does not parse, are not codebases.
        continue;
      }
      const top = chain.at(-1)!;
      const includes = chain.some((entry) => entry.moduleName === self.moduleName);
      if (includes && listFiles(top.buildDir).length > 0) candidates.push(chain);
    }
  }

  const within = (chain: ChainEntry[]) => chain.slice(0, -1).map((entry) => entry.moduleName);
  if (options.inModule !== undefined) {
    const chosen = candidates.find((chain) => chain.at(-1)!.moduleName === options.inModule);
    if (chosen === undefined) {
      throw new Error(
        `'${options.inModule}' is not a built module that requires '${self.moduleName}'. ` +
          `Built ones that do: ${candidates.map((c) => c.at(-1)!.moduleName).join(", ") || "none"}.`,
      );
    }
    return { tip: chosen.at(-1)!, chain: chosen };
  }

  // A tip is a candidate that no other candidate is built on top of.
  const tips = candidates.filter(
    (chain) => !candidates.some((other) => other !== chain && within(other).includes(chain.at(-1)!.moduleName)),
  );
  if (tips.length === 0) return { tip: self, chain: own };
  if (tips.length > 1) {
    throw new Error(
      `'${self.moduleName}' is built on in more than one branch: ${tips.map((c) => c.at(-1)!.moduleName).join(", ")}. ` +
        "Say which codebase to regenerate in.",
    );
  }
  return { tip: tips[0]!.at(-1)!, chain: tips[0]! };
}

/**
 * Every functional spec of the modules this one requires, transitively, bottom of the chain
 * first - as the parser inherits them.
 *
 * A required module's code is copied in as this module's starting point, and that code
 * already holds its own ancestors'. So all of their functional specs are previous
 * functional specs here: already implemented, in this codebase.
 */
export function requiredFunctionalSpecs(plainFile: string, templateDirs: string[] = []): RequiredSpec[] {
  const [, tree] = plainFileParser(basename(plainFile), resolveTemplateDirs(plainFile, templateDirs));
  return getInheritedFunctionalSpecs(tree);
}

/**
 * Copy a required module's codebase into the build that is about to be created.
 *
 * The build record comes too, converted: what the source module built becomes what the new
 * one inherits, with how and where each functionality was built, while the new module's own
 * functionalities start empty. Copied as-is, it would claim the source's work as the new
 * module's own. And the conformance tests come, into the new module's tests directory.
 */
export function copyRequiredCode(
  from: string,
  to: string,
  toModule: string,
  /** The new module's own definitions and reqs, imports included, for its record. */
  sections?: SharedSections,
): string[] {
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
  // The record comes with the code, as what the new module inherits - not as its own work.
  inheritRecord(from, to, toModule, sections);

  // A new module's history starts here: where its code came from, and at which commit.
  const source = basename(dirname(from));
  const at = head(from);
  const recordStart = () => recordHistory(to, `start from ${source}${at ? ` at ${at}` : ""}`);

  // So do the conformance tests: they check the code that was just copied, and the new
  // module's regression suite has to keep them passing. They sit beside the code, in the
  // module's `tests` directory.
  const testsFrom = join(dirname(from), "tests");
  const testsTo = join(dirname(to), "tests");
  if (existsSync(testsFrom)) {
    for (const file of listFiles(testsFrom)) {
      const target = join(testsTo, file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(testsFrom, file), target);
    }
  }
  recordStart();
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
