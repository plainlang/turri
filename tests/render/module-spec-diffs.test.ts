import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarshalledPlainSource } from "../../src/plain/spec.ts";

/**
 * A module build, with its agents stubbed: a functionality's render and a spec diff's land their
 * work as the real ones do - the tree, a commit - and record what they were asked.
 */
const rendered: string[] = [];
const specDiffs: Array<{ diff: string; applied?: string; tree: MarshalledPlainSource }> = [];
let failingDiff = -1;
/** How many spec diffs had been announced when each render began. */
const announcedBeforeRender: number[] = [];
let announced = 0;

vi.mock("../../src/render/render.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/render/render.ts")>();
  const { recordBuiltFunctionality } = await import("../../src/render/state.ts");
  const { plainFileParser } = await import("../../src/plain/parser.ts");
  return {
    ...actual,
    renderFunctionality: async (options: { plainFile: string; frid: string; buildDir: string }) => {
      rendered.push(options.frid);
      const [, tree] = plainFileParser(basename(options.plainFile), actual.resolveTemplateDirs(options.plainFile));
      mkdirSync(options.buildDir, { recursive: true });
      writeFileSync(join(options.buildDir, `fs_${options.frid}.py`), "x\n");
      recordBuiltFunctionality(options.buildDir, tree, options.frid);
      return {
        moduleName: "app", frid: options.frid, buildDir: options.buildDir, prompt: "", response: "", files: [], added: [],
        functionality: "", runs: [], passed: true, testRemovals: [],
      };
    },
  };
});
vi.mock("../../src/render/spec-change.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/render/spec-change.ts")>();
  const { writeBuiltTree } = await import("../../src/render/state.ts");
  return {
    ...actual,
    renderSpecDiff: async (options: { diff: string; applied?: string; spec: { tree: MarshalledPlainSource; chain: Array<{ buildDir: string }> } }) => {
      announcedBeforeRender.push(announced);
      const index = specDiffs.length;
      specDiffs.push({ diff: options.diff, applied: options.applied, tree: options.spec.tree });
      const passed = index !== failingDiff;
      const buildDir = options.spec.chain.at(-1)!.buildDir;
      if (passed) writeBuiltTree(buildDir, options.spec.tree);
      return {
        moduleName: "app", buildDir, diff: "already applied", response: "", runs: [], attempts: 1, testRemovals: [],
        files: { added: [], changed: [], removed: [] }, passed, stoppedAt: passed ? null : "unit tests",
      };
    },
  };
});

const { renderChain, renderModule } = await import("../../src/render/module.ts");
const { readBuiltTree, recordBuiltFunctionality } = await import("../../src/render/state.ts");
const { plainFileParser } = await import("../../src/plain/parser.ts");
const { resolveTemplateDirs } = await import("../../src/render/render.ts");
const { serializeTree } = await import("../../src/render/spec-steps.ts");
type Planner = import("../../src/render/spec-steps.ts").Planner;

let dir: string;
const file = () => join(dir, "app.plain");
const code = () => join(dir, "plain_modules", "app", "code");
const write = (definitions: string[], reqs: string[], specs: string[]) =>
  writeFileSync(
    file(),
    `***definitions***\n\n${definitions.join("\n\n")}\n\n***implementation reqs***\n\n${reqs.join("\n\n")}\n\n***functional specs***\n\n${specs.join("\n\n")}\n`,
  );
