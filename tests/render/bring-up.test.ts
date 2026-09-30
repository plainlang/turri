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
  it("builds a module nothing is built of as one change the queue cuts into jobs - with no agent, a functional spec a job, the reqs with the first", async () => {
    writeFileSync(join(dir, "app.plain"), spec("is Python.", ["Say hello.", "Say goodbye.", "Count to ten."]));
    const { registry, q } = queue();
    const brought = q.bringUpTo("app.plain");
    expect(brought.modules[0]!.specDiff).toBeDefined();
    expect(brought.modules[0]!.renders).toEqual([]);
    await q.drain();
    expect(ran).toEqual(["spec diff", "spec diff", "spec diff"]);
    expect(diffs[0]).toContain("Say hello.");
    expect(diffs[0]).toContain("is Python.");
    expect(diffs[1]).toContain("Say goodbye.");
    expect(diffs[1]).not.toContain("is Python.");
    expect(diffs[2]).toContain("Count to ten.");
    expect(registry.list().map((job) => job.summary)).toEqual(expect.arrayContaining(["app.plain fs 1: Say hello.", "app.plain fs 2: Say goodbye.", "app.plain fs 3: Count to ten."]));
    expect(JSON.stringify(readBuiltTree(buildDir()))).toBe(JSON.stringify(parse()));
  });

  it("aligns what is built with a spec that moved on in one spec diff first, then renders the functional specs after it - ending on the spec as written", async () => {
    writeFileSync(join(dir, "app.plain"), spec("is Python.", ["Say hello.", "Say goodbye."]));
    builtUpTo(2);
    writeFileSync(join(dir, "app.plain"), spec("is Python 3.12.", ["Say hello.", "Say goodbye.", "Count to ten.", "Sing."]));
    const { registry, q } = queue();
    const brought = q.bringUpTo("app.plain");
    expect(brought.modules[0]!.specDiff).toBeDefined();
    await q.drain();
    // What is built, changed, first - then each new functional spec.
    expect(ran).toEqual(["spec diff", "spec diff", "spec diff"]);
    expect(diffs[0]).toContain("Python 3.12");
    expect(diffs[0]).not.toContain("Count to ten.");
    expect(diffs[1]).toContain("Count to ten.");
    expect(diffs[2]).toContain("Sing.");
    expect(registry.list().map((job) => job.summary)).toContain("app.plain spec diff: Changes to what is built");
    expect(JSON.stringify(readBuiltTree(buildDir()))).toBe(JSON.stringify(parse()));
  });

  it("takes a built functional spec that was reworded into the spec diff, not into a render of its own", async () => {
    writeFileSync(join(dir, "app.plain"), spec("is Python.", ["Say hello.", "Say goodbye.", "Count to ten."]));
    builtUpTo(3);
    writeFileSync(join(dir, "app.plain"), spec("is Python.", ["Say hello.", "Wave goodbye.", "Count to ten.", "Sing."]));
    const { registry, q } = queue();
    q.bringUpTo("app.plain");
    await q.drain();
    expect(ran).toEqual(["spec diff", "spec diff"]);
    expect(diffs[0]).toContain("Wave goodbye.");
    expect(diffs[0]).not.toContain("Sing.");
    expect(diffs[1]).toContain("Sing.");
    expect(diffs[1]).not.toContain("+- Wave goodbye.");
    expect(JSON.stringify(readBuiltTree(buildDir()))).toBe(JSON.stringify(parse()));
  });

  it("says on the jobs waiting for it that the queue is being planned, so a long plan never looks like a hang", async () => {
    writeFileSync(join(dir, "app.plain"), spec("is Python.", ["Say hello.", "Say goodbye."]));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const registry = createJobRegistry();
    const q = createRenderQueue({
      registry,
      cwd: dir,
      queueMaster: false,
      // The grouping agent, taking its time.
      chunkAgents: { group: async () => (await held, undefined), place: async () => undefined },
    });
    const brought = q.bringUpTo("app.plain");
    const job = registry.get(brought.jobIds[0]!)!;
    await vi.waitFor(() => expect(job.stage).toContain("planning the queue: which of the 2 new functional specs go together"));
    release();
    await q.drain();
    expect(ran).toEqual(["spec diff", "spec diff"]);
  });

  it("plans a module built on another only once that one has landed - from what its code already implements, which is no new work", async () => {
    const base = "***definitions***\n\n- :User: is a person.\n\n***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n- A :User: registers.\n\n- A :User: signs in.\n";
    const top = "---\nrequires:\n  - base\n---\n\n***implementation reqs***\n\n- :Implementation: is Python.\n\n- Pages are served with Flask.\n\n***functional specs***\n\n- The home page says hello.\n";
    writeFileSync(join(dir, "base.plain"), base);
    writeFileSync(join(dir, "top.plain"), top);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const seen: string[] = [];
    const registry = createJobRegistry();
    const q = createRenderQueue({
      registry,
      cwd: dir,
      queueMaster: false,
      chunkAgents: {
        group: async (specs) => (seen.push(specs.map((spec) => spec.text.split("\n")[0]).join(" | ")), await (specs.some((spec) => spec.text.includes("home page")) ? Promise.resolve() : held), undefined),
        place: async () => undefined,
      },
    });
    q.bringUpTo("top.plain");
    // The module below is planned; the one above waits for it to land.
    await vi.waitFor(() => expect(seen).toEqual(["- A :User: registers. | - A :User: signs in."]));
    // Its one job says so, so it does not read as the whole module built at once.
    const waiting = registry.list().find((job) => job.summary.startsWith("top.plain"))!;
    expect(waiting.summary).toBe("top.plain - planned into jobs once base has landed");
    expect(waiting.note).toContain("Not planned yet");
    release();
    await q.drain();
    expect(seen).toEqual(["- A :User: registers. | - A :User: signs in.", "- The home page says hello."]);
    // Base: a job a functional spec. Top: only what is its own - its Flask req and its functional spec - not
    // Python or User, which the code it starts from implements.
    const topDiffs = diffs.filter((diff) => diff.includes("top.plain"));
    expect(topDiffs).toHaveLength(1);
    expect(topDiffs[0]).toContain("+- Pages are served with Flask.");
    expect(topDiffs[0]).toContain("+- The home page says hello.");
    expect(topDiffs[0]).not.toContain("+- :Implementation: is Python.");
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
