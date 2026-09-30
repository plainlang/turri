import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What ran, in order: "spec diff" or "fs <n>". */
const ran: string[] = [];
const diffs: string[] = [];

// A spec diff that lands records the spec it was given, as the real one does.
vi.mock("../../src/render/spec-change.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/render/spec-change.ts")>();
  return {
    ...actual,
    renderSpecDiff: async (options: { diff?: string; spec?: { tree: object; chain?: Array<{ buildDir: string }> } }) => {
      ran.push("spec diff");
      diffs.push(options.diff ?? "");
      const buildDir = options.spec!.chain!.at(-1)!.buildDir;
      (await import("../../src/render/state.ts")).writeBuiltTree(buildDir, options.spec!.tree as never);
      (await import("../../src/render/history.ts")).recordHistory(buildDir, "spec diff");
      return { passed: true, stoppedAt: null };
    },
    describeSpecDiff: () => "rendered",
  };
});

const { createJobRegistry } = await import("../../src/render/jobs.ts");
const { addsOnlyFunctionality, createRenderQueue, coveredPrefix } = await import("../../src/render/queue.ts");
const { readBuiltTree, recordBuiltFunctionality, writeBuiltTree } = await import("../../src/render/state.ts");
const { plainFileParser } = await import("../../src/plain/parser.ts");
const { recordHistory } = await import("../../src/render/history.ts");
const { resolveTemplateDirs } = await import("../../src/render/render.ts");

let dir: string;
let cwd: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plainwright-bring-up-"));
  cwd = process.cwd();
  process.chdir(dir);
  writeFileSync(join(dir, "config.yaml"), "conformance-tests: false\n");
  ran.length = 0;
  diffs.length = 0;
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

const spec = (reqs: string, specs: string[]) => `***implementation reqs***\n\n- :Implementation: ${reqs}\n\n***functional specs***\n\n${specs.map((line) => `- ${line}`).join("\n")}\n`;
const parse = () => plainFileParser("app.plain", resolveTemplateDirs(join(dir, "app.plain")))[1];
const buildDir = () => join(dir, "plain_modules", "app", "code");

/** A queue whose functionality renders record what they build, as the real ones do. */
function queue() {
  const registry = createJobRegistry();
  const q = createRenderQueue({
    registry,
    cwd: dir,
    queueMaster: false,
    run: async (request) => {
      ran.push(`fs ${request.frid}`);
      recordBuiltFunctionality(buildDir(), request.pinned!.tree, request.frid);
      recordHistory(buildDir(), `fs ${request.frid}`);
      return { report: "built", details: { passed: true, landed: true } };
    },
  });
  return { registry, q };
}

/** The spec as built so far: the spec with only its first `count` functional specs, as a module build leaves it. */
function builtUpTo(count: number) {
  const tree = parse();
  writeBuiltTree(buildDir(), { ...tree, "functional specs": (tree["functional specs"] ?? []).slice(0, count) } as never);
  recordHistory(buildDir(), "built so far");
}

