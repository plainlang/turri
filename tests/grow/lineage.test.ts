import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { abandonWork, diffSinceSnapshot, head, historyLog, historyShow, markWork, recordHistory, resetToLastCommit, startWork, workDiff, workSnapshot } from "../../src/grow/lineage.ts";
import { copyRequiredCode } from "../../src/grow/requires.ts";

let root: string;
let code: string;
const tracked = (moduleDir: string) =>
  spawnSync("git", ["--git-dir", join(moduleDir, ".plaingit"), "--work-tree", moduleDir, "ls-files"], { encoding: "utf8" })
    .stdout.trim()
    .split("\n")
    .filter(Boolean);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "turri-history-")));
  code = join(root, "plain_modules", "app", "code");
  mkdirSync(code, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("a module's history", () => {
  it("commits what a step changed, and nothing when it changed nothing", () => {
    writeFileSync(join(code, "app.py"), "print(1)\n");
    const first = recordHistory(code, "render app fs 1: hello (unit tests pass)");
    expect(first).toMatch(/^[0-9a-f]+$/);
    expect(recordHistory(code, "nothing happened")).toBeUndefined();

    writeFileSync(join(code, "app.py"), "print(2)\n");
    recordHistory(code, "render app fs 2: more (unit tests pass)");
    expect(historyLog(code).split("\n").map((line) => line.split("  ").at(-1))).toEqual([
      "render app fs 2: more (unit tests pass)",
      "render app fs 1: hello (unit tests pass)",
    ]);
    expect(historyShow(code, head(code)!)).toContain("+print(2)");
  });

  it("keeps the code and tests, and leaves out its own git directory, dependencies and caches", () => {
    writeFileSync(join(code, "app.py"), "x\n");
    mkdirSync(join(code, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(code, "node_modules", "left-pad", "index.js"), "x\n");
    mkdirSync(join(code, "__pycache__"));
    writeFileSync(join(code, "__pycache__", "app.cpython.pyc"), "x");
    mkdirSync(join(root, "plain_modules", "app", "tests"));
    writeFileSync(join(root, "plain_modules", "app", "tests", "test_app.sh"), "exit 0\n");
    recordHistory(code, "render");
    expect(tracked(join(root, "plain_modules", "app")).sort()).toEqual(["code/app.py", "tests/test_app.sh"]);
  });

  it("is kept out of the project's own repository", () => {
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".gitignore"), "node_modules/");
    writeFileSync(join(code, "app.py"), "x\n");
    recordHistory(code, "render");
    recordHistory(code, "render");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("node_modules/\nplain_modules/**/.plaingit/\n");
  });

  it("does not touch a project that is not a git repository", () => {
    writeFileSync(join(code, "app.py"), "x\n");
    recordHistory(code, "render");
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
  });
});

describe("history as the chain is built", () => {
  it("starts a module's history from the module below, naming its commit", () => {
    writeFileSync(join(code, "app.py"), "print('base')\n");
    const base = recordHistory(code, "render app fs 1");
    const next = join(root, "plain_modules", "next", "code");

    copyRequiredCode(code, next, "next", "app");

    expect(historyLog(next)).toContain(`start from app at ${base}`);
  });
});

