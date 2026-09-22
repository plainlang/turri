import { dirname, join, resolve, sep } from "node:path";

/**
 * Where a module's generated code and tests live.
 *
 * Everything a module produces sits under `plain_modules/<module>/`, next to the specs it
 * came from and inside the project's own repository: `code/` holds the implementation and
 * its unit tests, `tests/<frid>/` the black-box conformance tests for one functionality.
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
  const parts = resolve(buildDir).split(sep);
  const index = parts.lastIndexOf(MODULES_DIR);
  const project = index === -1 ? dirname(resolve(buildDir)) : parts.slice(0, index).join(sep);
  return join(project, ".plainwright", "try", moduleName, `fs-${frid}`);
}
