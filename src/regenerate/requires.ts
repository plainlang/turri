import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { PLAIN_SOURCE_FILE_EXTENSION, plainFileParser, withParseCache, type ParseOptions } from "../plain/parser.ts";
import { getFrids, getInheritedFunctionalSpecs } from "../plain/spec.ts";
import { buildDirUnder, modulesRoot, projectDirOf } from "./paths.ts";
import { notesPath } from "./notes.ts";
import { resolveTemplateDirs } from "./paths.ts";
import { inheritedRecord, readRecord, RECORD_FILE, writeCodeRecord } from "./records.ts";
import { head, historyLog, recordHistory } from "./lineage.ts";
import { listFiles } from "./testing.ts";

/**
 * `requires` chains.
 *
 * A module that `requires` another is built on top of that module's code: the required
 * module must be finished first, and its codebase is copied into the build before this
 * module starts. So rendering a module means rendering its chain, bottom first, carrying
 * the code forward at each step.
 *
 * What has already been built is not tracked here: each codebase's record says what it is built
 * from - see `records.ts`.
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
  const root = resolve(buildRoot ?? modulesRoot(projectDirOf(plainFile)));
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

/**
 * The chains of the built modules whose requires chain includes `plainFile`'s module, and that no other
 * built module is built on - where its code lives now, one chain per branch. Empty when nothing built is
 * built on it. Found by reading every .plain file beside it.
 */
export function builtTips(plainFile: string, options: { templateDirs?: string[]; buildRoot?: string } = {}): ChainEntry[][] {
  return withParseCache(() => {
    const templateDirs = options.templateDirs ?? [];
    const self = resolveRequiresChain(plainFile, templateDirs, options.buildRoot, { allowNoFunctionalities: true }).at(-1)!;
    return tipsOf(builtChainsOver(self.moduleName, plainFile, templateDirs, options.buildRoot));
  });
}

/** Every chain of a built module whose requires chain includes `moduleName`. */
function builtChainsOver(moduleName: string, plainFile: string, templateDirs: string[], buildRoot?: string): ChainEntry[][] {
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
        chain = resolveRequiresChain(file, templateDirs, buildRoot);
      } catch {
        // Import modules, and anything that does not parse, are not codebases.
        continue;
      }
      const top = chain.at(-1)!;
      const includes = chain.some((entry) => entry.moduleName === moduleName);
      if (includes && listFiles(top.buildDir).length > 0) candidates.push(chain);
    }
  }
  return candidates;
}

/** Of built chains, those no other is built on top of. */
function tipsOf(candidates: ChainEntry[][]): ChainEntry[][] {
  const within = (chain: ChainEntry[]) => chain.slice(0, -1).map((entry) => entry.moduleName);
  return candidates.filter((chain) => !candidates.some((other) => other !== chain && within(other).includes(chain.at(-1)!.moduleName)));
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
  const candidates = builtChainsOver(self.moduleName, plainFile, templateDirs, options.buildRoot);

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
  const tips = tipsOf(candidates);
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
 * Copy a required module's codebase into the build that is about to be created.
 *
 * What the code is built from comes too, converted: what the source module built becomes what
 * the new one inherits, while the new module's own functional specs start empty. Copied as-is, it would claim the source's work as the new
 * module's own. And the conformance tests come, into the new module's tests directory.
 */
export function copyRequiredCode(
  from: string,
  to: string,
  toModule: string,
  /** The module the code comes from: its functional specs are what the new one inherits. */
  fromModule: string,
): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });

  const copied: string[] = [];
  for (const file of listFiles(from)) {
    if (basename(file) === RECORD_FILE) continue;
    const target = join(to, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(from, file), target);
    copied.push(file);
  }
  // The working notes describe this code, so they come up with it.
  if (existsSync(notesPath(from)) && !existsSync(notesPath(to))) copyFileSync(notesPath(from), notesPath(to));
  // What the code is built from comes with it, as what the new module inherits - not as its own work.
  const built = readRecord(from);
  writeCodeRecord(to, built !== null ? inheritedRecord(built, fromModule) : {});

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
    // And their notes, which listFiles leaves out as it does the code's.
    if (existsSync(notesPath(testsFrom)) && !existsSync(notesPath(testsTo))) copyFileSync(notesPath(testsFrom), notesPath(testsTo));
  }
  recordStart();
  return copied;
}

/**
 * A module the chain requires now that a module built in it was not built on: one required for
 * the first time - a new module the specs were split into, say - and the built modules above it,
 * whose code was started without it and so has to start again from scratch.
 *
 * A module was built on what its record lists as inherited; one with nothing recorded, on what it
 * was started from, as its history says. A module below it with nothing built was never under it.
 */
export function newlyRequired(chain: ChainEntry[]): { modules: string[]; rebuild: ChainEntry[] } | undefined {
  for (const [index, entry] of chain.entries()) {
    if (index === 0 || listFiles(entry.buildDir).length === 0) continue;
    const record = readRecord(entry.buildDir);
    if (record === null) continue;
    const recorded = getInheritedFunctionalSpecs(record);
    const known = new Set(recorded.map((spec) => spec.module));
    const history = known.size === 0 ? historyLog(entry.buildDir, 10_000) : "";
    const missing = chain.slice(0, index).filter((below) => {
      if (listFiles(below.buildDir).length === 0) return true;
      if (known.size > 0) return !known.has(below.moduleName);
      // Nothing inherited on record: new only when the history shows the code was never started from it.
      return below.moduleName === entry.requires && !history.startsWith("No history") && !history.includes(`start from ${below.moduleName}`);
    });
    if (missing.length > 0) {
      return { modules: missing.map((below) => below.moduleName), rebuild: chain.slice(index).filter((above) => listFiles(above.buildDir).length > 0) };
    }
  }
  return undefined;
}

/**
 * Take a module back to nothing - its code, its conformance tests and what they were built from -
 * so it is built again from the start, on the module it now requires. Committed, so the code that
 * was there is in its history.
 */
export function startFromScratch(entry: ChainEntry, why: string): void {
  const testsDir = join(dirname(entry.buildDir), "tests");
  for (const dir of [entry.buildDir, testsDir]) rmSync(dir, { recursive: true, force: true });
  mkdirSync(entry.buildDir, { recursive: true });
  recordHistory(entry.buildDir, `start from scratch: ${why}`);
}
