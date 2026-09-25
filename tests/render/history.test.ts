import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { head, historyLog, historyShow, recordHistory, resetToLastCommit } from "../../src/render/history.ts";
import { ensureRegressionPasses } from "../../src/render/module.ts";
import { copyRequiredCode } from "../../src/render/requires.ts";
import { readState, recordFunctionality } from "../../src/render/state.ts";

let root: string;
let code: string;
const tracked = (moduleDir: string) =>
  spawnSync("git", ["--git-dir", join(moduleDir, ".plaingit"), "--work-tree", moduleDir, "ls-files"], { encoding: "utf8" })
    .stdout.trim()
    .split("\n")
    .filter(Boolean);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "plainwright-history-")));
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

    copyRequiredCode(code, next, "next");

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
