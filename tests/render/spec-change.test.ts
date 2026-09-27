import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTestScripts } from "../test-scripts.ts";
import { NOTES_FILE, readNotes } from "../../src/render/notes.ts";

/** The agent is stubbed: it writes a unit test and runs the whole suite, and it passes. */
const prompts: string[] = [];
type StubSession = { tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> };
async function agentRunning(command: string, session: StubSession, prompt: string) {
  // Asked to leave notes, it does - and that is not a turn the test is about.
  if (prompt.startsWith("Before you finish: call update_notes")) {
    await session.tools.find((candidate) => candidate.name === "update_notes")!.execute("id", {
      changes: [{ section: "where", action: "add", text: "stub agent was here" }],
    });
    return "Done.";
  }
  prompts.push(prompt);
  // The coding agent checks its unit tests; the conformance agent, which has no code, its suite.
  const check = session.tools.find((tool) => tool.name === "run_unit_tests") ?? session.tools.find((tool) => tool.name === "run_conformance_tests")!;
  await check.execute("id", { command });
  return "Done.";
}
/** As a real agent would: a unit test, then the whole suite - the run the harness then repeats. */
async function passingAgent(session: StubSession, prompt: string) {
  if (prompt.startsWith("Before you finish: call update_notes")) return agentRunning("", session, prompt);
  // The explorer a conformance run starts with, and the judge of a failing run.
  const own = (name: string) => session.tools.find((tool) => tool.name === name);
  if (own("submit_exploration")) {
    const long = "python3 app.py, from the build folder, with nothing else around it at all.";
    await own("submit_exploration")!.execute("id", {
      build_and_run: long,
      tests_reach_it: long,
      interfaces: [{ module: "app", id: "1", how: long }],
      environment: long,
      plan: [{ module: "app", id: "1", tests: long }],
    });
    return "Done.";
  }
  if (own("submit_verdict")) return (await own("submit_verdict")!.execute("id", { culprit: "tests", reason: "stub" }), "Done.");
  await session.tools.find((tool) => tool.name === "write")!.execute("id", {
    path: "test_app.py",
    content: "import unittest\n\nclass AppTest(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n",
  });
  return agentRunning("python3 -m unittest discover", session, prompt);
}
vi.mock("../../src/pi.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pi.ts")>();
  return {
    ...actual,
    createExecutor: async (opts: { customTools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> }) => ({
      tools: opts.customTools,
      dispose() {},
    }),
    ask: vi.fn(passingAgent),
  };
});

const { applySpecDiff, renderSpecDiff, snapshotSpec } = await import("../../src/render/spec-change.ts");
const { buildSpecDiffPrompt } = await import("../../src/render/prompt.ts");
const { readBuiltTree } = await import("../../src/render/state.ts");
const { listFiles } = await import("../../src/render/testing.ts");
/** The spec as the parser has it now. */
const parsed = () => plainFileParser("app.plain", resolveTemplateDirs(join(dir, "app.plain")))[1];
const { plainFileParser } = await import("../../src/plain/parser.ts");
const { resolveTemplateDirs } = await import("../../src/render/render.ts");

let dir: string;
let cwd: string;
const plain = (fs: string[]) => `***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n${fs.join("\n\n")}\n`;
const diffOf = (before: string, after: string) =>
  [
    "diff --git a/app.plain b/app.plain",
    "--- a/app.plain",
    "+++ b/app.plain",
    `@@ -1,${before.split("\n").length - 1} +1,${after.split("\n").length - 1} @@`,
    ...before.split("\n").slice(0, -1).map((line) => `-${line}`),
    ...after.split("\n").slice(0, -1).map((line) => `+${line}`),
    "",
  ].join("\n");

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "plainwright-specdiff-")));
  writeTestScripts(dir);
  cwd = process.cwd();
  process.chdir(dir);
  prompts.length = 0;
  // A test that makes the agent fail must not leave it failing for the next one.
  const { ask } = await import("../../src/pi.ts");
  vi.mocked(ask).mockImplementation(passingAgent as never);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

describe("applying the spec diff with git", () => {
  it("applies it, accepts it already applied, and refuses one that fits neither way", () => {
    const before = plain(["- One."]);
    const after = plain(["- One.", "- Two."]);
    writeFileSync(join(dir, "app.plain"), before);
    const diff = diffOf(before, after);

    expect(applySpecDiff(diff, dir)).toBe("applied");
    expect(readFileSync(join(dir, "app.plain"), "utf8")).toBe(after);
    expect(applySpecDiff(diff, dir)).toBe("already applied");

    writeFileSync(join(dir, "app.plain"), plain(["- Something else entirely."]));
    expect(() => applySpecDiff(diff, dir)).toThrow(/does not apply/);
  });
});

