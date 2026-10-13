import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFORMANCE_SCRIPT, writeTestScripts } from "../test-scripts.ts";

/**
 * The static checks a unit testing script runs with its tests, with real scripts on this machine. The script is a
 * stand-in for one that formats, lints and type checks: it runs the tests, then reports every `BAD` as a finding, a line
 * each, and exits 80 when the tests passed and only the checks did not. The coding agent is stubbed: what it writes on
 * each turn is `turn`, by what it was sent.
 */
type Tool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
type StubSession = { tools: Tool[] };
const prompts: string[] = [];
let toolNames: string[] = [];
let task = "";
/** What the agent writes, given what it was sent: file contents by path, or nothing. */
let turn: (prompt: string) => Record<string, string> | undefined = () => undefined;

vi.mock("../../src/pi.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pi.ts")>();
  return {
    ...actual,
    createExecutor: async (opts: { customTools: Tool[]; tools?: string[]; task?: string }) => {
      if (opts.tools?.includes("run_unit_tests")) {
        toolNames = opts.tools;
        task = opts.task ?? "";
      }
      return { tools: opts.customTools, dispose() {} };
    },
    ask: vi.fn(async (session: StubSession, prompt: string) => {
      const review = session.tools.find((candidate) => candidate.name === "submit_review");
      if (review !== undefined) return (await review.execute("id", { pass: true, problems: [] }), "Reviewed.");
      prompts.push(prompt);
      for (const [path, content] of Object.entries(turn(prompt) ?? {})) {
        await session.tools.find((candidate) => candidate.name === "write")!.execute("id", { path, content });
      }
      return "Done.";
    }),
  };
});

const { BEGIN } = await import("../../src/pi.ts");
const { renderSpecDiff, describeSpecDiff } = await import("../../src/grow/regenerate.ts");
const { STATIC_CHECKS_FAILED } = await import("../../src/grow/test-scripts.ts");
const MAX_FOLLOW_UPS = (await import("../../src/grow/stop-report.ts")).ATTEMPTS["unit tests"];

/** Runs the tests, then the checks - every `BAD` a finding - and exits 80 when only the checks failed. */
const CHECKING_UNIT_SCRIPT = [
  "#!/bin/bash",
  'WORKING_FOLDER="$(mktemp -d)" && trap \'rm -rf "$WORKING_FOLDER"\' EXIT',
  'cp -R "$1"/. "$WORKING_FOLDER" && cd "$WORKING_FOLDER" || exit 2',
  "python3 -m unittest discover",
  "tests=$?",
  "grep -n 'BAD' $(find . -name '*.py' | sort) /dev/null | sed 's/^\\.\\///; s/^\\([^:]*:[0-9]*\\):.*/\\1: error: BAD is not allowed/' | grep . && checks=1 || checks=0",
  '[ "$tests" -ne 0 ] && exit "$tests"',
  `[ "$checks" -ne 0 ] && exit ${80}`,
  "exit 0",
  "",
].join("\n");

const PASSING_TEST = "import unittest\nfrom app import value\n\nclass AppTest(unittest.TestCase):\n    def test_value(self):\n        self.assertEqual(value(), 1)\n";

let dir: string;
let cwd: string;
const plain = (fs: string[]) => `***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n${fs.join("\n\n")}\n`;
const diff = ["diff --git a/app.plain b/app.plain", "--- a/app.plain", "+++ b/app.plain", "@@ -6 +6,3 @@", " - One.", "+", "+- Two.", ""].join("\n");
/** What the agent was sent about its work: its notes turns, which come once it passed, left out. */
const work = () => prompts.filter((prompt) => !prompt.includes("call update_notes"));
const code = (file: string) => join(dir, "plain_modules", "app", "code", file);
const render = () => renderSpecDiff({ plainFile: "app.plain", diff, cwd: dir });

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "turri-static-")));
  cwd = process.cwd();
  process.chdir(dir);
  prompts.length = 0;
  toolNames = [];
  task = "";
  turn = () => undefined;
  writeTestScripts(dir, { unit: CHECKING_UNIT_SCRIPT, conformance: CONFORMANCE_SCRIPT });
  writeFileSync(join(dir, "config.yaml"), "testing-scripts-run-on: in-place\n");
  writeFileSync(join(dir, "app.plain"), plain(["- One."]));
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

describe("the static checks a unit testing script runs", () => {
  it("are the script's own: the coding agent has no tool of their own, and is told the formatting is its to run", async () => {
    expect(STATIC_CHECKS_FAILED).toBe(80);
    turn = (prompt) => (prompt === BEGIN ? { "app.py": "def value():\n    return 1\n", "test_app.py": PASSING_TEST } : undefined);
    const result = await render();
    expect(result.passed).toBe(true);
    expect(toolNames).not.toContain("run_static_checks");
    expect(task).toContain("exit 80 means the tests passed and only the checks did not");
    expect(task).toContain("Formatting is yours");
  });

  it("send the agent back saying the tests pass and only the checks do not, with the findings", async () => {
    turn = (prompt) => {
      if (prompt === BEGIN) return { "app.py": "def value():\n    return 1  # BAD\n", "test_app.py": PASSING_TEST };
      return { "app.py": "def value():\n    return 1\n" };
    };
    const result = await render();
    expect(result.passed).toBe(true);
    expect(work()).toHaveLength(2);
    expect(work()[1]).toContain("Exit 80: the tests pass, and the script's static checks");
    expect(work()[1]).toContain("app.py:2: error: BAD is not allowed");
  });

  it("count as the tests do: never clean within the rounds, the work is rolled back, saying it was the static checks", async () => {
    turn = (prompt) => (prompt === BEGIN ? { "app.py": "def value():\n    return 1  # BAD\n", "test_app.py": PASSING_TEST } : undefined);
    const result = await render();
    expect(result.passed).toBe(false);
    expect(result.staticChecks).toBe(true);
    expect(work().filter((prompt) => prompt.includes("BAD is not allowed"))).toHaveLength(MAX_FOLLOW_UPS);
    expect(existsSync(code("app.py"))).toBe(false);
    expect(describeSpecDiff(result)).toContain("its unit tests passed, but the static checks the unit testing script runs with them");
  }, 60_000);

  it("are not mistaken for the checks when the tests themselves fail", async () => {
    const failing = PASSING_TEST.replace("assertEqual(value(), 1)", "assertEqual(value(), 2)");
    turn = (prompt) => {
      if (prompt === BEGIN) return { "app.py": "def value():\n    return 1  # BAD\n", "test_app.py": failing };
      return { "app.py": "def value():\n    return 1\n", "test_app.py": PASSING_TEST };
    };
    const result = await render();
    expect(result.passed).toBe(true);
    expect(work()[1]).toContain("AssertionError");
    expect(work()[1]).not.toContain("Exit 80");
  });
});
