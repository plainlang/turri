import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { IMPORT_DIRECTIVE, PLAIN_SOURCE_FILE_EXTENSION, readPlainSourceMetadata } from "../plain/parser.ts";
import { resolveTemplateDirs } from "./render.ts";
import { diffByFile, snapshotSpec, specFilesOf, type SpecSnapshot } from "./spec-change.ts";

/**
 * A spec diff cut by the codebase each part of it lands in.
 *
 * A change to a module's spec is made where its code lives now: the furthest-built codebase whose
 * chain includes the module. When one diff changes two modules of a chain and the one above is not
 * built yet, those are two codebases - the module below is its own tip - and rendering the whole
 * diff in the one above would leave the one below built from the spec before it. So the diff is
 * cut: each module's file goes to its own codebase, bottom of the chain first, and the module above
 * starts from the code below once that part has landed. A file a module imports goes with the
 * lowest module that reads it: the code above is built on that module's.
 */

export interface SpecDiffPart {
  /** The .plain file of the module the part is for. */
  plainFile: string;
  /** Its part of the diff: the files that land in its codebase. */
  diff: string;
  /** The spec as it stands, for that codebase. */
  spec: SpecSnapshot;
  /** The files it changes, as the diff names them. */
  files: string[];
}

export interface SplitRequest {
  plainFile: string;
  diff: string;
  spec: SpecSnapshot;
  /** Where the diff's paths are relative to. */
  cwd: string;
  templateDirs?: string[];
}

/** The module names some .plain file in these folders imports: import modules, not codebases. */
export function importedNames(dirs: string[]): Set<string> {
  const names = new Set<string>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((name) => name.endsWith(PLAIN_SOURCE_FILE_EXTENSION));
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        const imports = readPlainSourceMetadata(readFileSync(join(dir, entry), "utf8")).metadata[IMPORT_DIRECTIVE] as string[] | undefined;
        for (const name of imports ?? []) names.add(name);
      } catch {
        // A file that does not read imports nothing.
      }
    }
  }
  return names;
}

/**
 * The parts of a spec diff, one per codebase it lands in, bottom of the chain first. One part -
 * the request as it is - when it all lands in the codebase the request was for.
 */
export function splitSpecDiff(request: SplitRequest): SpecDiffPart[] {
  const whole: SpecDiffPart[] = [{ plainFile: request.plainFile, diff: request.diff, spec: request.spec, files: diffByFile(request.diff).map((part) => part.file) }];
  const cwd = resolve(request.cwd);
  const target = resolve(cwd, request.plainFile);
  const byFile = diffByFile(request.diff).filter((part) => part.file.endsWith(PLAIN_SOURCE_FILE_EXTENSION));
  if (byFile.length === 0) return whole;
  const dirs = resolveTemplateDirs(target, request.templateDirs ?? []);
  const imported = importedNames(dirs);

  // The codebase each module's change lands in: the request's own, for its module and the chain it is in.
  const snapshots = new Map<string, SpecSnapshot | null>([[target, request.spec]]);
  const snapshotOf = (plainFile: string): SpecSnapshot | null => {
    if (!snapshots.has(plainFile)) {
      try {
        snapshots.set(plainFile, snapshotSpec(plainFile, { cwd, templateDirs: request.templateDirs }));
      } catch {
        // Built on in more than one branch, or not a module: it cannot be placed on its own.
        snapshots.set(plainFile, null);
      }
    }
    return snapshots.get(plainFile)!;
  };
  const isModule = (path: string) => !imported.has(basename(path, PLAIN_SOURCE_FILE_EXTENSION));
  const touchedModules = byFile.map((part) => resolve(cwd, part.file)).filter(isModule);
  // Who reads an imported file: the modules the diff changes, and the chain the request is for.
  const readers = [...new Set([...touchedModules, target, ...request.spec.chain.map((entry) => resolve(entry.plainFile))])];
  const depth = (plainFile: string) => snapshotOf(plainFile)?.chain.length ?? Number.MAX_SAFE_INTEGER;

  const ownerOf = (path: string): string => {
    if (isModule(path)) return path;
    const reading = readers.filter((reader) => {
      try {
        return specFilesOf(reader, request.templateDirs ?? []).includes(path);
      } catch {
        return false;
      }
    });
    // The lowest of them: the code of the ones above is built on its.
    return reading.sort((a, b) => depth(a) - depth(b))[0] ?? target;
  };

  const groups = new Map<string, { owner: string; spec: SpecSnapshot; parts: typeof byFile }>();
  for (const part of byFile) {
    const owner = ownerOf(resolve(cwd, part.file));
    const spec = snapshotOf(owner);
    if (spec === null) return whole;
    const codebase = resolve(spec.chain.at(-1)!.buildDir);
    const group = groups.get(codebase);
    if (group !== undefined) group.parts.push(part);
    // The request's own module names the group when its codebase is the request's.
    else groups.set(codebase, { owner, spec, parts: [part] });
  }
  const requested = resolve(request.spec.chain.at(-1)!.buildDir);
  if (groups.size === 1 && groups.has(requested)) return whole;

  return [...groups.entries()]
    .map(([codebase, group], order) => ({ codebase, group, order }))
    .sort((a, b) => a.group.spec.chain.length - b.group.spec.chain.length || a.order - b.order)
    .map(({ codebase, group }) => ({
      plainFile: codebase === requested ? target : group.owner,
      diff: group.parts.map((part) => part.diff).join(""),
      spec: codebase === requested ? request.spec : group.spec,
      files: group.parts.map((part) => part.file),
    }));
}
