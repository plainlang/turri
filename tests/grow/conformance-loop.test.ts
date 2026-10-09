import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTestScripts } from "../test-scripts.ts";

/**
 * The conformance step: an explorer says how the code is invoked, the conformance agent - who never
 * sees the code - writes the tests from the spec, a test fails because the code is wrong, a judge
 * says so, and the coding agent fixes the code. Stubbed agents, but every run is real, on this machine.
 */
type StubSession = { tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>; role: string; task?: string; asked?: boolean };
/** What each agent was asked, by who it is. */
const asked: Array<{ role: string; prompt: string }> = [];
let codeDir = "";
/** What the stubbed judge says, and which functionality the stubbed conformance agent labels its tests for. */
let judgeSays: () => Record<string, unknown> = () => ({ culprit: "code", reason: "The spec says the app prints hello; the code prints goodbye.", spec_says: "The app prints hello." });
let testedFrid = "1";
/** What the stubbed test reviewer says. */
let reviewSays: () => Record<string, unknown> = () => ({ pass: true, problems: [] });
/** What the stand-in arbiter rules on each review it weighs; nothing: it gives no ruling, and the review stands. */
let arbiterRules: (() => Array<{ problem: number; uphold: boolean; why: string }>) | undefined;
/** When set, the stubbed conformance agent writes nothing at all - it only looks. */
let writesNothing = false;
/** When set, each time the tests are sent back, the stub's test fails the other way: A, B, A, B - as the artifact ping-pong did. */
let pingPong = 0;
/** How many of the coding agent's fixes miss before one makes the app print hello. */
let coderMisses = 0;
/** When set, each fix of the tests changes their file - a comment - while they fail the same way. */
let touchesTests = false;
let touches = 0;

