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
const EXCLUDED = [
  `/${HISTORY_DIR}/`,
  ".plainwright/",
  "node_modules/",
  ".venv/",
  "venv/",
  "__pycache__/",
  "*.pyc",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ruff_cache/",
  "target/",
  ".cargo/",
  ".DS_Store",
];

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
 * again. A module with no commit yet has no good state to go back to and is left alone -
 * `startWork` gives it one.
 *
 * Returns the paths that were put back or removed, relative to the module folder.
 */
/**
 * The tests folder's build output too - ignored, so a clean leaves it: reports and classes of tests
 * that are no longer there tell whoever looks that they are. The code's is kept: it can be a cache
 * worth having, and the code is what is built from.
 */
function cleanTestsBuild(moduleDir: string): void {
  if (existsSync(join(moduleDir, "tests"))) git(moduleDir, ["clean", "-q", "-fdX", "--", "tests"]);
}

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
    cleanTestsBuild(moduleDir);
    if (changed.length === 0) return [];
    git(moduleDir, ["reset", "-q", "--hard", "HEAD"]);
    git(moduleDir, ["clean", "-q", "-fd"]);
    return changed;
  } catch {
    return [];
  }
}

/**
 * Where a unit of work started: each module folder it writes, at the commit it was at. A unit
 * either lands whole - committed, its tree recorded - or is undone whole (`abandonWork`), so the
 * code, its tests and the tree they were built from never disagree.
 */
export interface WorkStart {
  modules: Array<{ moduleDir: string; commit: string }>;
}

/** The module's commit, made first when it has none: what is there, as found, or an empty one. */
function ensureCommit(moduleDir: string): string | undefined {
  mkdirSync(moduleDir, { recursive: true });
  if (!ensureHistory(moduleDir)) return undefined;
  const current = git(moduleDir, ["rev-parse", "HEAD"]);
  if (current.status === 0) return current.stdout.trim();
  git(moduleDir, ["add", "-A"]);
  git(moduleDir, ["commit", "-q", "--allow-empty", "-m", "the module as plainwright found it"]);
  const made = git(moduleDir, ["rev-parse", "HEAD"]);
  return made.status === 0 ? made.stdout.trim() : undefined;
}

/**
 * The start of every unit of work that writes a module's code or tests: each module folder it
 * writes back at its last commit - saying so when that undid anything - and that commit kept, to
 * go back to if the work fails. A module with no commit yet is given one first, so there always
 * is one.
 */
export function startWork(dirs: string[], moduleName: string): WorkStart {
  const modules: WorkStart["modules"] = [];
  for (const moduleDir of [...new Set(dirs.map(moduleDirOf))]) {
    try {
      const commit = ensureCommit(moduleDir);
      if (commit === undefined) continue;
      const undone = resetToLastCommit(join(moduleDir, "code"));
      if (undone.length > 0) {
        const shown = undone.slice(0, 5).join(", ");
        reportActivity(
          `${moduleName}: back to its last commit - ${undone.length} change${undone.length === 1 ? "" : "s"} an unfinished ` +
            `run left behind undone (${shown}${undone.length > 5 ? ", …" : ""})`,
        );
      }
      modules.push({ moduleDir, commit });
    } catch {
      // History is a record, not a gate: without it, the work goes on.
    }
  }
  return { modules };
}

/**
 * Where work already under way is now, to go back to if what comes next fails - without
 * putting anything back first: what is uncommitted belongs to the work that is under way.
 */
export function markWork(dirs: string[]): WorkStart {
  const modules: WorkStart["modules"] = [];
  for (const moduleDir of [...new Set(dirs.map(moduleDirOf))]) {
    try {
      const commit = ensureCommit(moduleDir);
      if (commit !== undefined) modules.push({ moduleDir, commit });
    } catch {
      // History is a record, not a gate.
    }
  }
  return { modules };
}

/** The same, for one directory - the start of a step that writes only there. */
export function startFromLastCommit(dir: string, moduleName: string): WorkStart {
  return startWork([dir], moduleName);
}

/**
 * Undo a unit of work that failed: every module folder it wrote back at the commit it started
 * from - its changes, the files it added and any commit it made since, gone. What history does
 * not track stays: installed dependencies, caches.
 */
export function abandonWork(start: WorkStart | undefined, moduleName: string, why: string): void {
  for (const { moduleDir, commit } of start?.modules ?? []) {
    try {
      const moved = git(moduleDir, ["rev-parse", "HEAD"]).stdout.trim() !== commit;
      const status = git(moduleDir, ["status", "--porcelain", "--untracked-files=all"]).stdout.trim();
      if (!moved && status === "") continue;
      git(moduleDir, ["reset", "-q", "--hard", commit]);
      git(moduleDir, ["clean", "-q", "-fd"]);
      cleanTestsBuild(moduleDir);
      reportActivity(`${moduleName}: ${why} - ${basename(moduleDir)} is back where the work started`);
    } catch {
      // Nothing to undo with.
    }
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