describe("bringing the queue up to the spec", () => {
  it("renders every functional spec of a module nothing is built of, one job each, in order", async () => {
    writeFileSync(join(dir, "app.plain"), spec("is Python.", ["Say hello.", "Say goodbye.", "Count to ten."]));
    const { registry, q } = queue();
    const brought = q.bringUpTo("app.plain");
    expect(brought.modules[0]!.specDiff).toBeUndefined();
    expect(brought.modules[0]!.renders.map((render) => render.frid)).toEqual(["1", "2", "3"]);
    for (const id of brought.jobIds) await registry.wait(id);
    expect(ran).toEqual(["fs 1", "fs 2", "fs 3"]);
    expect(JSON.stringify(readBuiltTree(buildDir()))).toBe(JSON.stringify(parse()));
  });

  it("aligns what is built with a spec that moved on in one spec diff first, then renders the functional specs after it - ending on the spec as written", async () => {
    writeFileSync(join(dir, "app.plain"), spec("is Python.", ["Say hello.", "Say goodbye."]));
    builtUpTo(2);
    writeFileSync(join(dir, "app.plain"), spec("is Python 3.12.", ["Say hello.", "Say goodbye.", "Count to ten.", "Sing."]));
    const { registry, q } = queue();
    const brought = q.bringUpTo("app.plain");
    expect(brought.modules[0]!.specDiff).toBeDefined();
    expect(brought.modules[0]!.renders.map((render) => render.frid)).toEqual(["3", "4"]);
    for (const id of brought.jobIds) await registry.wait(id);
    expect(ran).toEqual(["spec diff", "fs 3", "fs 4"]);
    expect(diffs[0]).toContain("Python 3.12");
    expect(diffs[0]).not.toContain("Count to ten.");
    expect(JSON.stringify(readBuiltTree(buildDir()))).toBe(JSON.stringify(parse()));
  });

  it("takes a built functional spec that was reworded into the spec diff, not into a render of its own", async () => {
    writeFileSync(join(dir, "app.plain"), spec("is Python.", ["Say hello.", "Say goodbye.", "Count to ten."]));
    builtUpTo(3);
    writeFileSync(join(dir, "app.plain"), spec("is Python.", ["Say hello.", "Wave goodbye.", "Count to ten.", "Sing."]));
    const { registry, q } = queue();
    const brought = q.bringUpTo("app.plain");
    expect(brought.modules[0]!.renders.map((render) => render.frid)).toEqual(["4"]);
    for (const id of brought.jobIds) await registry.wait(id);
    expect(ran).toEqual(["spec diff", "fs 4"]);
    expect(diffs[0]).toContain("Wave goodbye.");
    expect(JSON.stringify(readBuiltTree(buildDir()))).toBe(JSON.stringify(parse()));
  });

  it("queues nothing when what is built already is the spec", () => {
    writeFileSync(join(dir, "app.plain"), spec("is Python.", ["Say hello."]));
    builtUpTo(1);
    const { q } = queue();
    const brought = q.bringUpTo("app.plain");
    expect(brought.jobIds).toEqual([]);
    expect(brought.modules[0]!.upToDate).toBe(true);
  });

  it("counts as covered every functional spec up to the last one built word for word, and as many as are built when none is", () => {
    const tree = (specs: string[]) => ({ "functional specs": specs.map((markdown) => ({ markdown })) }) as never;
    expect(coveredPrefix(null, tree(["- a", "- b"]))).toBe(0);
    expect(coveredPrefix(tree(["- a", "- b", "- c"]), tree(["- a", "- x", "- b", "- c", "- d"]))).toBe(4);
    expect(coveredPrefix(tree(["- a", "- b"]), tree(["- a2", "- b2", "- c"]))).toBe(2);
  });

  it("still counts a render reworked onto another spec as a render while all it adds to what is built is its functionality", () => {
    const tree = (reqs: string, specs: string[]) => ({ "implementation reqs": [{ markdown: `- :Implementation: ${reqs}` }], "functional specs": specs.map((markdown) => ({ markdown })) }) as never;
    // Built on a req that has changed since: the render's spec has the new req - built, it is already there.
    expect(addsOnlyFunctionality(tree("is Python 3.12.", ["- a"]), tree("is Python 3.12.", ["- a", "- b"]), "2")).toBe(true);
    // The req is not built yet: the render would bring it in too, so it is a spec diff.
    expect(addsOnlyFunctionality(tree("is Python.", ["- a"]), tree("is Python 3.12.", ["- a", "- b"]), "2")).toBe(false);
    expect(addsOnlyFunctionality(null, tree("is Python.", ["- a"]), "1")).toBe(false);
    expect(addsOnlyFunctionality(tree("is Python.", ["- a"]), tree("is Python.", ["- a2", "- b"]), "2")).toBe(false);
  });
});