describe("starting from the last commit", () => {
  it("puts back what an interrupted run left half-written, and keeps installed dependencies", () => {
    const tests = join(root, "plain_modules", "app", "tests");
    mkdirSync(tests, { recursive: true });
    writeFileSync(join(code, "app.py"), "print('hi')\n");
    writeFileSync(join(tests, "test_app.py"), "assert True\n");
    recordHistory(code, "render app fs 1");

    // The run that was cut short: a file half-rewritten, one half-added, one deleted.
    writeFileSync(join(code, "app.py"), "print('h");
    writeFileSync(join(code, "half.py"), "def half(");
    mkdirSync(join(code, "new_pkg"));
    writeFileSync(join(code, "new_pkg", "mod.py"), "x = 1\n");
    rmSync(join(tests, "test_app.py"));
    // And what history never tracks: installed dependencies.
    mkdirSync(join(code, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(code, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");

    const undone = resetToLastCommit(code);

    expect(undone.sort()).toEqual(["code/app.py", "code/half.py", "code/new_pkg/mod.py", "tests/test_app.py"]);
    expect(readFileSync(join(code, "app.py"), "utf8")).toBe("print('hi')\n");
    expect(existsSync(join(code, "half.py"))).toBe(false);
    expect(existsSync(join(code, "new_pkg"))).toBe(false);
    expect(readFileSync(join(tests, "test_app.py"), "utf8")).toBe("assert True\n");
    expect(existsSync(join(code, "node_modules", "left-pad", "index.js"))).toBe(true);
  });

  it("does nothing when everything is committed", () => {
    writeFileSync(join(code, "app.py"), "print('hi')\n");
    recordHistory(code, "render app fs 1");
    expect(resetToLastCommit(code)).toEqual([]);
  });

  it("leaves a module with no history alone - there is no good state to go back to", () => {
    writeFileSync(join(code, "app.py"), "print('hi')\n");
    expect(resetToLastCommit(code)).toEqual([]);
    expect(readFileSync(join(code, "app.py"), "utf8")).toBe("print('hi')\n");
  });
});

describe("a unit of work", () => {
  const moduleDir = () => join(root, "plain_modules", "app");
  const commits = () => historyLog(code).split("\n").length;

  it("starts from a commit even in a module that has none: what is there, as found - or nothing", () => {
    writeFileSync(join(code, "app.py"), "print('found')\n");
    const start = startWork([code], "app");
    expect(start.modules).toEqual([{ moduleDir: moduleDir(), commit: expect.stringMatching(/^[0-9a-f]{40}$/) }]);
    expect(tracked(moduleDir())).toEqual(["code/app.py"]);
    expect(historyLog(code)).toContain("the module as turri found it");

    const empty = join(root, "plain_modules", "fresh", "code");
    expect(startWork([empty], "fresh").modules).toHaveLength(1);
    expect(historyLog(empty)).toContain("the module as turri found it");
  });

  it("starts by putting back what an interrupted run left, and keeps what history does not track", () => {
    writeFileSync(join(code, "app.py"), "print('hi')\n");
    recordHistory(code, "render app fs 1");
    writeFileSync(join(code, "app.py"), "print('h");
    writeFileSync(join(code, "half.py"), "def half(");
    mkdirSync(join(code, ".venv"), { recursive: true });
    writeFileSync(join(code, ".venv", "installed"), "x");

    startWork([code], "app");
    expect(readFileSync(join(code, "app.py"), "utf8")).toBe("print('hi')\n");
    expect(existsSync(join(code, "half.py"))).toBe(false);
    expect(existsSync(join(code, ".venv", "installed"))).toBe(true);
  });

  it("that fails is undone whole: its changes, its new files and the commits it made - not the dependencies", () => {
    writeFileSync(join(code, "app.py"), "print('before')\n");
    recordHistory(code, "render app fs 1");
    const before = commits();
    const start = startWork([code, join(moduleDir(), "tests")], "app");

    // The work: a commit on the way, then more changes, a new file, a test.
    writeFileSync(join(code, "app.py"), "print('during')\n");
    recordHistory(code, "render app fs 2");
    writeFileSync(join(code, "app.py"), "print('later')\n");
    writeFileSync(join(code, "extra.py"), "x = 1\n");
    mkdirSync(join(moduleDir(), "tests"), { recursive: true });
    writeFileSync(join(moduleDir(), "tests", "test_new.py"), "assert True\n");
    mkdirSync(join(code, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(code, "node_modules", "dep", "index.js"), "1\n");

    abandonWork(start, "app", "it failed");

    expect(readFileSync(join(code, "app.py"), "utf8")).toBe("print('before')\n");
    expect(existsSync(join(code, "extra.py"))).toBe(false);
    expect(existsSync(join(moduleDir(), "tests", "test_new.py"))).toBe(false);
    expect(commits()).toBe(before);
    expect(existsSync(join(code, "node_modules", "dep", "index.js"))).toBe(true);
  });

  it("under way is marked without putting anything back - what is uncommitted belongs to it", () => {
    writeFileSync(join(code, "app.py"), "print('committed')\n");
    recordHistory(code, "render app fs 1");
    writeFileSync(join(code, "app.py"), "print('in progress')\n");
    const mark = markWork([code]);
    expect(readFileSync(join(code, "app.py"), "utf8")).toBe("print('in progress')\n");
    // Undoing from the mark goes back to the commit it was at.
    abandonWork(mark, "app", "it failed");
    expect(readFileSync(join(code, "app.py"), "utf8")).toBe("print('committed')\n");
  });

  it("with nothing to undo leaves the module alone", () => {
    writeFileSync(join(code, "app.py"), "print('hi')\n");
    const start = startWork([code], "app");
    abandonWork(start, "app", "it failed");
    abandonWork(undefined, "app", "nothing started");
    expect(readFileSync(join(code, "app.py"), "utf8")).toBe("print('hi')\n");
  });

  it("gives the work's diff from the last commit - files changed and new ones whole, relative to the folder, lockfiles and its own files left out", () => {
    writeFileSync(join(code, "app.py"), "print('before')\n");
    writeFileSync(join(code, "old.py"), "gone = 1\n");
    recordHistory(code, "render app fs 1");
    writeFileSync(join(code, "app.py"), "print('after')\n");
    rmSync(join(code, "old.py"));
    mkdirSync(join(code, "src"));
    writeFileSync(join(code, "src", "new.py"), "def added(): return 2\n");
    writeFileSync(join(code, "package-lock.json"), "{}\n");
    writeFileSync(join(code, ".turri-notes.md"), "notes\n");
    const diff = workDiff(code);
    expect(diff).toContain("diff --git a/app.py b/app.py");
    expect(diff).toContain("-print('before')\n+print('after')");
    expect(diff).toContain("-gone = 1");
    expect(diff).toContain("b/src/new.py");
    expect(diff).toContain("+def added(): return 2");
    expect(diff).not.toContain("package-lock");
    expect(diff).not.toContain("notes");
    expect(diff).not.toContain("code/");
    recordHistory(code, "render app fs 2");
    expect(workDiff(code)).toBe("");
  });
});

describe("what changed since a review", () => {
  it("is only what the work changed since the snapshot - not the rest of the work, and never the module's index", () => {
    writeFileSync(join(code, "app.py"), "print('one')\n");
    recordHistory(code, "render app fs 1");
    writeFileSync(join(code, "app.py"), "print('two')\n");
    writeFileSync(join(code, "extra.py"), "x = 1\n");
    const seen = workSnapshot(code)!;
    expect(seen).toMatch(/^[0-9a-f]{40}$/);
    expect(diffSinceSnapshot(code, seen)).toBe("");

    writeFileSync(join(code, "extra.py"), "x = 2\n");
    writeFileSync(join(code, "new.py"), "y = 1\n");
    const since = diffSinceSnapshot(code, seen);
    expect(since).toContain("-x = 1\n+x = 2");
    expect(since).toContain("+y = 1");
    // What changed before the snapshot is not in it.
    expect(since).not.toContain("print('two')");
    // The whole work is still what the work changed since the last commit.
    expect(workDiff(code)).toContain("print('two')");
    // Nothing was staged for the next commit.
    const staged = spawnSync("git", ["--git-dir", join(root, "plain_modules", "app", ".plaingit"), "--work-tree", join(root, "plain_modules", "app"), "diff", "--cached", "--name-only"], { encoding: "utf8" }).stdout.trim();
    expect(staged).toBe("");
  });

  it("leaves out the harness's files and lockfiles, as the whole work's diff does", () => {
    writeFileSync(join(code, "app.py"), "print('one')\n");
    recordHistory(code, "render app fs 1");
    const seen = workSnapshot(code)!;
    writeFileSync(join(code, "package-lock.json"), "{}\n");
    writeFileSync(join(code, ".turri-notes.md"), "- notes\n");
    expect(diffSinceSnapshot(code, seen)).toBe("");
  });
});