const parsed = () => plainFileParser("app.plain", resolveTemplateDirs(file()))[1];
/** Built as a render would leave it: every functional spec of the spec as it is now. */
const builtNow = () => {
  const tree = parsed();
  for (const frid of ["1", "2", "3"].slice(0, (tree["functional specs"] as unknown[]).length)) recordBuiltFunctionality(code(), tree, frid);
};
/** A planner that puts every change in a step of its own, in order - and says how often it was asked. */
let planned = 0;
const oneEach: Planner = async (request) => {
  planned += 1;
  return request.changes.map((change) => ({ title: `step ${change.id}`, reason: "", changes: [change.id] }));
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "plainwright-module-diffs-")));
  mkdirSync(join(dir, "test_scripts"), { recursive: true });
  writeFileSync(join(dir, "test_scripts", "run_unittests_sh.sh"), "exit 0\n");
  mkdirSync(code(), { recursive: true });
  rendered.length = 0;
  specDiffs.length = 0;
  failingDiff = -1;
  planned = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("a module build", () => {
  const USER = "- :User: is a person.";
  const ORDER = "- :Order: is something a :User: bought.";

  it("renders the functional specs it lacks one by one, when that is all that changed", async () => {
    write([USER, ORDER], ["- Python."], ["- A :User: can sign up."]);
    builtNow();
    write([USER, ORDER], ["- Python."], ["- A :User: can sign up.", "- A :User: can see an :Order:."]);

    const result = await renderModule({ plainFile: file(), planner: oneEach });

    expect(rendered).toEqual(["2"]);
    expect(planned).toBe(0);
    expect(specDiffs).toEqual([]);
    expect(result.specSteps).toBeUndefined();
    expect(result.passed).toBe(true);
  });

  it("brings in anything more as spec diffs: planned, and each rendered from the spec as its step leaves it", async () => {
    write([USER], ["- Python."], ["- A :User: can sign up.", "- A :User: can log in."]);
    builtNow();
    // Functionality 1 changed in place, and a req came in: rendering new specs would miss both.
    write([USER], ["- Python.", "- Every error is JSON."], ["- A :User: can sign up with an email.", "- A :User: can log in."]);

    const result = await renderModule({ plainFile: file(), planner: oneEach });

    expect(rendered).toEqual([]);
    expect(planned).toBe(1);
    expect(result.specSteps?.map((step) => [step.sections, step.result.passed])).toEqual([
      [["implementation reqs"], true],
      [["functional specs"], true],
    ]);
    // Each is built as already in the spec, from its own step's tree, and told the change as ***plain text.
    expect(specDiffs.every((call) => call.applied === "already applied")).toBe(true);
    expect((specDiffs[0]!.tree["functional specs"] as Array<{ markdown: string }>)[0]!.markdown).toBe("- A :User: can sign up.");
    expect(specDiffs[0]!.diff).toContain("+- Every error is JSON.");
    expect(specDiffs[0]!.diff).toContain("--- a/app.plain");
    expect(specDiffs[1]!.diff).toContain("+- A :User: can sign up with an email.");
    // The code is now built from the spec as it stands.
    expect(serializeTree(readBuiltTree(code())!)).toBe(serializeTree(parsed()));
    expect(result).toMatchObject({ passed: true, outcomes: [], completed: ["1", "2"] });
  });

  it("brings in definitions added after a spec change built only the sections, with no functional spec yet", async () => {
    // As a first spec change leaves it: the reqs built, nothing else.
    const { writeBuiltTree } = await import("../../src/render/state.ts");
    writeBuiltTree(code(), { "implementation reqs": [{ markdown: "- Python." }] });
    writeFileSync(join(code(), "app.py"), "x\n");
    write([USER], ["- Python."], ["- A :User: can sign up."]);

    const result = await renderModule({ plainFile: file(), planner: oneEach });

    expect(rendered).toEqual([]);
    expect(planned).toBe(1);
    expect(specDiffs.length).toBeGreaterThan(0);
    expect(specDiffs.map((call) => call.diff).join("\n")).toContain("+- :User: is a person.");
    expect(result.passed).toBe(true);
  });

  it("says which spec diff it is on and shows its diff - to the progress, and in the job's transcript", async () => {
    const { withActivity } = await import("../../src/render/activity.ts");
    write([USER], ["- Python."], ["- A :User: can sign up.", "- A :User: can log in."]);
    builtNow();
    write([USER], ["- Python.", "- Every error is JSON."], ["- A :User: can sign up with an email.", "- A :User: can log in."]);
    failingDiff = 1;

    const events: Array<Record<string, unknown>> = [];
    const transcript: Array<{ kind: string; text: string }> = [];
    const sink = { stage() {}, activity() {}, now() {}, usage() {}, transcript: (entry: { kind: string; text: string }) => transcript.push(entry) };
    announced = 0;
    announcedBeforeRender.length = 0;
    await withActivity(sink, () =>
      renderModule({
        plainFile: file(),
        planner: oneEach,
        onEvent: (event) => {
          if (event.type === "spec_diff_start") announced += 1;
          if (event.type.startsWith("spec_diff")) events.push(event);
        },
      }),
    );
    // Shown before it is rendered, not after.
    expect(announcedBeforeRender).toEqual([1, 2]);

    // Each announced before it is rendered, with the diff it renders, and how it went after.
    expect(events).toEqual([
      { type: "spec_diff_start", index: 1, total: 2, title: "step c1", diff: specDiffs[0]!.diff },
      { type: "spec_diff_done", index: 1, passed: true },
      { type: "spec_diff_start", index: 2, total: 2, title: "step c2", diff: specDiffs[1]!.diff },
      { type: "spec_diff_done", index: 2, passed: false },
    ]);
    expect(transcript.filter((entry) => entry.kind === "diff").map((entry) => entry.text)).toEqual(specDiffs.map((call) => call.diff));
  });

  it("hands its spec diffs over to be queued as render spec diff jobs, in order, when given a queue - rendering none itself", async () => {
    write([USER], ["- Python."], ["- A :User: can sign up.", "- A :User: can log in."]);
    builtNow();
    write([USER], ["- Python.", "- Every error is JSON."], ["- A :User: can sign up with an email.", "- A :User: can log in."]);

    const queued: Array<{ title: string; diff: string; tree: MarshalledPlainSource; plainFile: string }> = [];
    const result = await renderModule({
      plainFile: file(),
      planner: oneEach,
      queueSpecDiffs: (steps) => steps.map((step, index) => (queued.push({ ...step, tree: step.spec.tree }), `job${index + 1}`)),
    });

    expect(specDiffs).toEqual([]);
    expect(rendered).toEqual([]);
    expect(queued.map((step) => step.title)).toEqual(["step c1", "step c2"]);
    expect(queued[0]!.diff).toContain("+- Every error is JSON.");
    expect(queued[1]!.diff).toContain("+- A :User: can sign up with an email.");
    // Each built from the spec as its own step leaves it, as forge-plain's queued diffs are.
    expect((queued[0]!.tree["functional specs"] as Array<{ markdown: string }>)[0]!.markdown).toBe("- A :User: can sign up.");
    expect(queued.every((step) => step.plainFile === file())).toBe(true);
    expect(result.queuedSpecDiffs).toEqual([{ title: "step c1", jobId: "job1" }, { title: "step c2", jobId: "job2" }]);
  });

  it("stops at the first spec diff that does not pass", async () => {
    write([USER], ["- Python."], ["- A :User: can sign up.", "- A :User: can log in."]);
    builtNow();
    write([USER], ["- Python.", "- Every error is JSON."], ["- A :User: can sign up with an email.", "- A :User: can log in."]);
    failingDiff = 0;

    const result = await renderModule({ plainFile: file(), planner: oneEach });

    expect(specDiffs).toHaveLength(1);
    expect(result.passed).toBe(false);
    expect(result.completed).toEqual([]);
  });

  it("is not skipped by the chain when only something around the functional specs changed", async () => {
    write([USER], ["- Python."], ["- A :User: can sign up."]);
    builtNow();
    write(["- :User: is a person with an email."], ["- Python."], ["- A :User: can sign up."]);

    const result = await renderChain({ plainFile: file(), planner: oneEach });

    expect(result.outcomes[0]!.skipped).toBe(false);
    expect(specDiffs).toHaveLength(1);
    expect(specDiffs[0]!.diff).toContain("+- :User: is a person with an email.");
  });

  it("builds functionality by functionality when asked for a range, or to rebuild", async () => {
    write([USER], ["- Python."], ["- A :User: can sign up."]);
    builtNow();
    write([USER], ["- Python.", "- Every error is JSON."], ["- A :User: can sign up."]);

    await renderModule({ plainFile: file(), planner: oneEach, force: true });
    expect(planned).toBe(0);
    expect(rendered).toEqual(["1"]);
  });
});