describe("the change agent's prompt", () => {
  it("carries the diff and every spec as it now stands, the required modules' first", () => {
    const prompt = buildSpecDiffPrompt({
      moduleName: "app",
      diff: "+- Two.",
      specifications: { definitions: [], "implementation reqs": ["- Python."], "test reqs": [], "functional specs": ["- One.", "- Two."] },
      required: [{ module: "base", frid: "1", spec: "- Base." }],
      linkedResources: [],
      empty: false,
    });
    expect(prompt).toContain("<spec change>\n+- Two.\n</spec change>");
    expect(prompt.indexOf('module="base" id="1"')).toBeLessThan(prompt.indexOf('module="app" id="2"'));
    expect(prompt).toContain("Implement what the change adds. Update what it changes. Remove what it removes");
  });

  it("says so when there is nothing built to change", () => {
    const prompt = buildSpecDiffPrompt({
      moduleName: "app", diff: "+- One.", linkedResources: [], required: [], empty: true,
      specifications: { definitions: [], "implementation reqs": [], "test reqs": [], "functional specs": ["- One."] },
    });
    expect(prompt).toContain("Nothing is built yet");
  });
});

describe("rendering a spec diff", () => {
  it("from scratch: applies the diff, renders it, and records the specs as they now stand", async () => {
    writeFileSync(join(dir, "app.plain"), plain(["- One."]));
    const diff = diffOf(plain(["- One."]), plain(["- One.", "- Two."]));

    const result = await renderSpecDiff({ plainFile: "app.plain", diff, cwd: dir });

    expect(result.diff).toBe("applied");
    expect(result.passed).toBe(true);
    expect(result.buildDir).toBe(join(dir, "plain_modules", "app", "code"));
    expect(prompts[0]).toContain("<spec change>");
    expect(prompts[0]).toContain('<functionality module="app" id="2">\n- Two.');
    // What the code is built from: the spec with the change in, and nothing else in the file.
    expect(readBuiltTree(result.buildDir)).toEqual(parsed());
    expect(Object.keys(JSON.parse(readFileSync(join(result.buildDir, ".plainwright.json"), "utf8"))).sort()).toEqual(["functional specs", "implementation reqs"]);
  });

  it("ignores the conformance testing script when conformance is turned off - in the prompt and in the runs", async () => {
    const withTests = (fs: string[]) => plain(fs).replace("***functional specs***", "***test reqs***\n\n- unittest.\n\n***functional specs***");
    writeFileSync(join(dir, "app.plain"), withTests(["- One."]));
    // Conformance tests already here that would fail: turned off, nothing runs them.
    const tests = join(dir, "plain_modules", "app", "tests");
    mkdirSync(tests, { recursive: true });
    writeFileSync(join(tests, "test_conformance_one.py"), "import unittest\n\nclass T(unittest.TestCase):\n    def test_x(self):\n        self.fail()\n");

    const result = await renderSpecDiff({
      plainFile: "app.plain",
      diff: diffOf(withTests(["- One."]), withTests(["- One.", "- Two."])),
      cwd: dir,
      conformance: false,
    });

    expect(prompts[0]).toContain('<script kind="unit tests"');
    expect(prompts[0]).not.toContain("conformance tests\" path=");
    expect(result.regression).toMatchObject({ passed: true, runs: [], conformanceOff: true });
    expect(result.passed).toBe(true);
  });

  it("starts from the notes earlier agents left, and leaves its own, labelled as the spec change", async () => {
    writeFileSync(join(dir, "app.plain"), plain(["- One."]));
    const code = join(dir, "plain_modules", "app", "code");
    mkdirSync(code, { recursive: true });
    writeFileSync(join(code, NOTES_FILE), "# Working notes\n\n## Assumptions\n\n- [2026-09-24 09:00 · app 1] One means exactly one\n");
    const diff = diffOf(plain(["- One."]), plain(["- One.", "- Two."]));

    await renderSpecDiff({ plainFile: "app.plain", diff, cwd: dir });

    expect(prompts[0]).toContain("<notes from earlier agents>");
    expect(prompts[0]).toContain("- [2026-09-24 09:00 · app 1] One means exactly one");
    expect(readNotes(code).where).toEqual([expect.stringMatching(/^\[[\d: -]+ · app spec change\] stub agent was here$/)]);
    expect(readNotes(code).assumptions).toEqual(["[2026-09-24 09:00 · app 1] One means exactly one"]);
  });

  it("stops at the unit tests when they do not pass, and undoes the change - no code, no tree", async () => {
    writeFileSync(join(dir, "app.plain"), plain(["- One."]));
    mkdirSync(join(dir, "plain_modules", "app", "code"), { recursive: true });
    const { ask } = await import("../../src/pi.ts");
    // It writes code, and its unit tests fail.
    vi.mocked(ask).mockImplementation((async (session: StubSession, prompt: string) => {
      if (!prompt.startsWith("Before you finish")) await session.tools.find((tool) => tool.name === "write")!.execute("id", { path: "app.py", content: "print('uno')\n" });
      return agentRunning("false", session, prompt);
    }) as never);
    const result = await renderSpecDiff({ plainFile: "app.plain", diff: diffOf(plain(["- One."]), plain(["- Uno."])), cwd: dir });
    expect(result.stoppedAt).toBe("unit tests");
    expect(readBuiltTree(result.buildDir)).toBeNull();
    expect(listFiles(result.buildDir)).toEqual([]);
  });
});

