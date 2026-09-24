import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
      prompts.push(prompt);
      const tool = (name: string) => session.tools.find((candidate) => candidate.name === name)!;
      if (prompts.length === 1) {
        // From the spec: the app prints hello.
        await tool("write").execute("id", {
          path: "test_conformance_hello.py",
          content:
            "import subprocess, sys, unittest\n\nclass Hello(unittest.TestCase):\n    def test_prints_hello(self):\n" +
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
  codeDir = join(root, "plain_modules", "app", "code");
  mkdirSync(codeDir, { recursive: true });
  writeFileSync(join(codeDir, "app.py"), "print('goodbye')\n");
  writeFileSync(join(codeDir, "test_app.py"), "import unittest\n\nclass Unit(unittest.TestCase):\n    def test_runs(self):\n        self.assertTrue(True)\n");
  writeFileSync(
    join(root, "app.plain"),
    "***implementation reqs***\n\n- Python.\n\n***test reqs***\n\n- :ConformanceTests: use unittest and run the app as a subprocess.\n\n" +
      "***functional specs***\n\n- The app prints hello.\n",
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
    // The failure went back to the same agent, with the spec as the judge.
    expect(prompts[1]).toContain("Work out, against the specification, what is wrong - your test or the code");
    // Its own passing run, then the harness's.
    expect(result.runs.map((run) => run.exitCode)).toEqual([1, 0, 0]);
  });
});
