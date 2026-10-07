import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTestScripts } from "../test-scripts.ts";
import { NOTES_FILE, readNotes } from "../../src/grow/notes.ts";
import { BEGIN } from "../../src/pi.ts";

/** The agent is stubbed: it writes a unit test and runs the whole suite, and it passes. */
const prompts: string[] = [];
/** The images each agent is made with, by its label. */
const imagesGiven: Array<{ label?: string; images?: unknown[]; system?: string }> = [];
type StubSession = { tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>; task?: string };
async function agentRunning(command: string, session: StubSession, prompt: string) {
  // Asked to leave notes, it does - and that is not a turn the test is about.
  if (prompt.includes("Before you finish: call update_notes")) {
    await session.tools.find((candidate) => candidate.name === "update_notes")!.execute("id", {
      changes: [{ section: "where", action: "add", text: "stub agent was here" }],
    });
    return "Done.";
  }
  // Its task is its instructions: the turn that begins it reads as the task.
  prompts.push(prompt === BEGIN ? (session.task ?? prompt) : prompt);
  // The coding agent checks its unit tests; the conformance agent, which has no code, its suite.
  const check = session.tools.find((tool) => tool.name === "run_unit_tests") ?? session.tools.find((tool) => tool.name === "run_conformance_tests")!;
  await check.execute("id", { command });
  return "Done.";
}
/** As a real agent would: a unit test, then the whole suite - the run the harness then repeats. */
async function passingAgent(session: StubSession, prompt: string) {
  if (prompt.includes("Before you finish: call update_notes")) return agentRunning("", session, prompt);
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
  if (own("submit_review")) return (await own("submit_review")!.execute("id", { pass: true, problems: [] }), "Done.");
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
    createExecutor: async (opts: { customTools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>; task?: string; label?: string; images?: unknown[]; system?: string }) => {
      imagesGiven.push({ label: opts.label, images: opts.images, system: opts.system });
      return { tools: opts.customTools, task: opts.task, dispose() {} };
    },
    ask: vi.fn(passingAgent),
  };
});

