import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { projectRootOf } from "./paths.ts";

/**
 * Version history for each module's generated code and tests.
 *
 * A module folder - `plain_modules/<module>`, holding `code/` and `tests/` - is a git
 * repository whose git directory is `.plaingit` rather than `.git`. Everything git does
 * works as usual; the name is what keeps it from being an embedded repository inside the
 * project's own, so the generated code stays plain files to the outer repo. Only the harness
 * writes it: the agents' fences cover `code/` and `tests/`, and `.plaingit` sits beside them.
 *
 * A commit is made after every step that changes the module - a render, a regeneration, a
 * conformance run, a regression repair, a spec change, a start from the module below - with
 * a message saying what it was. History is a record of the work, never a gate on it: a git
 * failure is swallowed, not raised.
 */

export const HISTORY_DIR = ".plaingit";

const AUTHOR = ["-c", "user.name=plainwright", "-c", "user.email=plainwright@localhost", "-c", "commit.gpgsign=false"];

/**
 * Kept out of history: the history itself - git skips only a folder named `.git` on its own -
 * installed dependencies, and caches.
 */
const EXCLUDED = [`/${HISTORY_DIR}/`, ".plainwright/", "node_modules/", ".venv/", "venv/", "__pycache__/", "*.pyc", ".pytest_cache/", ".mypy_cache/", ".ruff_cache/", ".DS_Store"];

function git(moduleDir: string, args: string[], input?: string) {
  return spawnSync("git", [...AUTHOR, "--git-dir", join(moduleDir, HISTORY_DIR), "--work-tree", moduleDir, ...args], {
    cwd: moduleDir,
    encoding: "utf8",
    input,
  });
}

/** The module folder a build or tests directory belongs to. */
export function moduleDirOf(dir: string): string {
  return dirname(dir);
}

/** Keep the project's own repository from committing the history's objects. */
function ignoreInProject(moduleDir: string): void {
  const root = projectRootOf(moduleDir);
  if (!existsSync(join(root, ".git"))) return;
  const ignore = join(root, ".gitignore");
  const pattern = `plain_modules/**/${HISTORY_DIR}/`;
  const current = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  if (current.split("\n").some((line) => line.trim() === pattern)) return;
  appendFileSync(ignore, `${current === "" || current.endsWith("\n") ? "" : "\n"}${pattern}\n`);
}

function ensureHistory(moduleDir: string): boolean {
  const gitDir = join(moduleDir, HISTORY_DIR);
  if (existsSync(gitDir)) return true;
  mkdirSync(moduleDir, { recursive: true });
  if (git(moduleDir, ["init", "-q"]).status !== 0) return false;
  mkdirSync(join(gitDir, "info"), { recursive: true });
  writeFileSync(join(gitDir, "info", "exclude"), `${EXCLUDED.join("\n")}\n`);
  ignoreInProject(moduleDir);
  return true;
}

/**
 * Commit whatever the step changed in the module folder that `dir` - its build or its tests
 * directory - belongs to. Nothing changed, nothing is committed. Returns the commit, if any.
 */
export function recordHistory(dir: string, subject: string, body?: string): string | undefined {
  try {
    const moduleDir = moduleDirOf(dir);
    if (!existsSync(moduleDir) || !ensureHistory(moduleDir)) return undefined;
    git(moduleDir, ["add", "-A"]);
    if (git(moduleDir, ["diff", "--cached", "--quiet"]).status === 0) return undefined;
    const message = body ? `${subject}\n\n${body.trim()}\n` : subject;
    if (git(moduleDir, ["commit", "-q", "-F", "-"], message).status !== 0) return undefined;
    return head(dir);
  } catch {
    return undefined;
  }
}

/** The current commit of a module's history, if it has one. */
export function head(dir: string): string | undefined {
  const moduleDir = moduleDirOf(dir);
  if (!existsSync(join(moduleDir, HISTORY_DIR))) return undefined;
  const result = git(moduleDir, ["rev-parse", "--short", "HEAD"]);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** The module's history, newest first, one line per commit. */
export function historyLog(dir: string, limit = 30): string {
  const moduleDir = moduleDirOf(dir);
  if (!existsSync(join(moduleDir, HISTORY_DIR))) return `No history for ${basename(moduleDir)} yet.`;
  const result = git(moduleDir, ["log", `-${limit}`, "--format=%h  %ad  %s", "--date=format:%Y-%m-%d %H:%M"]);
  return result.status === 0 && result.stdout.trim() !== "" ? result.stdout.trimEnd() : `No history for ${basename(moduleDir)} yet.`;
}

/** One commit in full: its message and what it changed. */
export function historyShow(dir: string, commit: string): string {
  const moduleDir = moduleDirOf(dir);
  const result = git(moduleDir, ["show", "--stat", "--patch", "--format=%h %ad%n%n%B", "--date=format:%Y-%m-%d %H:%M", commit]);
  return result.status === 0 ? result.stdout : result.stderr.trim() || `No commit ${commit}.`;
}
