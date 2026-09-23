import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
 * Where a person tries one functionality: `.plainwright/try/<module>/fs-<frid>`, beside
 * `plain_modules` in the project.
 *
 * A copy of the build, not the build itself, so trying functionality 2 cannot disturb the
 * render of functionality 3 going on in the build directory - and each functionality keeps
 * its own, so an earlier one can still be tried after later ones land. Outside
 * `plain_modules` because it is not part of the codebase.
 */
export function tryDirFor(buildDir: string, moduleName: string, frid: string): string {
  return join(scratchDir(buildDir), "try", moduleName, `fs-${frid}`);
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
