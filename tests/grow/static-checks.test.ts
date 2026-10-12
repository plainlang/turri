import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTestScripts } from "../test-scripts.ts";

/**
 * The static checks as part of the coding agent's unit tests, with real scripts on this machine. The project's static
 * checks script is a stand-in for a formatter and a linter: its fix mode strips trailing spaces from the Python files,
 * and its checks report trailing spaces and every `BAD` as findings, a line each. The coding agent is stubbed: what it
 * writes on each turn is `turns`, by what it was sent.
 */
type Tool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
type StubSession = { tools: Tool[] };
const prompts: string[] = [];
let toolNames: string[] = [];
/** What the agent writes, given what it was sent: file contents by path, or nothing. It may call its tools itself. */
let turn: (prompt: string, tools: Tool[]) => Record<string, string> | undefined | Promise<undefined> = () => undefined;

vi.mock("../../src/pi.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pi.ts")>();
  return {
    ...actual,
    createExecutor: async (opts: { customTools: Tool[]; tools?: string[] }) => {
      if (opts.tools?.includes("run_unit_tests")) toolNames = opts.tools;
      return { tools: opts.customTools, dispose() {} };
    },
    ask: vi.fn(async (session: StubSession, prompt: string) => {
      const review = session.tools.find((candidate) => candidate.name === "submit_review");
      if (review !== undefined) return (await review.execute("id", { pass: true, problems: [] }), "Reviewed.");
      prompts.push(prompt);
      const files = await turn(prompt, session.tools);
      for (const [path, content] of Object.entries(files ?? {})) {
        await session.tools.find((candidate) => candidate.name === "write")!.execute("id", { path, content });
      }
      return "Done.";
    }),
  };
});

const { BEGIN } = await import("../../src/pi.ts");
const { renderSpecDiff, describeSpecDiff } = await import("../../src/grow/regrow.ts");
const { staticFindings, FINDINGS_SHOWN, createUnitGate } = await import("../../src/grow/static-checks.ts");
const MAX_FOLLOW_UPS = (await import("../../src/grow/stop-report.ts")).ATTEMPTS["unit tests"];

const STATIC_SCRIPT = [
  "#!/bin/bash",
  'cd "$1" || exit 2',
  'if [ "${2:-}" = "--fix" ]; then',
  "  for f in $(find . -name '*.py'); do python3 -c 'import sys; p = sys.argv[1]; t = open(p).read(); open(p, \"w\").write(\"\\n\".join(l.rstrip() for l in t.split(\"\\n\")))' \"$f\"; done",
  "  exit 0",
  "fi",
  "status=0",
  "grep -n ' $' $(find . -name '*.py' | sort) /dev/null | sed 's/^\\.\\///; s/^\\([^:]*:[0-9]*\\):.*/\\1: not formatted/' | grep . && status=1",
  "grep -n 'BAD' $(find . -name '*.py' | sort) /dev/null | sed 's/^\\.\\///; s/^\\([^:]*:[0-9]*\\):.*/\\1: error: BAD is not allowed/' | grep . && status=1",
  "exit $status",
  "",
].join("\n");

const PASSING_TEST = "import unittest\nfrom app import value\n\nclass AppTest(unittest.TestCase):\n    def test_value(self):\n        self.assertEqual(value(), 1)\n";
const FAILING_TEST = PASSING_TEST.replace("assertEqual(value(), 1)", "assertEqual(value(), 2)");

let dir: string;
let cwd: string;
const plain = (fs: string[]) => `***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n${fs.join("\n\n")}\n`;
const diff = ["diff --git a/app.plain b/app.plain", "--- a/app.plain", "+++ b/app.plain", "@@ -6 +6,3 @@", " - One.", "+", "+- Two.", ""].join("\n");
/** What the agent was sent about its work: its notes turns, which come once it passed, left out. */
const work = () => prompts.filter((prompt) => !prompt.includes("call update_notes"));
const code = (file: string) => join(dir, "plain_modules", "app", "code", file);
const render = () => renderSpecDiff({ plainFile: "app.plain", diff, cwd: dir });

function project(options: { staticScript?: string; runOn?: "copy" | "in-place" } = {}): void {
  writeTestScripts(dir);
  if (options.staticScript !== undefined) writeFileSync(join(dir, "test_scripts", "run_static_checks_python.sh"), options.staticScript);
  writeFileSync(join(dir, "config.yaml"), `testing-scripts-run-on: ${options.runOn ?? "in-place"}\n`);
  writeFileSync(join(dir, "app.plain"), plain(["- One."]));
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "turri-static-")));
  cwd = process.cwd();
  process.chdir(dir);
  prompts.length = 0;
  toolNames = [];
  turn = () => undefined;
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

