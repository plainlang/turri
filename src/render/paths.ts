import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Where a module's generated code and tests live.
 *
 * Everything a module produces sits under `plain_modules/<module>/`, next to the specs it
 * came from and inside the project's own repository: `code/` holds the implementation and
 * its unit tests, `tests/` the black-box conformance tests - of every functionality built so
 * far, the required modules' included, organised however suits them.
 * The build state is written into `code/`, so what a codebase contains travels with that
 * codebase instead of living in a scratch directory that can be cleared without anyone
 * noticing the specs and the code have drifted apart.
 */

export const MODULES_DIR = "plain_modules";

export function moduleDir(moduleName: string, cwd: string = process.cwd()): string {
  return join(cwd, MODULES_DIR, moduleName);
}

/** Implementation and unit tests: `plain_modules/<module>/code`. */
export function defaultBuildDir(moduleName: string, cwd: string = process.cwd()): string {
  return join(moduleDir(moduleName, cwd), "code");
}

/** Conformance tests: `plain_modules/<module>/tests`. */
export function defaultTestsDir(moduleName: string, cwd: string = process.cwd()): string {
  return join(moduleDir(moduleName, cwd), "tests");
}

/**
 * The directory every module's output hangs off, `plain_modules` by default.
 *
 * Callers override this to build somewhere else - a sandbox, a test fixture - and the
 * layout underneath it stays the same.
 */
/**
 * The project a spec belongs to: the nearest folder, from the spec's own up, that holds a
 * `config.yaml` or a `plain_modules` - where its code is built, its config read, its testing
 * scripts found. Without either, the spec's own folder. So `plain/hubspot.plain`, beside
 * `plain/config.yaml` and `plain/plain_modules`, is built there, wherever plainwright was started;
 * specs at the root of their project are built where they always were.
 */
export function projectDirOf(plainFile: string): string {
  const start = dirname(resolve(plainFile));
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "config.yaml")) || existsSync(join(dir, MODULES_DIR))) return dir;
    if (dirname(dir) === dir) return start;
  }
}

export function modulesRoot(cwd: string = process.cwd()): string {
  return join(cwd, MODULES_DIR);
}

export function buildDirUnder(root: string, moduleName: string): string {
  return join(root, moduleName, "code");
}

export function testsDirUnder(root: string, moduleName: string): string {
  return join(root, moduleName, "tests");
}

/**
 * The `plain_modules` a directory sits in: all an agent sees and all its VM holds. A
 * directory outside one - a sandbox, an explicit `--build-dir` - is its own root, so this
 * never silently widens to a whole disk.
 */
export function modulesRootOf(dir: string): string {
  const parts = resolve(dir).split(sep);
  const index = parts.lastIndexOf(MODULES_DIR);
  return index === -1 ? resolve(dir) : parts.slice(0, index + 1).join(sep);
}

/**
 * `.plainwright` inside the modules root: what the VM needs beside the code - the package
 * caches, the copies test runs and try-it checks happen in, the system packages installed.
 * Inside the root because the VM holds nothing else; ignored by the project's history.
 */
export function vmScratchDir(dir: string): string {
  return join(modulesRootOf(dir), ".plainwright");
}

/** Make `path` inside the VM's scratch, which ignores itself. Returns `path`. */
export function ensureInVmScratch(dir: string, path: string): string {
  return ensureInScratch(vmScratchDir(dir), path);
}

/**
 * Where a person tries one functionality: `plain_modules/.plainwright/try/<module>/fs-<frid>`.
 *
 * A copy of the build, not the build itself, so trying functionality 2 cannot disturb the
 * render of functionality 3 going on in the build directory - and each functionality keeps
 * its own, so an earlier one can still be tried after later ones land. Inside `plain_modules`
 * because the steps are checked in the VM, which holds nothing else.
 */
export function tryDirFor(buildDir: string, moduleName: string, frid: string): string {
  return join(vmScratchDir(buildDir), "try", moduleName, `fs-${frid}`);
}

/**
 * Where a person tries what the latest spec change built: one copy per module, replaced by
 * each change, beside the per-functionality ones.
 */
export function specChangeTryDirFor(buildDir: string, moduleName: string): string {
  return join(vmScratchDir(buildDir), "try", moduleName, "spec-change");
}

/**
 * The project a directory belongs to: the one `plain_modules` sits in, when the directory is
 * inside it; otherwise the directory's parent for a build folder, or the directory itself.
 */
export function projectRootOf(dir: string): string {
  const parts = resolve(dir).split(sep);
  const index = parts.lastIndexOf(MODULES_DIR);
  return index === -1 ? resolve(dir) : parts.slice(0, index).join(sep);
}

/**
 * `.plainwright` in the project: the harness's own scratch space - copies to try things in,
 * saved agent sessions. Never part of the project's history, so it ignores itself.
 */
export function scratchDir(dir: string): string {
  const parts = resolve(dir).split(sep);
  const index = parts.lastIndexOf(MODULES_DIR);
  const project = index === -1 ? dirname(resolve(dir)) : parts.slice(0, index).join(sep);
  return join(project, ".plainwright");
}

/**
 * Where a skill run keeps its state - the manifest an interrupted run resumes from, the evidence
 * each phase's gate is judged on: `.plainwright/runs/<skill>` in the project, beside the rest of
 * plainwright's scratch, ignored by the project's history like it.
 *
 * Runs were kept in `.forge/run` before. One found there is moved here, so an interrupted
 * interview can still be resumed, and `.forge` goes once nothing is left in it.
 */
export function skillRunDir(cwd: string, skillName: string): string {
  const scratch = join(resolve(cwd), ".plainwright");
  const dir = join(scratch, "runs", skillName);
  const legacy = join(resolve(cwd), ".forge", "run", skillName);
  if (!existsSync(dir) && existsSync(legacy)) {
    mkdirSync(dirname(dir), { recursive: true });
    renameSync(legacy, dir);
  }
  for (const empty of [join(resolve(cwd), ".forge", "run"), join(resolve(cwd), ".forge")]) {
    try {
      if (existsSync(empty) && readdirSync(empty).length === 0) rmdirSync(empty);
    } catch {
      // Left as it is: a folder that cannot be removed does no harm.
    }
  }
  return ensureInScratch(scratch, dir);
}

/** Make `path`, inside a scratch dir, and see that the scratch dir ignores itself. Returns `path`. */
export function ensureInScratch(scratch: string, path: string): string {
  mkdirSync(path, { recursive: true });
  const ignore = join(scratch, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  return path;
}

/** Where agent sessions are saved, so what an agent did can be read - and resumed - later. */
export function sessionsDir(project: string): string {
  const scratch = scratchDir(join(project, MODULES_DIR));
  return ensureInScratch(scratch, join(scratch, "sessions"));
}
