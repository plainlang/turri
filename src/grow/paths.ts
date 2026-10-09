import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The ***plain standard library: import modules for generic pieces of software that ship with turri,
 * imported as `stdlib/backend/python-fastapi` - a reserved name (see plain/stdlib.ts).
 */
export const STDLIB_DIR = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "stdlib");

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

/**
 * The directory every module's output hangs off, `plain_modules` by default.
 *
 * Callers override this to build somewhere else - a sandbox, a test fixture - and the
 * layout underneath it stays the same.
 */
/**
 * The project a spec belongs to: the nearest folder, from the spec's own up, that holds a
 * `config.yaml`, a module's own `config.<module>.yaml` or a `plain_modules` - where its code is
 * built, its config read, its testing scripts found. Without any, the spec's own folder. So `plain/hubspot.plain`, beside
 * `plain/config.yaml` and `plain/plain_modules`, is built there, wherever turri was started;
 * specs at the root of their project are built where they always were.
 */
export function projectDirOf(plainFile: string): string {
  const start = dirname(resolve(plainFile));
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "config.yaml")) || existsSync(join(dir, MODULES_DIR)) || hasModuleConfig(dir)) return found(dir);
    if (dirname(dir) === dir) return found(start);
  }
}

/** Hooks run on a project the first time it is found: its files brought over from the names turri had before. */
const onProject: Array<(dir: string) => void> = [];

/** Run `hook` on every project found from now on (see grow/migrate.ts). */
export function whenProjectFound(hook: (dir: string) => void): void {
  onProject.push(hook);
}

function found(dir: string): string {
  for (const hook of onProject) hook(dir);
  return dir;
}

/** Whether a folder holds a module's own config file - config.<module>.yaml - which makes it a project too. */
function hasModuleConfig(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => /^config\..+\.yaml$/.test(name));
  } catch {
    return false;
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
 * The `plain_modules` a directory sits in: what holds every module's code and tests. A
 * directory outside one - a sandbox, an explicit `--build-dir` - is its own root, so this
 * never silently widens to a whole disk.
 */
export function modulesRootOf(dir: string): string {
  const parts = resolve(dir).split(sep);
  const index = parts.lastIndexOf(MODULES_DIR);
  return index === -1 ? resolve(dir) : parts.slice(0, index + 1).join(sep);
}

/**
 * `.turri` inside the modules root: what turri keeps beside the code - the package
 * caches, the modules' homes and temporary folders, the copies test runs happen in, the
 * outputs kept for read_output. Ignored by the project's history.
 */
export function modulesScratchDir(dir: string): string {
  return join(modulesRootOf(dir), ".turri");
}

/** Make `path` inside the modules' scratch, which ignores itself. Returns `path`. */
export function ensureInModulesScratch(dir: string, path: string): string {
  return ensureInScratch(modulesScratchDir(dir), path);
}

/** Where the project keeps what `deploy` puts out: `dist/`, beside `plain_modules`. */
export const DIST_DIR = "dist";

/**
 * Where a person tries a module: `<project>/dist/<module>`, the module's code as its last commit has
 * it. Outside `plain_modules`, so no agent can reach it, and replaced whole by every deploy.
 */
export function distDirFor(projectDir: string, moduleName: string): string {
  return join(projectDir, DIST_DIR, moduleName);
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
 * `.turri` in the project: the harness's own scratch space - copies to try things in,
 * saved agent sessions. Never part of the project's history, so it ignores itself - but for `skills/`, the
 * project's own skills.
 */
export function scratchDir(dir: string): string {
  const parts = resolve(dir).split(sep);
  const index = parts.lastIndexOf(MODULES_DIR);
  const project = index === -1 ? dirname(resolve(dir)) : parts.slice(0, index).join(sep);
  return join(project, ".turri");
}

/**
 * Where a skill run keeps its state - the manifest an interrupted run resumes from, the evidence
 * each phase's gate is judged on: `.turri/runs/<skill>` in the project, beside the rest of
 * turri's scratch, ignored by the project's history like it.
 *
 * Runs were kept in `.forge/run` before. One found there is moved here, so an interrupted
 * interview can still be resumed, and `.forge` goes once nothing is left in it.
 */
export function skillRunDir(cwd: string, skillName: string): string {
  const scratch = join(resolve(cwd), ".turri");
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

/**
 * What the scratch dir's .gitignore says: everything in it is ignored but `skills/` - the project's own skills
 * (skills.ts), which are written by hand and kept in its history.
 */
export const SCRATCH_IGNORE = "*\n!skills/\n!skills/**\n";

/** Make `path`, inside a scratch dir, and see that the scratch dir ignores itself, its skills apart. Returns `path`. */
export function ensureInScratch(scratch: string, path: string): string {
  mkdirSync(path, { recursive: true });
  const ignore = join(scratch, ".gitignore");
  // One written before skills were kept here ignored them too: it is brought up to date.
  if (!existsSync(ignore) || readFileSync(ignore, "utf8") === "*\n") writeFileSync(ignore, SCRATCH_IGNORE);
  return path;
}

/** Where agent sessions are saved, so what an agent did can be read - and resumed - later. */
export function sessionsDir(project: string): string {
  const scratch = scratchDir(join(project, MODULES_DIR));
  return ensureInScratch(scratch, join(scratch, "sessions"));
}

/**
 * Template search order, matching file_utils.get_template_directories: the plain file's
 * own directory first, then a sibling `template/` directory if there is one (where a
 * project keeps its import modules), then anything passed in, then PLAIN_TEMPLATE_DIRS.
 * A `stdlib/...` import is not looked for in them: it is turri's (see plain/stdlib.ts).
 */
export function resolveTemplateDirs(plainFile: string, extra: string[] = []): string[] {
  const own = dirname(resolve(plainFile));
  const dirs = [own];

  const sibling = join(own, "template");
  if (existsSync(sibling)) dirs.push(sibling);

  dirs.push(...extra.map((dir) => resolve(dir)));

  const fromEnv = process.env.PLAIN_TEMPLATE_DIRS;
  if (fromEnv) dirs.push(...fromEnv.split(":").filter(Boolean).map((dir) => resolve(dir)));

  return [...new Set(dirs)];
}