describe("a project with no static checks script", () => {
  it("is built on its unit tests alone, as before, and its coding agent is told of no static checks", async () => {
    project();
    turn = (prompt) => (prompt === BEGIN ? { "app.py": "def value():  \n    return 1  # BAD\n", "test_app.py": PASSING_TEST } : undefined);
    const result = await render();
    expect(result.passed).toBe(true);
    expect(work()).toEqual([BEGIN]);
    expect(toolNames).not.toContain("run_static_checks");
    expect(readFileSync(code("app.py"), "utf8")).toBe("def value():  \n    return 1  # BAD\n");
  });
});

describe("the static checks run with the unit tests", () => {
  it.each(["in-place", "copy"] as const)(
    "format the code in place before the tests run, %s - and the work lands formatted once both pass",
    async (runOn) => {
      project({ staticScript: STATIC_SCRIPT, runOn });
      turn = (prompt) => {
        if (prompt === BEGIN) return { "app.py": "def value():   \n    return 1  # BAD\n", "test_app.py": PASSING_TEST };
        if (prompt.startsWith("The unit tests pass, but")) return { "app.py": "def value():   \n    return 1\n" };
        return undefined;
      };
      const result = await render();
      expect(result.passed).toBe(true);
      // The formatting was the harness's: the agent was sent back for the lint alone, never for the trailing spaces.
      const sentBack = work().filter((prompt) => prompt.includes("static checks"));
      expect(sentBack).toHaveLength(1);
      expect(sentBack[0]).toContain("The unit tests pass, but the project's static checks");
      expect(sentBack[0]).toContain("app.py:2: error: BAD is not allowed");
      expect(sentBack[0]).not.toContain("not formatted");
      expect(readFileSync(code("app.py"), "utf8")).toBe("def value():\n    return 1\n");
    },
  );

  it("give the agent the test failures and the static findings in one send-back", async () => {
    project({ staticScript: STATIC_SCRIPT });
    turn = (prompt) => {
      if (prompt === BEGIN) return { "app.py": "def value():\n    return 1  # BAD\n", "test_app.py": FAILING_TEST };
      return { "app.py": "def value():\n    return 1\n", "test_app.py": PASSING_TEST };
    };
    const result = await render();
    expect(result.passed).toBe(true);
    expect(work()).toHaveLength(2);
    expect(work()[1]).toContain("unit testing script");
    expect(work()[1]).toContain("AssertionError");
    expect(work()[1]).toContain("The project's static checks, `test_scripts/run_static_checks_python.sh`, failed too");
    expect(work()[1]).toContain("app.py:2: error: BAD is not allowed");
  });

  it("count as the unit tests do: never clean within the rounds, the work is rolled back, saying it was the static checks", async () => {
    project({ staticScript: STATIC_SCRIPT });
    turn = (prompt) => (prompt === BEGIN ? { "app.py": "def value():\n    return 1  # BAD\n", "test_app.py": PASSING_TEST } : undefined);
    const result = await render();
    expect(result.passed).toBe(false);
    expect(result.staticChecks).toBe(true);
    expect(work().filter((prompt) => prompt.includes("BAD is not allowed"))).toHaveLength(MAX_FOLLOW_UPS);
    expect(existsSync(code("app.py"))).toBe(false);
    expect(describeSpecDiff(result)).toContain("its unit tests passed, but the project's static checks");
  }, 60_000);

  it("stop the pulse when their script cannot find its toolchain - the person installs it", async () => {
    project({ staticScript: '#!/bin/bash\n[ "${2:-}" = "--fix" ] && exit 0\necho "Error: mypy-ish is not installed on this machine."\nexit 69\n' });
    turn = (prompt) => (prompt === BEGIN ? { "app.py": "def value():\n    return 1\n", "test_app.py": PASSING_TEST } : undefined);
    await expect(render()).rejects.toThrow(/lacks a toolchain the static checks script needs/);
    expect(existsSync(code("app.py"))).toBe(false);
  });

  it("skip a fix mode that fails, leaving the code as the agent wrote it", async () => {
    // Its fix mode writes over the file and fails; its checks find nothing.
    project({ staticScript: '#!/bin/bash\ncd "$1" || exit 2\nif [ "${2:-}" = "--fix" ]; then echo garbage > app.py; exit 3; fi\nexit 0\n' });
    turn = (prompt) => (prompt === BEGIN ? { "app.py": "def value():  \n    return 1\n", "test_app.py": PASSING_TEST } : undefined);
    const result = await render();
    expect(result.passed).toBe(true);
    expect(readFileSync(code("app.py"), "utf8")).toBe("def value():  \n    return 1\n");
  });

  it("are run by the agent's run_unit_tests too, the code formatted first, exactly as the harness runs them", async () => {
    project({ staticScript: STATIC_SCRIPT });
    const runs: string[] = [];
    turn = async (prompt, tools) => {
      if (prompt !== BEGIN) return undefined;
      const write = tools.find((tool) => tool.name === "write")!;
      await write.execute("id", { path: "app.py", content: "def value():  \n    return 1  # BAD\n" });
      await write.execute("id", { path: "test_app.py", content: PASSING_TEST });
      const run = (await tools.find((tool) => tool.name === "run_unit_tests")!.execute("id", {})) as { content: Array<{ text: string }> };
      runs.push(run.content[0]!.text);
      await write.execute("id", { path: "app.py", content: "def value():\n    return 1\n" });
      return undefined;
    };
    const result = await render();
    expect(result.passed).toBe(true);
    expect(runs[0]).toContain("before the run, the static checks' fix mode - the formatter and the safe autofixes - changed app.py");
    expect(runs[0]).toContain("app.py:2: error: BAD is not allowed");
    expect(runs[0]).not.toContain("not formatted");
    expect(work()).toEqual([BEGIN]);
  });
});

