import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { head, historyLog, historyShow, recordHistory } from "../../src/render/history.ts";
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

describe("the conformance command", () => {
  it("is recorded by a passing run of the whole suite", async () => {
    recordFunctionality(code, "app", { frid: "1", specHash: "", spec: "- One.", unitTests: "passed" });
    const tests = join(root, "plain_modules", "app", "tests");
    mkdirSync(tests, { recursive: true });
    writeFileSync(join(tests, "check.sh"), "exit 0\n");

    await ensureRegressionPasses({
      buildDir: code, conformanceRoot: join(root, "plain_modules"), moduleName: "app", frids: ["1"],
      tree: {}, required: [], command: "sh check.sh", maxRounds: 0,
    });

    expect(readState(code)!.conformanceCommand).toBe("sh check.sh");
  });
});
