import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTestScripts } from "../test-scripts.ts";

/**
 * One conformance agent, going back and forth: it writes a test from the spec, the test fails
 * because the code is wrong, and it fixes the code. Stubbed, but every run is real, in the VM.
 */
type StubSession = { tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> };
const prompts: string[] = [];
let codeDir = "";

vi.mock("../../src/pi.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pi.ts")>();
  return {
    ...actual,
    createExecutor: async (opts: { customTools: StubSession["tools"] }) => ({ tools: opts.customTools, dispose() {} }),
    ask: vi.fn(async (session: StubSession, prompt: string) => {
      // Asked to leave notes, it does - and that is not a turn the test is about.
      if (prompt.startsWith("Before you finish: call update_notes")) {
        await session.tools.find((candidate) => candidate.name === "update_notes")!.execute("id", {
          changes: [{ section: "where", action: "add", text: "stub agent was here" }],
        });
        return "Done.";
      }
      prompts.push(prompt);
      const tool = (name: string) => session.tools.find((candidate) => candidate.name === name)!;
      if (prompt.includes("they are not labelled")) {
        // Sent back for the acceptance test it left out: written as a test of its own.
        await tool("write").execute("id", {
          path: "test_acceptance_hello.py",
          content:
            "import subprocess, sys, unittest\n\nclass Acceptance(unittest.TestCase):\n" +
            "    # acceptance test 1 of functionality 1: Running the app prints hello and exits 0.\n" +
            "    def test_prints_hello_and_exits_0(self):\n" +
            "        run = subprocess.run([sys.executable, 'app.py'], capture_output=True, text=True)\n" +
            "        self.assertEqual((run.stdout.strip(), run.returncode), ('hello', 0))\n",
        });
      } else if (prompts.length === 1) {
        // From the functional spec: the app prints hello.
        await tool("write").execute("id", {
          path: "test_conformance_hello.py",
          content:
            "# conformance tests of functionality 1\nimport subprocess, sys, unittest\n\nclass Hello(unittest.TestCase):\n" +
            "    def test_prints_hello(self):\n" +
            "        out = subprocess.run([sys.executable, 'app.py'], capture_output=True, text=True).stdout\n" +
            "        self.assertEqual(out.strip(), 'hello')\n",
        });
      } else {
        // The run failed and the code is what is wrong: fix it, and keep its unit tests passing.
        await tool("write").execute("id", { path: join(codeDir, "app.py"), content: "print('hello')\n" });
        await tool("run_unit_tests").execute("id", { command: "python3 -m unittest discover" });
      }
      await tool("run_conformance_tests").execute("id", { command: "python3 -m unittest discover" });
      return "Done.";
    }),
  };
});

const { renderConformanceTests } = await import("../../src/render/conformance.ts");
const { closeAllVms, vmSupported } = await import("../../src/render/vm.ts");

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "plainwright-conformance-loop-")));
  writeTestScripts(root);
  codeDir = join(root, "plain_modules", "app", "code");
  mkdirSync(codeDir, { recursive: true });
  writeFileSync(join(codeDir, "app.py"), "print('goodbye')\n");
  writeFileSync(join(codeDir, "test_app.py"), "import unittest\n\nclass Unit(unittest.TestCase):\n    def test_runs(self):\n        self.assertTrue(True)\n");
  writeFileSync(
    join(root, "app.plain"),
    "***implementation reqs***\n\n- Python.\n\n***test reqs***\n\n- :ConformanceTests: use unittest and run the app as a subprocess.\n\n" +
      "***functional specs***\n\n- The app prints hello.\n\n  ***acceptance tests***\n\n  - Running the app prints hello and exits 0.\n",
  );
  prompts.length = 0;
});
afterEach(async () => {
  await closeAllVms();
  rmSync(root, { recursive: true, force: true });
});

describe.runIf(vmSupported())("the conformance step", { timeout: 180_000 }, () => {
  it("is one agent that writes the tests and fixes what is wrong until the harness's own run passes", async () => {
    const result = await renderConformanceTests({
      plainFile: join(root, "app.plain"),
      frid: "1",
      buildDir: codeDir,
      conformanceDir: join(root, "plain_modules", "app", "tests"),
    });

    expect(result.passed).toBe(true);
    expect(result.codeChanged).toBe(true);
    expect(readFileSync(join(codeDir, "app.py"), "utf8")).toBe("print('hello')\n");
    // Sent back first for the acceptance test it left out, then with the harness's failing run -
    // the spec as the judge.
    expect(prompts[1]).toContain('No test is labelled "acceptance test 1 of functionality 1"');
    expect(prompts[2]).toContain("Work out, against the specification, what is wrong - your test or the code");
    // Conformance tests from the functional spec, and the acceptance test apart from them.
    expect(prompts[0]).toContain("Conformance tests come from the functional spec itself");
    expect(prompts[0]).toContain("acceptance test 1 of functionality 1: Running the app prints hello and exits 0.");
    expect(readFileSync(join(root, "plain_modules", "app", "tests", "test_acceptance_hello.py"), "utf8")).toContain(
      "# acceptance test 1 of functionality 1:",
    );
    // Its own final checks and the harness's runs - the same script: failing until the code is fixed.
    expect(result.runs.map((run) => run.exitCode)).toEqual([1, 1, 1, 0, 0]);
    expect(new Set(result.runs.map((run) => run.command))).toEqual(new Set(["test_scripts/run_conformance_tests_python.sh"]));

    // It started with no notes, and left some - which the next agent on this codebase starts with.
    expect(prompts[0]).toContain("No earlier agent has left notes on this codebase yet.");
    prompts.length = 0;
    writeFileSync(join(codeDir, "app.py"), "print('goodbye')\n");
    await renderConformanceTests({
      plainFile: join(root, "app.plain"),
      frid: "1",
      buildDir: codeDir,
      conformanceDir: join(root, "plain_modules", "app", "tests"),
      continuing: true,
    });
    expect(prompts[0]).toContain("<notes from earlier agents>");
    expect(prompts[0]).toMatch(/- \[[\d: -]+ · app 1 conformance\] stub agent was here/);
  });
});
