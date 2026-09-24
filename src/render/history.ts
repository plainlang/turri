import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { reportActivity } from "./activity.ts";
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

/**
 * Put a module back to its last commit before work starts on it.
 *
 * Every step commits what it did, so a module with changes nobody committed is one whose last
 * step never finished - plainwright was stopped or restarted mid-job - and holds half-written
 * code the next render would build on. Its last commit is the last known good state, so the
 * working tree is reset to it: changed files restored, files nothing committed removed. What
 * history does not track stays - installed dependencies, caches - so nothing needs installing
 * again. A module with no history yet has no good state to go back to and is left alone.
 *
 * Returns the paths that were put back or removed, relative to the module folder.
 */
export function resetToLastCommit(dir: string): string[] {
  try {
    const moduleDir = moduleDirOf(dir);
    if (!existsSync(join(moduleDir, HISTORY_DIR)) || head(dir) === undefined) return [];
    const status = git(moduleDir, ["status", "--porcelain", "--untracked-files=all"]);
    if (status.status !== 0) return [];
    const changed = status.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => line.slice(3));
    if (changed.length === 0) return [];
    git(moduleDir, ["reset", "-q", "--hard", "HEAD"]);
    git(moduleDir, ["clean", "-q", "-fd"]);
    return changed;
  } catch {
    return [];
  }
}

/**
 * The start of every step that writes a module's code or tests: back to its last commit, and
 * say so when that undid anything.
 */
export function startFromLastCommit(dir: string, moduleName: string): void {
  const undone = resetToLastCommit(dir);
  if (undone.length === 0) return;
  const shown = undone.slice(0, 5).join(", ");
  reportActivity(
    `${moduleName}: back to its last commit - ${undone.length} change${undone.length === 1 ? "" : "s"} an unfinished ` +
      `run left behind undone (${shown}${undone.length > 5 ? ", …" : ""})`,
  );
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