vi.mock("../../src/pi.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pi.ts")>();
  return {
    ...actual,
    createExecutor: vi.fn(async (opts: { customTools: StubSession["tools"]; label?: string; task?: string }) => ({
      tools: opts.customTools,
      task: opts.task,
      role: opts.label?.split(" ").at(-1) === "agent" ? opts.label.split(" ").slice(-2).join(" ") : (opts.label?.split(" ").at(-1) ?? ""),
      dispose() {},
    })),
    ask: vi.fn(async (session: StubSession, given: string) => {
      // Its task is its instructions: an agent's first turn reads as it and what it is asked, and a reviewer's every review too.
      const first = session.asked !== true;
      session.asked = true;
      const prompt = session.task !== undefined && (first || session.role === "reviewer") ? (given === actual.BEGIN ? session.task : `${session.task}\n\n${given}`) : given;
      const tool = (name: string) => session.tools.find((candidate) => candidate.name === name)!;
      // Asked to leave notes, it does - and that is not a turn the test is about.
      if (prompt.includes("Before you finish: call update_notes")) {
        await tool("update_notes").execute("id", { changes: [{ section: "where", action: "add", text: "stub agent was here" }] });
        return "Done.";
      }
      asked.push({ role: session.role, prompt });
      if (session.role === "explorer") {
        await tool("submit_exploration").execute("id", {
          build_and_run: "Nothing to build or install: run `python3 app.py` from the build folder, with Python 3.",
          tests_reach_it: "The script runs the tests from a copy of the build: app.py is in the current directory when they run.",
          interfaces: [{ module: "app", id: testedFrid, how: "Run `python3 app.py` from the build folder; it writes to stdout and exits." }],
          environment: "Nothing around it: no variables, services or files - every run starts from the same state.",
          plan: [{ module: "app", id: testedFrid, tests: "Run the app as a subprocess and check what it prints to stdout, and its exit code, as the spec says. Acceptance test 1: run it, assert it prints hello and exits 0." }],
        });
        return "Done.";
      }
      if (session.role === "reviewer") {
        await tool("submit_review").execute("id", reviewSays());
        return "Done.";
      }
      if (session.role === "arbiter") {
        if (arbiterRules !== undefined) await tool("submit_ruling").execute("id", { rulings: arbiterRules() });
        return "Ruled.";
      }
      if (session.role === "judge") {
        await tool("submit_verdict").execute("id", judgeSays());
        return "Done.";
      }
      if (session.role === "coding agent") {
        // The code is what is wrong: fixed, its unit tests kept passing - once the misses queued are spent.
        const missed = coderMisses > 0;
        if (missed) coderMisses -= 1;
        await tool("write").execute("id", { path: join(codeDir, "app.py"), content: missed ? "print('hell')\n" : "print('hello')\n" });
        await tool("run_unit_tests").execute("id", {});
        return "Done.";
      }
      // The conformance agent.
      if (writesNothing) {
        await tool("run_conformance_tests").execute("id", {});
        return "The tests are already there.";
      }
      if (pingPong > 0 && prompt.includes("a test is what is wrong")) {
        pingPong += 1;
        await tool("write").execute("id", {
          path: "test_conformance_hello.py",
          content: `# conformance tests of functionality ${testedFrid}\nimport unittest\n\nclass Hello(unittest.TestCase):\n    def test_side(self):\n        self.fail("depends on artifact ${pingPong % 2 === 0 ? "alpha" : "beta"}")\n`,
        });
        return "Done.";
      }
      if (prompt.includes("are not labelled yet")) {
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
            `# conformance tests of functionality ${testedFrid}\n${touchesTests ? `# fix ${(touches += 1)}\n` : ""}import subprocess, sys, unittest\n\nclass Hello(unittest.TestCase):\n` +
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

const { renderConformanceTests } = await import("../../src/grow/conformance.ts");
const { withActivity } = await import("../../src/grow/activity.ts");

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "turri-conformance-loop-")));
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
  judgeSays = () => ({ culprit: "code", reason: "The spec says the app prints hello; the code prints goodbye.", spec_says: "The app prints hello." });
  testedFrid = "1";
  pingPong = 0;
  coderMisses = 0;
  writesNothing = false;
  touchesTests = false;
  touches = 0;
  reviewSays = () => ({ pass: true, problems: [] });
  arbiterRules = undefined;
});
afterEach(async () => {
  rmSync(root, { recursive: true, force: true });
});

