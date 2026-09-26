import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTestScripts } from "../test-scripts.ts";

/**
 * The conformance step: an explorer says how the code is invoked, the conformance agent - who never
 * sees the code - writes the tests from the spec, a test fails because the code is wrong, a judge
 * says so, and the coding agent fixes the code. Stubbed agents, but every run is real, in the VMs.
 */
type StubSession = { tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>; role: string };
/** What each agent was asked, by who it is. */
const asked: Array<{ role: string; prompt: string }> = [];
let codeDir = "";

vi.mock("../../src/pi.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pi.ts")>();
  return {
    ...actual,
    createExecutor: vi.fn(async (opts: { customTools: StubSession["tools"]; label?: string }) => ({
      tools: opts.customTools,
      role: opts.label?.split(" ").at(-1) === "agent" ? opts.label.split(" ").slice(-2).join(" ") : (opts.label?.split(" ").at(-1) ?? ""),
      dispose() {},
    })),
    ask: vi.fn(async (session: StubSession, prompt: string) => {
      const tool = (name: string) => session.tools.find((candidate) => candidate.name === name)!;
      // Asked to leave notes, it does - and that is not a turn the test is about.
      if (prompt.startsWith("Before you finish: call update_notes")) {
        await tool("update_notes").execute("id", { changes: [{ section: "where", action: "add", text: "stub agent was here" }] });
        return "Done.";
      }
      asked.push({ role: session.role, prompt });
      if (session.role === "explorer") {
        await tool("submit_invocation").execute("id", { invocation: "Run `python3 app.py` from the build folder; it writes to stdout." });
        return "Done.";
      }
      if (session.role === "judge") {
        await tool("submit_verdict").execute("id", { culprit: "code", reason: "The spec says the app prints hello; the code prints goodbye." });
        return "Done.";
      }
      if (session.role === "coding agent") {
        // The code is what is wrong: fixed, its unit tests kept passing.
        await tool("write").execute("id", { path: join(codeDir, "app.py"), content: "print('hello')\n" });
        await tool("run_unit_tests").execute("id", {});
        return "Done.";
      }
      // The conformance agent.
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
      } else {
        await tool("write").execute("id", {
          path: "test_conformance_hello.py",
          content:
            "# conformance tests of functionality 1\nimport subprocess, sys, unittest\n\nclass Hello(unittest.TestCase):\n" +
            "    def test_prints_hello(self):\n" +
            "        out = subprocess.run([sys.executable, 'app.py'], capture_output=True, text=True).stdout\n" +
            "        self.assertEqual(out.strip(), 'hello')\n",
        });
      }
      await tool("run_conformance_tests").execute("id", {});
      return "Done.";
    }),
  };
});

const { renderConformanceTests } = await import("../../src/render/conformance.ts");
const { closeAllVms, vmSupported } = await import("../../src/render/vm.ts");
const { withActivity } = await import("../../src/render/activity.ts");

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
  asked.length = 0;
});
afterEach(async () => {
  await closeAllVms();
  rmSync(root, { recursive: true, force: true });
});

describe.runIf(vmSupported())("the conformance step", { timeout: 180_000 }, () => {
  it("explores how the code is invoked, has the tests written apart from it, and sends a failure to whichever is wrong", async () => {
    const stages: string[] = [];
    const sink = { stage: (label: string) => stages.push(label), activity() {}, now() {}, usage() {}, transcript() {}, spec() {} };
    const result = await withActivity(sink, () =>
      renderConformanceTests({
        plainFile: join(root, "app.plain"),
        frid: "1",
        buildDir: codeDir,
        conformanceDir: join(root, "plain_modules", "app", "tests"),
      }),
    );

    expect(result.passed).toBe(true);
    expect(result.codeChanged).toBe(true);
    expect(readFileSync(join(codeDir, "app.py"), "utf8")).toBe("print('hello')\n");

    // In order: the explorer, the conformance agent (sent back once for the acceptance test it left
    // out), the judge, who says the code is wrong, and the coding agent, who fixes it.
    expect(asked.map((turn) => turn.role)).toEqual(["explorer", "conformance agent", "conformance agent", "judge", "coding agent"]);
    const [explorer, writer, , judge, coder] = asked;
    expect(explorer!.prompt).toContain("They will never see the code");
    // The test author is given how to invoke it, and nothing of the code's place.
    expect(writer!.prompt).toContain("<how to invoke it>\nRun `python3 app.py` from the build folder; it writes to stdout.\n</how to invoke it>");
    expect(writer!.prompt).toContain("You cannot see the implementation");
    expect(writer!.prompt).not.toContain(codeDir);
    expect(writer!.prompt).toContain("acceptance test 1 of functionality 1: Running the app prints hello and exits 0.");
    expect(judge!.prompt).toContain("Decide what is wrong: the code or the tests");
    expect(judge!.prompt).toMatch(/<failing run exit="1"/);
    expect(coder!.prompt).toContain("The spec says the app prints hello; the code prints goodbye.");
    expect(stages).toContain("app 1: the code is wrong - the coding agent fixes it");

    // The harness's own runs decide: failing until the code is fixed, then the suite and the unit tests pass.
    expect(result.runs.at(-1)!.exitCode).toBe(0);
    expect(new Set(result.runs.map((run) => run.command))).toEqual(new Set(["test_scripts/run_conformance_tests_python.sh"]));
    expect(readFileSync(join(root, "plain_modules", "app", "tests", "test_acceptance_hello.py"), "utf8")).toContain("# acceptance test 1 of functionality 1:");
  });

  it("gives the conformance agent file tools that cannot reach the code", async () => {
    const { createExecutor } = await import("../../src/pi.ts");
    const spy = vi.mocked(createExecutor);
    await renderConformanceTests({
      plainFile: join(root, "app.plain"),
      frid: "1",
      buildDir: codeDir,
      conformanceDir: join(root, "plain_modules", "app", "tests"),
    });
    const conformanceCall = spy.mock.calls.find(([opts]) => (opts as { label?: string }).label?.endsWith("conformance agent"))!;
    const read = (conformanceCall[0] as { customTools: StubSession["tools"] }).customTools.find((tool) => tool.name === "read")!;
    await expect(read.execute("id", { path: join(codeDir, "app.py") })).rejects.toThrow(/outside this agent's read directory/);
  });
});
