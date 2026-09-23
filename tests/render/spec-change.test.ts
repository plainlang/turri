import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The agent is stubbed: it runs the unit tests once, and they pass. */
const prompts: string[] = [];
type StubSession = { tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> };
async function agentRunning(command: string, session: StubSession, prompt: string) {
  prompts.push(prompt);
  await session.tools.find((tool) => tool.name === "run_unit_tests")!.execute("id", { command });
  return "Done.";
}
const passingAgent = (session: StubSession, prompt: string) => agentRunning("true", session, prompt);
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

const { applySpecDiff, renderSpecDiff } = await import("../../src/render/spec-change.ts");
const { buildSpecDiffPrompt } = await import("../../src/render/prompt.ts");
const { readState, recordFunctionality, rewriteRecord, specStateFor } = await import("../../src/render/state.ts");
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

describe("the record after a change", () => {
  it("keeps exactly the functionalities the spec now has", () => {
    writeFileSync(join(dir, "app.plain"), plain(["- One.", "- Two.", "- Three."]));
    const [, three] = plainFileParser("app.plain", resolveTemplateDirs(join(dir, "app.plain")));
    const build = join(dir, "build");
    for (const frid of ["1", "2", "3"]) {
      recordFunctionality(build, "app", { frid, ...specStateFor(three, frid), unitTests: "passed", testCommand: `run ${frid}` });
    }

    writeFileSync(join(dir, "app.plain"), plain(["- One.", "- Three."]));
    const [, two] = plainFileParser("app.plain", resolveTemplateDirs(join(dir, "app.plain")));
    rewriteRecord(build, "app", {
      sections: specStateFor(two, "1").sections,
      required: [],
      functionalities: ["1", "2"].map((frid) => ({ frid, ...specStateFor(two, frid), unitTests: "passed" as const })),
    });

    const state = readState(build)!;
    expect(Object.keys(state.functionalities)).toEqual(["1", "2"]);
    expect(state.functionalities["2"]!.spec).toBe("- Three.");
    expect(state.functionalities["1"]!.testCommand).toBe("run 1");
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
    const state = readState(result.buildDir)!;
    expect(Object.values(state.functionalities).map((f) => [f.frid, f.spec, f.unitTests])).toEqual([
      ["1", "- One.", "passed"],
      ["2", "- Two.", "passed"],
    ]);
  });

  it("stops at the unit tests when they do not pass, and still records what the code now holds", async () => {
    writeFileSync(join(dir, "app.plain"), plain(["- One."]));
    mkdirSync(join(dir, "plain_modules", "app", "code"), { recursive: true });
    const { ask } = await import("../../src/pi.ts");
    vi.mocked(ask).mockImplementation(((session: StubSession, prompt: string) => agentRunning("false", session, prompt)) as never);
    const result = await renderSpecDiff({ plainFile: "app.plain", diff: diffOf(plain(["- One."]), plain(["- Uno."])), cwd: dir });
    expect(result.stoppedAt).toBe("unit tests");
    expect(readState(result.buildDir)!.functionalities["1"]).toMatchObject({ spec: "- Uno.", unitTests: "failed" });
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
    const state = readState(result.buildDir)!;
    expect(state.sections.definitions).toEqual(["- :User: is a person."]);
    expect(state.functionalities).toEqual({});
  });
});