describe("the conformance step", { timeout: 180_000 }, () => {
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
    // ...and, once the suite and the unit tests pass, the review gate.
    expect(asked.map((turn) => turn.role)).toEqual(["explorer", "conformance agent", "conformance agent", "judge", "coding agent", "reviewer"]);
    const review = asked.at(-1)!.prompt;
    expect(review).toContain("<tests added or changed by the run>");
    // The tests the run wrote, as the harness's diff - not only their names.
    expect(review).toContain("<the tests this run wrote - a diff of the tests folder from where the run started>");
    expect(review).toContain("test_acceptance_hello.py");
    expect(review).toContain("never mocks, stubs or replaces any part of the software under test");
    expect(review).toContain("<acceptance test 1 of functionality 1>\n- Running the app prints hello and exits 0.");
    const [explorer, writer, , judge, coder] = asked;
    expect(explorer!.prompt).toContain("They will not see your replies");
    // The test author is given how to invoke it, and may read the code - never write it.
    // The whole exploration: how to run it, how the functionality is reached, what it needs, and a plan.
    expect(writer!.prompt).toContain("## How each functionality is reached\n\n### app 1\n\nRun `python3 app.py` from the build folder; it writes to stdout and exits.");
    expect(writer!.prompt).toContain("## Plan for the conformance tests\n\n### app 1\n\nRun the app as a subprocess");
    expect(writer!.prompt).toContain(`You have read access to the code, in ${codeDir}, with your file tools - read, grep, find, ls - but`);
    expect(writer!.prompt).toContain("not write access: you write tests, never code.");
    expect(writer!.prompt).toContain("acceptance test 1 of functionality 1: Running the app prints hello and exits 0.");
    expect(judge!.prompt).toContain("Decide what is wrong: the code, the tests, the specification itself, or the run's environment");
    expect(judge!.prompt).toContain("<how to read the specification>");
    expect(judge!.prompt).toMatch(/<failing run exit="1"/);
    expect(coder!.prompt).toContain("The spec says the app prints hello; the code prints goodbye.");
    expect(coder!.prompt).toContain(`You have read access to the conformance tests, in ${join(root, "plain_modules", "app", "tests")}, with your file tools`);
    expect(coder!.prompt).toContain("but not write access: read them to see what a failing test does and expects; never change them.");
    expect(stages).toContain("module app, functionality 1: the code is wrong - the coding agent fixes it");

    // The harness's own runs decide: failing until the code is fixed, then the suite and the unit tests pass.
    expect(result.runs.at(-1)!.exitCode).toBe(0);
    expect(new Set(result.runs.map((run) => run.command))).toEqual(new Set(["test_scripts/run_conformance_tests_python.sh"]));
    expect(readFileSync(join(root, "plain_modules", "app", "tests", "test_acceptance_hello.py"), "utf8")).toContain("# acceptance test 1 of functionality 1:");
  });

  it("stops at the harness's first run when the conformance testing script cannot find its toolchain - no turn back to the conformance agent", async () => {
    writeTestScripts(root, { conformance: "#!/bin/bash\necho 'run_conformance_tests.sh: line 3: flutter: command not found'\nexit 127\n" });
    const { EnvironmentError, describeEnvironmentError } = await import("../../src/grow/environment-error.ts");
    const stopped = await renderConformanceTests({
      plainFile: join(root, "app.plain"),
      frid: "1",
      buildDir: codeDir,
      conformanceDir: join(root, "plain_modules", "app", "tests"),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(stopped).toBeInstanceOf(EnvironmentError);
    const said = describeEnvironmentError(stopped as InstanceType<typeof EnvironmentError>);
    expect(said).toContain("**app stopped: the environment lacks `flutter`.**");
    expect(said).toContain("Needed by: the conformance testing script, `run_conformance_tests_python.sh`");
    expect(said).toContain("install flutter on this machine");
    // The conformance agent was never sent back to work around what the machine lacks.
    for (const turn of asked.filter((candidate) => candidate.role === "conformance agent")) expect(turn.prompt).not.toContain("is not installed on this machine");
    expect(asked.map((turn) => turn.role)).not.toContain("judge");
  });

  it("lets the conformance agent read the code but write only tests, and the coding agent read the tests but write only code", async () => {
    const { createExecutor } = await import("../../src/pi.ts");
    const spy = vi.mocked(createExecutor);
    await renderConformanceTests({
      plainFile: join(root, "app.plain"),
      frid: "1",
      buildDir: codeDir,
      conformanceDir: join(root, "plain_modules", "app", "tests"),
    });
    const conformanceCall = spy.mock.calls.find(([opts]) => (opts as { label?: string }).label?.endsWith("conformance agent"))!;
    const tools = (conformanceCall[0] as { customTools: StubSession["tools"] }).customTools;
    const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
    await expect(tool("read").execute("id", { path: join(codeDir, "app.py") })).resolves.toBeDefined();
    await expect(tool("write").execute("id", { path: join(codeDir, "app.py"), content: "x" })).rejects.toThrow(/outside/);
    expect(readFileSync(join(codeDir, "app.py"), "utf8")).not.toBe("x");
    // Its system prompt says so: it reads the tests and the code, and writes only the tests - the full logs of the runs
    // come through read_output, not by a path into turri's scratch area.
    const system = (conformanceCall[0] as { system?: string }).system!;
    expect(system).not.toContain(".turri");
    expect(tools.map((candidate) => candidate.name)).toContain("read_output");
    expect(system).toContain("but never write it: you write tests, not code.");
    expect(system).toContain(codeDir);

    const coderCall = spy.mock.calls.find(([opts]) => (opts as { label?: string }).label?.endsWith("coding agent"))!;
    const coderTools = (coderCall[0] as { customTools: StubSession["tools"] }).customTools;
    const coderTool = (name: string) => coderTools.find((candidate) => candidate.name === name)!;
    const testFile = join(root, "plain_modules", "app", "tests", "test_conformance_hello.py");
    await expect(coderTool("read").execute("id", { path: testFile })).resolves.toBeDefined();
    await expect(coderTool("write").execute("id", { path: testFile, content: "x" })).rejects.toThrow(/outside/);
  });

  it("raises a spec conflict only after the same two functionalities are named three times, sending the tests back in between", async () => {
    writeFileSync(
      join(root, "app.plain"),
      "***implementation reqs***\n\n- Python.\n\n***test reqs***\n\n- :ConformanceTests: use unittest and run the app as a subprocess.\n\n" +
        "***functional specs***\n\n- The app prints goodbye.\n\n- The app prints hello.\n",
    );
    testedFrid = "2";
    judgeSays = () => ({ culprit: "spec", functionalities: [{ module: "app", id: "2" }, { module: "app", id: "1" }], reason: "One says it prints goodbye, the other hello." });
    const conflicts: unknown[] = [];
    const sink = { stage() {}, activity() {}, now() {}, usage() {}, transcript() {}, spec() {}, specConflict: (conflict: unknown) => conflicts.push(conflict) };

    const result = await withActivity(sink, () =>
      renderConformanceTests({ plainFile: join(root, "app.plain"), frid: "2", buildDir: codeDir, conformanceDir: join(root, "plain_modules", "app", "tests") }),
    );

    expect(result.passed).toBe(false);
    expect(result.specConflict).toEqual({
      functionalities: [{ module: "app", frid: "1" }, { module: "app", frid: "2" }],
      reason: "One says it prints goodbye, the other hello.",
    });
    // Judged three times; the first two recorded and the tests sent back - never the code.
    expect(asked.filter((turn) => turn.role === "judge")).toHaveLength(3);
    expect(asked.filter((turn) => turn.role === "coding agent")).toHaveLength(0);
    expect(asked.filter((turn) => turn.prompt.includes("Functionalities app 1 & app 2 of the specification may conflict"))).toHaveLength(2);
    // The person gets both functional specs as they read, and every time it was raised.
    expect(conflicts).toEqual([
      {
        moduleName: "app",
        plainFile: join(root, "app.plain"),
        specs: [
          { module: "app", frid: "1", plainFile: join(root, "app.plain"), text: "- The app prints goodbye." },
          { module: "app", frid: "2", plainFile: join(root, "app.plain"), text: "- The app prints hello." },
        ],
        reasons: ["One says it prints goodbye, the other hello.", "One says it prints goodbye, the other hello.", "One says it prints goodbye, the other hello."],
      },
    ]);
    // Each attempt went into the notes, and the next judge read them. (A run that does not pass is
    // undone whole, and its notes with it.)
    const lastJudge = asked.filter((turn) => turn.role === "judge")[2]!.prompt;
    expect(lastJudge).toMatch(/app 2 conformance attempt 1\] attempt 1: failed with "[^"]*" → judged a spec conflict between functionalities app 1 & app 2: [^→]* → the conformance agent changed /);
    expect(lastJudge).toMatch(/app 2 conformance attempt 2\] attempt 2: failed with "[^"]*" → judged a spec conflict between functionalities app 1 & app 2/);
  });

  it("keeps one code fixer for the run: a second fix goes to the agent that made the first, its task given once", async () => {
    const { createExecutor } = await import("../../src/pi.ts");
    const made = (createExecutor as unknown as { mock: { calls: Array<[{ label?: string; task?: string }]> } }).mock.calls;
    const before = made.length;
    coderMisses = 1;
    const result = await renderConformanceTests({ plainFile: join(root, "app.plain"), frid: "1", buildDir: codeDir, conformanceDir: join(root, "plain_modules", "app", "tests") });
    expect(result.passed).toBe(true);
    const coders = asked.filter((turn) => turn.role === "coding agent");
    expect(coders.length).toBeGreaterThanOrEqual(2);
    const fixers = made.slice(before).filter(([opts]) => opts.label?.endsWith("coding agent"));
    expect(fixers).toHaveLength(1);
    // Its task holds the spec, word for word; each fix is only the failure.
    expect(fixers[0]![0].task).toContain("<specification>");
    expect(coders[1]!.prompt).toContain("The conformance tests failed, and the code is what is wrong");
    expect(coders[1]!.prompt).not.toContain("<specification>");
  });

  it("stops when nothing changes: the same failure judged the same way asks the explorer again, and then ends the run", async () => {
    // The judge always blames the tests, and the stub's fixes never touch what fails - so the failure never changes.
    judgeSays = () => ({ culprit: "tests", reason: "The tests are wrong." });
    touchesTests = true;
    const result = await renderConformanceTests({ plainFile: join(root, "app.plain"), frid: "1", buildDir: codeDir, conformanceDir: join(root, "plain_modules", "app", "tests") });

    expect(result.passed).toBe(false);
    expect(result.stuck).toBeDefined();
    expect(result.stuck!.failure).toContain("goodbye");
    // Asked again once, after three rounds alike; stopped after three more - never all 20 attempts.
    expect(asked.filter((turn) => turn.role === "explorer")).toHaveLength(2);
    expect(asked.filter((turn) => turn.role === "explorer")[1]!.prompt).toContain("You are asked again.");
    expect(result.rounds).toBe(6);
    const { describeStop } = await import("../../src/grow/stop-report.ts");
    const stop = describeStop({ moduleName: "app", frid: "1", at: "conformance", conformance: result });
    // The error itself, quoted - not the run's last lines - and how often, in how many attempts.
    expect(stop).toMatch(/kept failing with "[^"]*Error[^"]*"[^-]* - 3 times, and 3 more after the explorer was asked again what they lacked, in 6 attempts/);
  });

  it("stops once two fixes in a row change no file - an agent that will not, or cannot, act on the verdict", async () => {
    judgeSays = () => ({ culprit: "tests", reason: "The tests are wrong." });
    const result = await renderConformanceTests({ plainFile: join(root, "app.plain"), frid: "1", buildDir: codeDir, conformanceDir: join(root, "plain_modules", "app", "tests") });
    expect(result.passed).toBe(false);
    expect(result.stuck).toMatchObject({ changedNothing: true, times: 2 });
    expect(result.rounds).toBe(2);
    const { describeStop } = await import("../../src/grow/stop-report.ts");
    expect(describeStop({ moduleName: "app", frid: "1", at: "conformance", conformance: result })).toMatch(/the last 2 fixes - in 2 attempts - changed nothing/);
  });

  it("stops once the run's environment is judged what is wrong twice in a row - the tests checked in between - and tells the person what to provide", async () => {
    judgeSays = () => ({ culprit: "environment", reason: "HUBSPOT_ACCESS_TOKEN, read from plain_modules/.turri/.env, is rejected with 401." });
    const result = await renderConformanceTests({ plainFile: join(root, "app.plain"), frid: "1", buildDir: codeDir, conformanceDir: join(root, "plain_modules", "app", "tests") });
    expect(result.passed).toBe(false);
    expect(result.environment).toEqual({ reason: "HUBSPOT_ACCESS_TOKEN, read from plain_modules/.turri/.env, is rejected with 401.", times: 2 });
    expect(result.rounds).toBe(2);
    // In between, the conformance agent checked the tests do not cause it - and nobody touched the code.
    expect(asked.filter((turn) => turn.prompt.includes("<why the environment>"))).toHaveLength(1);
    expect(asked.filter((turn) => turn.role === "coding agent")).toHaveLength(0);
    const { describeStop } = await import("../../src/grow/stop-report.ts");
    const stop = describeStop({ moduleName: "app", frid: "1", at: "conformance", conformance: result });
    expect(stop).toContain("cannot pass with what their run is given - judged so 2 times in a row");
    expect(stop).toContain("The testing scripts run on this machine in your own environment");
  });

  it("counts a failure that comes back after another as stuck too - a run swinging between two - and journals cause and effect", async () => {
    judgeSays = () => ({ culprit: "tests", reason: "The test points at the wrong artifact." });
    pingPong = 1;
    const result = await renderConformanceTests({ plainFile: join(root, "app.plain"), frid: "1", buildDir: codeDir, conformanceDir: join(root, "plain_modules", "app", "tests") });
    expect(result.passed).toBe(false);
    // goodbye, alpha, beta, alpha, beta...: never three alike in a row, but each keeps coming back.
    expect(result.stuck).toBeDefined();
    // Never all 20: a failure seen three times asks the explorer again (round 6 here), three more stop it.
    expect(result.rounds).toBeLessThanOrEqual(12);
    expect(asked.filter((turn) => turn.role === "explorer")).toHaveLength(2);
    // The next judge read the journal: what failed, how it was judged, and which files were changed.
    const judges = asked.filter((turn) => turn.role === "judge");
    expect(judges.at(-1)!.prompt).toMatch(/attempt \d+: failed with [^→]*artifact (alpha|beta)[^→]* → judged the tests wrong: The test points at the wrong artifact\. → the conformance agent changed tests\/test_conformance_hello\.py/);
  });

  it("does not finish until the tests pass review - a placeholder acceptance test goes back with exactly what is wrong", async () => {
    const { createExecutor } = await import("../../src/pi.ts");
    const made = (createExecutor as unknown as { mock: { calls: Array<[{ label?: string }]> } }).mock.calls;
    const reviewersBefore = made.filter(([opts]) => opts.label?.endsWith("test reviewer")).length;
    let reviews = 0;
    reviewSays = () =>
      (reviews += 1) === 1
        ? { pass: false, problems: [{ file: "test_acceptance_hello.py", test: "test_prints_hello_and_exits_0", kind: "bad", what: "It asserts nothing: assertTrue(true) is a placeholder, not the acceptance test." }] }
        : { pass: true, problems: [] };
    const result = await renderConformanceTests({ plainFile: join(root, "app.plain"), frid: "1", buildDir: codeDir, conformanceDir: join(root, "plain_modules", "app", "tests") });
    expect(result.passed).toBe(true);
    const reviewTurns = asked.filter((turn) => turn.role === "reviewer");
    expect(reviewTurns).toHaveLength(2);
    // The first finds everything at once; the second checks what the first sent back, rather than starting over.
    expect(reviewTurns[0]!.prompt).toContain("The first review finds every problem, in that one review");
    expect(reviewTurns[0]!.prompt).toContain("The conformance suite and the unit tests pass. Review the tests the run added or changed.");
    expect(reviewTurns[1]!.prompt).toContain("The problems of your last review the conformance agent was given:");
    expect(reviewTurns[1]!.prompt).toContain("1. BAD · test_acceptance_hello.py · test_prints_hello_and_exits_0: It asserts nothing");
    expect(reviewTurns[1]!.prompt).toContain("<what changed since your last review - a diff of the tests folder>");
    const feedback = asked.find((turn) => turn.role === "conformance agent" && turn.prompt.includes("found how to make them better"))!;
    expect(feedback.prompt).toContain("1. BAD · test_acceptance_hello.py · test_prints_hello_and_exits_0: It asserts nothing: assertTrue(true) is a placeholder");
    expect(feedback.prompt).toContain("call submit_work, last: an answer for each problem");
    // One reviewer for the run: its task once, its reviews as turns of the same session.
    expect(made.filter(([opts]) => opts.label?.endsWith("test reviewer")).length - reviewersBefore).toBe(1);
  });

  it("for a spec change, labels, shows and reviews the acceptance tests of the functionalities it touches", async () => {
    const diff = "--- a/app.plain\n+++ b/app.plain\n@@ -1 +1 @@\n-- The app prints hi.\n+- The app prints hello.\n";
    const result = await renderConformanceTests({ plainFile: join(root, "app.plain"), frid: "1", buildDir: codeDir, conformanceDir: join(root, "plain_modules", "app", "tests"), diff });
    expect(result.passed).toBe(true);
    const writer = asked.find((turn) => turn.role === "conformance agent")!;
    expect(writer.prompt).toContain("The acceptance tests of the functional specs the change touches:\n<acceptance tests>\n");
    expect(writer.prompt).toContain("Running the app prints hello and exits 0.");
    // Its first tests leave the acceptance test out: sent back to label it, as a functionality's own run does.
    expect(asked.some((turn) => turn.role === "conformance agent" && turn.prompt.includes("are not labelled yet"))).toBe(true);
    const review = asked.find((turn) => turn.role === "reviewer")!.prompt;
    expect(review).toContain("the functionalities of module `app` the change touches (1)");
    expect(review).toContain("<acceptance test 1 of functionality 1>\n- Running the app prints hello and exits 0.");
  });

  it("takes a verdict against the code only with the spec's own words - a judge that quotes none, or words the spec lacks, sends the tests back", async () => {
    const { unfoundedCodeVerdict } = await import("../../src/grow/conformance-agents.ts");
    const spec = "- :App: should return 404 status code for unknown endpoints. The response body should be empty.";
    expect(unfoundedCodeVerdict({ culprit: "code", reason: "r", specSays: "should return 404 status code for unknown endpoints" }, spec)).toBeUndefined();
    expect(unfoundedCodeVerdict({ culprit: "code", reason: "r" }, spec)).toMatch(/quotes no words of the specification/);
    expect(unfoundedCodeVerdict({ culprit: "code", reason: "r", specSays: "Invalid credentials return 400" }, spec)).toMatch(/is not in the specification/);
    // Code that hides why it failed is wrong whatever the spec says.
    expect(unfoundedCodeVerdict({ culprit: "code", reason: "r", causeHidden: true }, spec)).toBeUndefined();

    // A judge that never quotes the spec: asked again, then the tests go back - the code is never touched.
    judgeSays = () => ({ culprit: "code", reason: "The spec says a bad request returns 400." });
    const result = await renderConformanceTests({ plainFile: join(root, "app.plain"), frid: "1", buildDir: codeDir, conformanceDir: join(root, "plain_modules", "app", "tests"), maxRounds: 2 });
    expect(asked.some((turn) => turn.role === "coding agent")).toBe(false);
    expect(asked.some((turn) => turn.role === "judge" && turn.prompt.includes("quotes no words of the specification"))).toBe(true);
    expect(result.codeChanged).toBe(false);
  });

  it("tells an agent that wrote no tests that there are none, and stops after three asks rather than every round", async () => {
    writesNothing = true;
    const result = await renderConformanceTests({ plainFile: join(root, "app.plain"), frid: "1", buildDir: codeDir, conformanceDir: join(root, "plain_modules", "app", "tests") });
    expect(result.passed).toBe(false);
    expect(result.unlabelled).toEqual(expect.arrayContaining([expect.stringContaining('No test file is labelled "conformance tests of functionality 1"')]));
    const writers = asked.filter((turn) => turn.role === "conformance agent");
    expect(writers).toHaveLength(4);
    expect(writers[1]!.prompt).toContain("There are no tests in your tests folder - nothing ran.");
    const { describeStop } = await import("../../src/grow/stop-report.ts");
    expect(describeStop({ moduleName: "app", frid: "1", at: "conformance", conformance: result })).toContain("were never written and labelled");
  });

  it("sends the conformance agent what the arbiter upholds of the second review - a functionality not tested black box - and then goes on once the tests pass, without another", async () => {
    const missing = { file: "test_acceptance_hello.py", kind: "missing", what: "The acceptance test skips the backup it checks.", blocking: true };
    reviewSays = () => ({ pass: false, problems: [missing] });
    arbiterRules = () => [{ problem: 1, uphold: true, why: "the acceptance test skips what it checks" }];
    const result = await renderConformanceTests({ plainFile: join(root, "app.plain"), frid: "1", buildDir: codeDir, conformanceDir: join(root, "plain_modules", "app", "tests"), maxRounds: 15 });
    // An optimiser, not a gate: what the last review sent back is worked on, and once the suite passes the run goes on.
    expect(result.passed).toBe(true);
    expect(asked.filter((turn) => turn.role === "reviewer")).toHaveLength(2);
    // Only the second review that sends them back is weighed: the first goes to the conformance agent as it is.
    expect(asked.filter((turn) => turn.role === "arbiter")).toHaveLength(1);
    const feedback = asked.filter((turn) => turn.role === "conformance agent" && turn.prompt.includes("found how to make them better"));
    expect(feedback).toHaveLength(2);
    expect(feedback.at(-1)!.prompt).toContain("1. BLOCKING · MISSING · test_acceptance_hello.py: The acceptance test skips the backup it checks.");
    expect(readFileSync(join(codeDir, ".turri-notes.md"), "utf8")).toContain("the conformance tests went on after 2 reviews, the last one's problems worked on but not reviewed again");
  });

  it("approves the tests at the second failed review when the arbiter finds the reviewer picky - what it let go is kept in the notes", async () => {
    reviewSays = () => ({ pass: false, problems: [{ file: "test_acceptance_hello.py", kind: "bad", what: "It could log more.", blocking: false }] });
    arbiterRules = () => [{ problem: 1, uphold: false, why: "a nitpick: logging is not what the spec states" }];
    const result = await renderConformanceTests({ plainFile: join(root, "app.plain"), frid: "1", buildDir: codeDir, conformanceDir: join(root, "plain_modules", "app", "tests") });
    expect(result.passed).toBe(true);
    expect(asked.filter((turn) => turn.role === "reviewer")).toHaveLength(2);
    expect(asked.filter((turn) => turn.role === "arbiter")).toHaveLength(1);
    expect(asked.find((turn) => turn.role === "arbiter")!.prompt).toContain("You are the arbiter of the conformance tests of functionality 1");
    expect(result.reviewWaived).toEqual([{ file: "test_acceptance_hello.py", kind: "bad", what: "It could log more.", blocking: false }]);
    expect(readFileSync(join(codeDir, ".turri-notes.md"), "utf8")).toContain("the arbiter let go what the conformance test review raised");
  });

  it("stops with what the review last found when the tests never pass it", async () => {
    reviewSays = () => ({ pass: false, problems: [{ file: "test_acceptance_hello.py", kind: "missing", what: "The acceptance test's exit code check is missing." }] });
    const result = await renderConformanceTests({ plainFile: join(root, "app.plain"), frid: "1", buildDir: codeDir, conformanceDir: join(root, "plain_modules", "app", "tests"), maxRounds: 3 });
    expect(result.passed).toBe(false);
    expect(result.review).toEqual([{ file: "test_acceptance_hello.py", kind: "missing", what: "The acceptance test's exit code check is missing." }]);
    const { describeStop } = await import("../../src/grow/stop-report.ts");
    expect(describeStop({ moduleName: "app", frid: "1", at: "conformance", conformance: result })).toContain("never passed review");
  });
});