const { applySpecDiff, describeSpecDiff, renderSpecDiff, snapshotSpec } = await import("../../src/grow/regrow.ts");
const { buildSpecDiffPrompt } = await import("../../src/grow/prompt.ts");
const { readRecord } = await import("../../src/grow/records.ts");
const { createSteering } = await import("../../src/grow/steering.ts");
const { listFiles } = await import("../../src/grow/testing.ts");
/** The spec as the parser has it now. */
const parsed = () => plainFileParser("app.plain", resolveTemplateDirs(join(dir, "app.plain")))[1];
const { plainFileParser } = await import("../../src/plain/parser.ts");
const { resolveTemplateDirs } = await import("../../src/grow/paths.ts");

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
  dir = realpathSync(mkdtempSync(join(tmpdir(), "turri-specdiff-")));
  writeTestScripts(dir);
  cwd = process.cwd();
  process.chdir(dir);
  prompts.length = 0;
  imagesGiven.length = 0;
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
    // Not told section by section: the raw diff, with which tag each ***heading*** in it is.
    expect(prompt).toContain("+- Two.\n</spec change>");
    expect(prompt).toContain("***implementation reqs*** is\n<implementation reqs>");
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
  it("gives the agent the spec the code is built from - the state before the change - and the change, never the spec after it", async () => {
    writeFileSync(join(dir, "app.plain"), plain(["- One."]));
    await renderSpecDiff({ plainFile: "app.plain", diff: diffOf(plain(["- One."]), plain(["- One."])), cwd: dir, applied: "already applied" });
    prompts.length = 0;
    const diff = diffOf(plain(["- One."]), plain(["- One, loudly.", "- Two."]));
    await renderSpecDiff({ plainFile: "app.plain", diff, cwd: dir });
    expect(prompts[0]).toContain('<already implemented>\n<module name="app" role="current">');
    expect(prompts[0]).toContain('<functionality module="app" id="1" status="implemented">\n- One.');
    expect(prompts[0]).not.toContain('<functionality module="app" id="2">');
    expect(prompts[0]).not.toContain("- One, loudly.\n</functionality>");
    // The change section by section - functionality 1 reworded, 2 added - not the raw diff.
    expect(prompts[0]).toContain('<spec change>\n<functional specs change="1 added, 1 changed">');
    expect(prompts[0]).toContain("  functionality 1 of module `app`\n    before:\n      - One.\n    now:\n      - One, loudly.");
    expect(prompts[0]).toContain("Added:\n  functionality 2 of module `app`:\n  - Two.");
  });

  it("hands the coding agent a linked image to look at, and its prompt says which attachment it is", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
    writeFileSync(join(dir, "mockup.png"), png);
    writeFileSync(join(dir, "app.plain"), plain(["- One."]));
    const diff = diffOf(plain(["- One."]), plain(["- One.", "- Two, as [the mockup](mockup.png) shows."]));

    await renderSpecDiff({ plainFile: "app.plain", diff, cwd: dir });

    const coder = imagesGiven.find((agent) => agent.label?.endsWith("coding agent"));
    expect(coder?.images).toEqual([{ type: "image", data: png.toString("base64"), mimeType: "image/png" }]);
    expect(prompts[0]).toContain('<resource name="the mockup" path="mockup.png" type="image/png">\n[an image: attached to your first message, image 1]');
  });

  it("tells the coding agent up front about its folder and this machine, beside its walls", async () => {
    writeFileSync(join(dir, "app.plain"), plain(["- One."]));
    const diff = diffOf(plain(["- One."]), plain(["- One.", "- Two."]));
    await renderSpecDiff({ plainFile: "app.plain", diff, cwd: dir });
    const coder = imagesGiven.find((agent) => agent.label?.endsWith("coding agent"))!;
    expect(coder.system).toContain("<sandbox>");
    expect(coder.system).toContain("<your folder and this machine>");
    expect(coder.system).toContain("It is not a git repository, and none above it is yours: `my_diff` shows what you have changed in this pulse.");
  });

  it("stops at once, saying what to install, when the unit testing script on this machine cannot find its toolchain - its agent never asked for notes", async () => {
    writeTestScripts(dir, { unit: "#!/bin/bash\necho 'run_unittests.sh: line 3: flutter: command not found'\nexit 127\n" });
    writeFileSync(join(dir, "app.plain"), plain(["- One."]));
    const { ask } = await import("../../src/pi.ts");
    vi.mocked(ask).mockClear();
    const diff = diffOf(plain(["- One."]), plain(["- One.", "- Two."]));

    const stopped = await renderSpecDiff({ plainFile: "app.plain", diff, cwd: dir }).then(
      () => undefined,
      (error: unknown) => error,
    );

    const { EnvironmentError, describeEnvironmentError } = await import("../../src/grow/environment-error.ts");
    expect(stopped).toBeInstanceOf(EnvironmentError);
    const said = describeEnvironmentError(stopped as InstanceType<typeof EnvironmentError>);
    expect(said).toContain("**app stopped: the environment lacks `flutter`.**");
    expect(said).toContain("install flutter on this machine");
    // The work is rolled back, notes and all: there is nothing to leave them in.
    expect(vi.mocked(ask).mock.calls.some(([, prompt]) => String(prompt).includes("Before you finish: call update_notes"))).toBe(false);
  });

  it("gives a steer that came between turns as the agent's next turn, runs the tests again, and lands the spec as it was steered to", async () => {
    writeFileSync(join(dir, "app.plain"), plain(["- One."]));
    const diff = diffOf(plain(["- One."]), plain(["- One.", "- Two."]));
    const grown = snapshotSpec("app.plain", { cwd: dir });
    // While it works, the spec gains a sub-bullet under what it grows: the loop steered it, the agent not yet told.
    writeFileSync(join(dir, "app.plain"), plain(["- One.", "- Two.\n  - Twice."]));
    const steered = parsed();
    const steering = createSteering(grown.tree);
    steering.target = steered;
    steering.agent = steered;
    steering.steers = 1;
    steering.notes.push("functional specs 2 reads otherwise now");

    const result = await renderSpecDiff({ plainFile: "app.plain", diff, cwd: dir, applied: "already applied", spec: grown, steering });

    expect(result.passed).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("The spec changed while you work") && prompt.includes("Twice."))).toBe(true);
    expect(result.steered).toEqual(["functional specs 2 reads otherwise now"]);
    expect(describeSpecDiff(result)).toContain("Steered while it grew");
    expect(JSON.stringify(readRecord(result.buildDir))).toContain("Twice.");
    // Told, nothing waits; and the job no longer reaches its agent once it is done.
    expect(steering.told).toBe(steered);
    expect(steering.deliver).toBeUndefined();
  });

  it("from scratch: applies the diff, renders it, and records the specs as they now stand", async () => {
    writeFileSync(join(dir, "app.plain"), plain(["- One."]));
    const diff = diffOf(plain(["- One."]), plain(["- One.", "- Two."]));

    const result = await renderSpecDiff({ plainFile: "app.plain", diff, cwd: dir });

    expect(result.diff).toBe("applied");
    expect(result.passed).toBe(true);
    expect(result.buildDir).toBe(join(dir, "plain_modules", "app", "code"));
    expect(prompts[0]).toContain("<spec change>");
    // Nothing is built: there is no spec before the change - the change is all of it.
    expect(prompts[0]).toContain("Nothing is built yet");
    expect(prompts[0]).not.toContain("<already implemented>\n");
    // What the code is built from: the spec with the change in, and nothing else in the file.
    expect(readRecord(result.buildDir)).toEqual(parsed());
    expect(Object.keys(JSON.parse(readFileSync(join(result.buildDir, ".turri.json"), "utf8"))).sort()).toEqual(["functional specs", "implementation reqs"]);
  });

  it("lands on its unit tests without a review when the config turns the review off - and is reviewed when it does not", async () => {
    const { ask } = await import("../../src/pi.ts");
    let reviews = 0;
    vi.mocked(ask).mockImplementation((async (session: StubSession, prompt: string) => {
      if (session.tools.some((tool) => tool.name === "submit_review")) reviews += 1;
      return passingAgent(session, prompt);
    }) as never);
    writeFileSync(join(dir, "app.plain"), plain(["- One."]));
    writeFileSync(join(dir, "config.yaml"), "review: false\n");
    const off = await renderSpecDiff({ plainFile: "app.plain", diff: diffOf(plain(["- One."]), plain(["- One.", "- Two."])), cwd: dir });
    expect(off.passed).toBe(true);
    expect(reviews).toBe(0);

    writeFileSync(join(dir, "config.yaml"), "review: true\n");
    const on = await renderSpecDiff({ plainFile: "app.plain", diff: diffOf(plain(["- One.", "- Two."]), plain(["- One.", "- Two.", "- Three."])), cwd: dir });
    expect(on.passed).toBe(true);
    expect(reviews).toBeGreaterThan(0);
  });

  it("is judged by its unit tests alone - the conformance testing script is not in its prompt, and the conformance tests are not run", async () => {
    const withTests = (fs: string[]) => plain(fs).replace("***functional specs***", "***test reqs***\n\n- unittest.\n\n***functional specs***");
    writeFileSync(join(dir, "app.plain"), withTests(["- One."]));
    // Conformance tests already here that would fail: the code job does not run them - the conformance job does.
    const tests = join(dir, "plain_modules", "app", "tests");
    mkdirSync(tests, { recursive: true });
    writeFileSync(join(tests, "test_conformance_one.py"), "import unittest\n\nclass T(unittest.TestCase):\n    def test_x(self):\n        self.fail()\n");

    const result = await renderSpecDiff({ plainFile: "app.plain", diff: diffOf(withTests(["- One."]), withTests(["- One.", "- Two."])), cwd: dir });

    expect(prompts[0]).toContain('<script kind="unit tests"');
    expect(prompts[0]).not.toContain("conformance tests\" path=");
    expect(result.passed).toBe(true);
  });

  it("starts from the notes earlier agents left, and leaves its own, labelled as the spec change - told first that its unit tests passed", async () => {
    writeFileSync(join(dir, "app.plain"), plain(["- One."]));
    const { ask } = await import("../../src/pi.ts");
    vi.mocked(ask).mockClear();
    const code = join(dir, "plain_modules", "app", "code");
    mkdirSync(code, { recursive: true });
    writeFileSync(join(code, NOTES_FILE), "# Working notes\n\n## Assumptions\n\n- [2026-09-24 09:00 · app 1] One means exactly one\n");
    const diff = diffOf(plain(["- One."]), plain(["- One.", "- Two."]));

    await renderSpecDiff({ plainFile: "app.plain", diff, cwd: dir });

    expect(prompts[0]).toContain("<notes from earlier agents>");
    expect(prompts[0]).toContain("- [2026-09-24 09:00 · app 1] One means exactly one");
    expect(readNotes(code).where).toEqual([expect.stringMatching(/^\[[\d: -]+ · app spec change\] stub agent was here$/)]);
    const asked = vi.mocked(ask).mock.calls.map(([, prompt]) => String(prompt)).find((prompt) => prompt.includes("Before you finish: call update_notes"));
    expect(asked).toMatch(/^The harness ran the project's unit testing script on your work itself, and it passed: your work is done and accepted\./);
    expect(readNotes(code).assumptions).toEqual(["[2026-09-24 09:00 · app 1] One means exactly one"]);
  });

  it("stops at the unit tests when they do not pass, and undoes the change - no code, no tree, its agent never asked for notes", async () => {
    writeFileSync(join(dir, "app.plain"), plain(["- One."]));
    mkdirSync(join(dir, "plain_modules", "app", "code"), { recursive: true });
    const { ask } = await import("../../src/pi.ts");
    vi.mocked(ask).mockClear();
    // It writes code, and its unit tests fail.
    vi.mocked(ask).mockImplementation((async (session: StubSession, prompt: string) => {
      if (!prompt.includes("Before you finish: call update_notes")) await session.tools.find((tool) => tool.name === "write")!.execute("id", { path: "app.py", content: "print('uno')\n" });
      return agentRunning("false", session, prompt);
    }) as never);
    const result = await renderSpecDiff({ plainFile: "app.plain", diff: diffOf(plain(["- One."]), plain(["- Uno."])), cwd: dir });
    expect(result.stoppedAt).toBe("unit tests");
    expect(readRecord(result.buildDir)).toBeNull();
    expect(listFiles(result.buildDir)).toEqual([]);
    expect(vi.mocked(ask).mock.calls.some(([, prompt]) => String(prompt).includes("Before you finish: call update_notes"))).toBe(false);
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
    expect(prompts.at(-1)).toContain('<definitions change="1 added">\nAdded:\n  - :User: is a person.\n</definitions>');
    expect(result.passed).toBe(true);
    expect(readRecord(result.buildDir)).toEqual({
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

    // The code first, then its conformance job - given the change section by section, as the work loop gives it.
    const treeOf = () => plainFileParser("app.plain", resolveTemplateDirs(join(dir, "app.plain")), { allowNoFunctionalities: true })[1];
    const treeBefore = treeOf();
    expect((await renderSpecDiff({ plainFile: "app.plain", diff, cwd: dir })).passed).toBe(true);
    const { renderSpecDiffConformance } = await import("../../src/grow/bind.ts");
    const { changesBetween, serializeTree } = await import("../../src/grow/spec-steps.ts");
    const { describeSpecChange } = await import("../../src/grow/prompt.ts");
    const change = describeSpecChange(changesBetween(serializeTree(treeBefore), serializeTree(treeOf())));
    const result = await renderSpecDiffConformance({ plainFile: "app.plain", diff, change, cwd: dir, applied: "already applied" });

    expect(readFileSync(join(dir, "app.plain"), "utf8")).toBe(after);
    // The conformance agent was asked, and the whole suite with it passes.
    const conformancePrompt = prompts.find((prompt) => prompt.includes("You are writing conformance tests"))!;
    // The conformance agent is shown the change section by section, as the coding agent was.
    expect(conformancePrompt).toContain('<definitions change="1 added">\nAdded:\n  - :User: is a person.\n</definitions>');
    expect(conformancePrompt).toContain("The change is tested whatever it touches");
    expect(conformancePrompt).toContain('"conformance tests of the spec"');
    expect(result.passed).toBe(true);
  });
});

describe("the work loop rendering spec diffs", () => {
  it("builds the spec as the files have it, a job at a time - what is built changed first, then a functional spec a job - each told only its own part", async () => {
    const { createWorkLoop, chainSpec } = await import("../../src/grow/loop.ts");
    const { createJobRegistry } = await import("../../src/grow/jobs.ts");
    const { codeTree, readRecord } = await import("../../src/grow/records.ts");
    const { resolveRequiresChain } = await import("../../src/grow/requires.ts");
    writeFileSync(join(dir, "app.plain"), plain(["- Say one number."]));
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false });
    await loop.bringUp("app.plain");
    await loop.drain();
    prompts.length = 0;

    // Changes made while nothing runs, one on top of another: the loop sees only the spec as it now is.
    writeFileSync(join(dir, "app.plain"), plain(["- Say one number, loudly.", "- Two.", "- Three."]));
    await loop.bringUp("app.plain");
    await loop.drain();

    const built = readRecord(join(dir, "plain_modules", "app", "code"));
    expect(built).toEqual(codeTree(chainSpec(resolveRequiresChain(join(dir, "app.plain"))).tree));
    const changes = prompts.flatMap((prompt) => [...prompt.matchAll(/<spec change>\n([\s\S]*?)<\/spec change>/g)].map((match) => match[1]!));
    expect(changes).toHaveLength(3);
    expect(changes[0]).toContain("Say one number, loudly.");
    expect(changes[0]).not.toContain("Two.");
    expect(changes[1]).toContain("Two.");
    expect(changes[2]).toContain("Three.");
    expect(changes[2]).not.toContain("loudly");
    // Each coding agent is told its job's case: the changed functional spec changed in place, the new ones built.
    const tasks = prompts.filter((prompt) => prompt.includes("<spec change>"));
    expect(tasks[0]).toContain("Changed - its text, or a concept it uses: fs 1 of module `app` (Say one number, loudly.)");
    expect(tasks[0]).toContain("Do not build it again from scratch.");
    expect(tasks[1]).toContain("New - build each, and write its unit tests: fs 2 of module `app` (Two.)");
    expect(tasks[2]).toContain("New - build each, and write its unit tests: fs 3 of module `app` (Three.)");
    // Each job that landed code says it can be tried.
    const { TRY_IT_LINE } = await import("../../src/grow/delivery.ts");
    const reports = registry.list().map((job) => job.report ?? "");
    expect(reports).toHaveLength(4);
    expect(reports.every((report) => report.endsWith(TRY_IT_LINE))).toBe(true);
  });

  it("offers nothing to try when a job does not land", async () => {
    const { createWorkLoop } = await import("../../src/grow/loop.ts");
    const { createJobRegistry } = await import("../../src/grow/jobs.ts");
    const { TRY_IT_LINE } = await import("../../src/grow/delivery.ts");
    const { ask } = await import("../../src/pi.ts");
    // An agent that writes nothing, so the unit tests never pass.
    vi.mocked(ask).mockImplementation((async () => "Done.") as never);
    writeFileSync(join(dir, "app.plain"), plain(["- Say one number."]));
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false });
    await loop.bringUp("app.plain");
    await loop.drain();
    const [job] = registry.list();
    expect(job!.details).toMatchObject({ landed: false });
    expect(job!.report ?? "").not.toContain(TRY_IT_LINE);
    expect(loop.status()[0]!.why).toMatch(/did not land/);
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
    expect(readRecord(result.buildDir)).toEqual(spec.tree);
    expect((readRecord(result.buildDir)!["functional specs"] as Array<{ markdown: string }>).map((f) => f.markdown)).toEqual(["- One.", "- :User: signs in."]);
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

    const { historyLog } = await import("../../src/grow/lineage.ts");
    expect(historyLog(result.buildDir).split("\n").filter((line) => line.includes("spec diff:"))).toHaveLength(2);
    expect(readRecord(result.buildDir)).toEqual(parsed());
  });
});