describe("rendering a spec diff before any functional spec exists", () => {
  it("renders a change that only adds definitions, and records the sections", async () => {
    const before = "***implementation reqs***\n\n- Python.\n";
    const after = "***definitions***\n\n- :User: is a person.\n\n***implementation reqs***\n\n- Python.\n";
    writeFileSync(join(dir, "app.plain"), before);
    const diff = [
      "diff --git a/app.plain b/app.plain",
      "--- a/app.plain",
      "+++ b/app.plain",
      "@@ -1,3 +1,7 @@",
      "+***definitions***",
      "+",
      "+- :User: is a person.",
      "+",
      " ***implementation reqs***",
      " ",
      " - Python.",
      "",
    ].join("\n");

    const result = await renderSpecDiff({ plainFile: "app.plain", diff, cwd: dir });

    expect(readFileSync(join(dir, "app.plain"), "utf8")).toBe(after);
    expect(prompts.at(-1)).toContain("+- :User: is a person.");
    expect(result.passed).toBe(true);
    expect(readBuiltTree(result.buildDir)).toEqual({
      definitions: [{ markdown: "- :User: is a person." }],
      "implementation reqs": [{ markdown: "- Python." }],
    });
  });
});

describe("conformance for a spec change", () => {
  it("follows the change whatever it touches - a definition, with no functional spec written yet", async () => {
    const before = "***implementation reqs***\n\n- Python.\n\n***test reqs***\n\n- :ConformanceTests: use unittest.\n";
    const after = "***definitions***\n\n- :User: is a person.\n\n" + before;
    writeFileSync(join(dir, "app.plain"), before);
    const diff = [
      "diff --git a/app.plain b/app.plain",
      "--- a/app.plain",
      "+++ b/app.plain",
      "@@ -1,3 +1,7 @@",
      "+***definitions***",
      "+",
      "+- :User: is a person.",
      "+",
      " ***implementation reqs***",
      " ",
      " - Python.",
      "",
    ].join("\n");

    const result = await renderSpecDiff({ plainFile: "app.plain", diff, cwd: dir });

    expect(readFileSync(join(dir, "app.plain"), "utf8")).toBe(after);
    // The conformance step ran: the agent was asked, and the whole suite with it passes.
    expect(result.conformance).toBeDefined();
    expect(result.conformance!.passed).toBe(true);
    const conformancePrompt = prompts.find((prompt) => prompt.includes("You are writing conformance tests"))!;
    expect(conformancePrompt).toContain("+- :User: is a person.");
    expect(conformancePrompt).toContain("The change is tested whatever it touches");
    expect(conformancePrompt).toContain('"conformance tests of the spec"');
    expect(result.passed).toBe(true);
  });
});