describe("what the agent is shown of the static checks", () => {
  const run = (output: string, extra: Partial<{ exitCode: number; timedOut: boolean; log: string }> = {}) => ({
    command: "test_scripts/run_static_checks_python.sh",
    exitCode: 1,
    output,
    timeoutMs: 120_000,
    ...extra,
  });

  it("is only the lines naming a file and a line, errors first, each once - from the working folder, as the code folder's", () => {
    const shown = staticFindings(
      run(
        [
          "===== [3/5] Dependencies =====",
          "+ ruff check --output-format concise .",
          "Resolved 12 packages in 3ms",
          "src/app/main.py:3:1: F401 `os` imported but unused",
          "/private/tmp/static_python_code.Xy12/src/app/main.py:9:12: error: Incompatible return value type",
          "src/app/main.py:3:1: F401 `os` imported but unused",
          "Found 1 error in 1 file",
        ].join("\n"),
      ),
      dir,
    );
    expect(shown.split("\n")).toEqual(["src/app/main.py:9:12: error: Incompatible return value type", "src/app/main.py:3:1: F401 `os` imported but unused"]);
  });

  it("is capped, saying how many there are and where the whole output is kept", () => {
    const lines = Array.from({ length: 50 }, (_, index) => `src/a.ts(${index + 1},1): error TS2322: Type 'number' is not assignable`);
    const shown = staticFindings(run(lines.join("\n")), dir);
    expect(shown.split("\n")).toHaveLength(FINDINGS_SHOWN + 1);
    expect(shown).toMatch(/^\[turri: 50 findings, the first 30 shown - the whole output is kept as `[^`]+`: call read_output/);
  });

  it("is the run's last lines when no line names a file", () => {
    const shown = staticFindings(run("Resolved 3 packages\nerror: failed to parse pyproject.toml"), dir);
    expect(shown).toContain("named no file and line");
    expect(shown).toContain("error: failed to parse pyproject.toml");
  });

  it("says nothing of checks that pass", async () => {
    project({ staticScript: STATIC_SCRIPT });
    const build = join(dir, "plain_modules", "app", "code");
    mkdirSync(build, { recursive: true });
    writeFileSync(join(build, "app.py"), "def value():\n    return 1\n");
    writeFileSync(join(build, "test_app.py"), PASSING_TEST);
    const gate = createUnitGate(build, { unit: join(dir, "test_scripts", "run_unittests_python.sh"), staticChecks: join(dir, "test_scripts", "run_static_checks_python.sh") });
    const one = await gate.runAsOne();
    expect(one.exitCode).toBe(0);
    expect(one.output).not.toContain("static checks");
    expect(await gate.verify([])).toEqual({ ok: true });
  });
});

describe("the static checks scripts turri has ready", () => {
  it.each(["python", "typescript", "go", "rust"])("for %s parses as bash", async (language) => {
    const { spawnSync } = await import("node:child_process");
    const script = join(cwd, "genome", "skills", "implement-static-checks-script", "assets", `run_static_checks_${language}.sh`);
    const parsed = spawnSync("bash", ["-n", script], { encoding: "utf8" });
    expect(parsed.stderr).toBe("");
    expect(parsed.status).toBe(0);
  });
});