describe("the history of a rendered spec change", () => {
  it("commits the change with the diff it rendered", async () => {
    const { head, historyLog, historyShow } = await import("../../src/grow/lineage.ts");
    writeFileSync(join(dir, "app.plain"), plain(["- One."]));
    const diff = diffOf(plain(["- One."]), plain(["- One.", "- Two."]));

    const result = await renderSpecDiff({ plainFile: "app.plain", diff, cwd: dir });
    writeFileSync(join(result.buildDir, "app.py"), "x\n"); // what an agent would have written
    const { recordHistory } = await import("../../src/grow/lineage.ts");
    recordHistory(result.buildDir, "render app fs 2");

    const log = historyLog(result.buildDir);
    expect(log).toMatch(/spec diff: app\.plain \+\d+ −\d+ · .+/);
    const commit = log.split("\n").find((line) => line.includes("spec diff:"))!.split("  ")[0]!;
    expect(historyShow(result.buildDir, commit)).toContain("+- Two.");
    expect(head(result.buildDir)).toBeDefined();
  });
});

describe("a spec diff that only restructures the specs", () => {
  it("renders nothing - a definition moved to a common module - and records the spec as it is now laid out", async () => {
    const withUser = (fs: string[]) => `***definitions***\n\n- :User: is a person.\n\n${plain(fs)}`;
    writeFileSync(join(dir, "app.plain"), withUser(["- A :User: can register."]));
    const first = await renderSpecDiff({ plainFile: "app.plain", diff: diffOf(withUser(["- A :User: can register."]), withUser(["- A :User: can register."])), cwd: dir, applied: "already applied" });
    expect(first.passed).toBe(true);
    const agentTurns = prompts.length;

    // The definition moves into an import module: the spec the code is built from reads the same.
    writeFileSync(join(dir, "common.plain"), "***definitions***\n\n- :User: is a person.\n");
    const moved = `---\nimport:\n  - common\n---\n\n${plain(["- A :User: can register."])}`;
    writeFileSync(join(dir, "app.plain"), moved);
    const result = await renderSpecDiff({ plainFile: "app.plain", diff: diffOf(withUser(["- A :User: can register."]), moved), cwd: dir, applied: "already applied" });

    expect(result).toMatchObject({ passed: true, restructured: true, attempts: 0 });
    expect(prompts).toHaveLength(agentTurns);
    expect(readRecord(result.buildDir)).toEqual(parsed());
  });

  it("is refused when the module now requires one its code was not built on - that takes a rebuild from scratch", async () => {
    writeFileSync(join(dir, "app.plain"), plain(["- One."]));
    await renderSpecDiff({ plainFile: "app.plain", diff: diffOf(plain(["- One."]), plain(["- One."])), cwd: dir, applied: "already applied" });
    // One moves into a new module that app now requires.
    writeFileSync(join(dir, "accounts.plain"), plain(["- One."]));
    writeFileSync(join(dir, "app.plain"), `---\nrequires:\n  - accounts\n---\n\n${plain(["- Two."])}`);
    await expect(renderSpecDiff({ plainFile: "app.plain", diff: "+- Two.", cwd: dir, applied: "already applied" })).rejects.toThrow(
      /app now requires accounts, which its code was not built on[\s\S]*rejuvenate/,
    );
  });
});