describe("renders queued behind the interview", () => {
  it("render a diff that later changes have since gone on top of, without applying it again", async () => {
    const { createRenderQueue } = await import("../../src/render/queue.ts");
    const { createJobRegistry } = await import("../../src/render/jobs.ts");
    const one = plain(["- One."]);
    const two = plain(["- One.", "- Two."]);
    const three = plain(["- One, now reworded.", "- Two.", "- Three."]);
    writeFileSync(join(dir, "app.plain"), one);

    // As write_spec_diff does: each diff applied, and the spec parsed, the moment it is written.
    const first = diffOf(one, two);
    const second = diffOf(two, three);
    expect(applySpecDiff(first, dir)).toBe("applied");
    const afterFirst = snapshotSpec("app.plain", { cwd: dir });
    expect(applySpecDiff(second, dir)).toBe("applied");
    const afterSecond = snapshotSpec("app.plain", { cwd: dir });
    // The first no longer fits the file either way - which is what made its render fail.
    expect(() => applySpecDiff(first, dir)).toThrow(/does not apply/);

    const registry = createJobRegistry();
    const queue = createRenderQueue({ registry, cwd: dir });
    const jobs = [
      queue.enqueueSpecDiff({ plainFile: "app.plain", diff: first, applied: "applied", spec: afterFirst }),
      queue.enqueueSpecDiff({ plainFile: "app.plain", diff: second, applied: "applied", spec: afterSecond }),
    ];
    // Both are on the queue as it is shown - render_status reads this - as spec diffs, in order.
    expect(queue.status().map((entry) => [entry.position, entry.what.startsWith("spec diff: ")])).toEqual([[1, true], [2, true]]);
    await queue.drain();

    expect(jobs.map((job) => registry.get(job.jobId)!.status)).toEqual(["succeeded", "succeeded"]);
    expect(queue.status().map((entry) => entry.status)).toEqual(["succeeded", "succeeded"]);
    expect(readFileSync(join(dir, "app.plain"), "utf8")).toBe(three);
    // Each was built from the spec as it stood with its own change in, not as the file is now.
    const changes = prompts.filter((prompt) => !prompt.includes("describe_how_to_try_it"));
    expect(changes[0]).toContain("- Two.");
    expect(changes[0]).not.toContain("- Three.");
    expect(changes[1]).toContain("- Three.");
  });

  it("record the spec the change was written against - every section - and the diff", async () => {
    const one = plain(["- One."]);
    const two = "***definitions***\n\n- :User: is a person.\n\n" + plain(["- One.", "- :User: signs in."]);
    const three = plain(["- Something else."]);
    writeFileSync(join(dir, "app.plain"), one);
    const change = diffOf(one, two);
    expect(applySpecDiff(change, dir)).toBe("applied");
    const spec = snapshotSpec("app.plain", { cwd: dir });
    // A later change goes into the file before this one's render starts.
    writeFileSync(join(dir, "app.plain"), three);

    const result = await renderSpecDiff({ plainFile: "app.plain", diff: change, cwd: dir, applied: "applied", spec });

    expect(result.diff).toBe("applied");
    // The spec as it stood with this change in - not the file as it is now.
    expect(readBuiltTree(result.buildDir)).toEqual(spec.tree);
    expect((readBuiltTree(result.buildDir)!["functional specs"] as Array<{ markdown: string }>).map((f) => f.markdown)).toEqual(["- One.", "- :User: signs in."]);
  });

  it("leave each spec diff in the history, oldest first - and the tree as the last one left it", async () => {
    const one = plain(["- One."]);
    const two = plain(["- One.", "- Two."]);
    const three = plain(["- One.", "- Two.", "- Three."]);
    writeFileSync(join(dir, "app.plain"), one);
    const first = diffOf(one, two);
    const second = diffOf(two, three);

    await renderSpecDiff({ plainFile: "app.plain", diff: first, cwd: dir });
    const result = await renderSpecDiff({ plainFile: "app.plain", diff: second, cwd: dir });

    const { historyLog } = await import("../../src/render/history.ts");
    expect(historyLog(result.buildDir).split("\n").filter((line) => line.includes("spec diff:"))).toHaveLength(2);
    expect(readBuiltTree(result.buildDir)).toEqual(parsed());
  });
});

describe("the history of a rendered spec change", () => {
  it("commits the change with the diff it rendered", async () => {
    const { head, historyLog, historyShow } = await import("../../src/render/history.ts");
    writeFileSync(join(dir, "app.plain"), plain(["- One."]));
    const diff = diffOf(plain(["- One."]), plain(["- One.", "- Two."]));

    const result = await renderSpecDiff({ plainFile: "app.plain", diff, cwd: dir });
    writeFileSync(join(result.buildDir, "app.py"), "x\n"); // what an agent would have written
    const { recordHistory } = await import("../../src/render/history.ts");
    recordHistory(result.buildDir, "render app fs 2");

    const log = historyLog(result.buildDir);
    expect(log).toMatch(/spec diff: app\.plain \+\d+ −\d+ · .+/);
    const commit = log.split("\n").find((line) => line.includes("spec diff:"))!.split("  ")[0]!;
    expect(historyShow(result.buildDir, commit)).toContain("+- Two.");
    expect(head(result.buildDir)).toBeDefined();
  });
});
