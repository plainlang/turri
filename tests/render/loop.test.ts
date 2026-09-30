import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJobRegistry } from "../../src/render/jobs.ts";
import { createWorkLoop, type JobRunner } from "../../src/render/loop.ts";
import { codeTree, readRecord, writeCodeRecord } from "../../src/render/records.ts";
import { recordHistory } from "../../src/render/history.ts";
import { snapshotSpec } from "../../src/render/spec-change.ts";

let dir: string;
let cwd: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plainwright-loop-"));
  cwd = process.cwd();
  process.chdir(dir);
  writeFileSync(join(dir, "config.yaml"), "conformance-tests: false\n");
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

const app = (specs: string[], reqs = "is Python.") => `***implementation reqs***\n\n- :Implementation: ${reqs}\n\n***test reqs***\n\n- :ConformanceTests: use pytest.\n\n***functional specs***\n\n${specs.map((line) => `- ${line}`).join("\n\n")}\n`;
const codeDir = (module = "app") => join(dir, "plain_modules", module, "code");

/** A runner that lands what it is given, as a render does: the record, committed. Held while `hold` is set. */
function runner() {
  const ran: Array<{ module: string; title: string; add: string[]; patch: string[]; fresh: boolean }> = [];
  const gate: { hold?: Promise<void>; release?: () => void; land: boolean } = { land: true };
  const holdNext = () => {
    gate.hold = new Promise<void>((resolve) => (gate.release = resolve));
  };
  const run: JobRunner = async (job) => {
    ran.push({ module: job.moduleName, title: job.planned.title, add: job.planned.cases.add.map((spec) => spec.frid), patch: job.planned.cases.patch.map((spec) => spec.frid), fresh: job.planned.cases.fresh });
    const hold = gate.hold;
    gate.hold = undefined;
    if (hold !== undefined) await hold;
    if (!gate.land) return { landed: false, report: "did not pass" };
    // As a render leaves it: code, and the record of what it is built from, committed.
    mkdirSync(job.buildDir, { recursive: true });
    writeFileSync(join(job.buildDir, `${job.moduleName}.py`), `# ${job.planned.title}\n`, { flag: "a" });
    writeCodeRecord(job.buildDir, job.spec.tree);
    recordHistory(job.buildDir, job.planned.title);
    return { landed: true, report: "landed" };
  };
  return { ran, gate, holdNext, run };
}

describe("the work loop", () => {
  it("builds a module nothing is built of, job by job, until its code record is the spec as the code sees it - its first job fresh", async () => {
    writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye.", "Count to ten."]));
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(ran.map((job) => job.add)).toEqual([["1"], ["2"], ["3"]]);
    expect(ran.map((job) => job.fresh)).toEqual([true, false, false]);
    expect(readRecord(codeDir())).toEqual(codeTree(snapshotSpec(join(dir, "app.plain"), { cwd: dir }).tree));
    expect(loop.status()[0]).toMatchObject({ module: "app", planned: [], why: "built from the spec as it is" });
  });

  it("has nothing to do when only the test reqs changed", async () => {
    writeFileSync(join(dir, "app.plain"), app(["Say hello."]));
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    await loop.bringUp("app.plain");
    await loop.drain();
    writeFileSync(join(dir, "app.plain"), app(["Say hello."]).replace("use pytest.", "use pytest, one file each."));
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(ran).toHaveLength(1);
  });

  it("plans again from what landed when the spec changes, and patches the functional spec that changed", async () => {
    writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye."]));
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    await loop.bringUp("app.plain");
    await loop.drain();
    writeFileSync(join(dir, "app.plain"), app(["Say hello loudly.", "Say goodbye."]));
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(ran.at(-1)).toMatchObject({ add: [], patch: ["1"] });
  });

  it("stops the running job once the spec no longer wants what it builds, rolls it back, and builds the spec as it now is", async () => {
    writeFileSync(join(dir, "app.plain"), app(["Say hello."]));
    const { ran, gate, holdNext, run } = runner();
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false, run });
    holdNext();
    await loop.bringUp("app.plain");
    const first = loop.status()[0]!.running!.jobId;
    // The functional spec it is building is rewritten while it runs.
    writeFileSync(join(dir, "app.plain"), app(["Say hello in French."]));
    await loop.bringUp("app.plain");
    // Stopped, its agent is aborted and it lands nothing.
    gate.land = false;
    gate.release!();
    const stopped = await registry.wait(first);
    expect(stopped.status).toBe("stopped");
    gate.land = true;
    await loop.drain();
    expect(ran).toHaveLength(2);
    expect(JSON.stringify(readRecord(codeDir()))).toContain("Say hello in French.");
  });

  it("plans what comes after the running job as soon as the spec changes - from what it will land - and lists it as jobs queued behind it", async () => {
    writeFileSync(join(dir, "app.plain"), app(["Say hello."]));
    const { ran, gate, holdNext, run } = runner();
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false, run });
    holdNext();
    await loop.bringUp("app.plain");
    const first = loop.status()[0]!.running!.jobId;
    writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye.", "Count to ten."]));
    await loop.bringUp("app.plain");
    expect(loop.status()[0]!.planned.map((job) => job.cases.add.map((spec) => spec.frid))).toEqual([["2"], ["3"]]);
    const planned = loop.planned();
    expect(planned.map((job) => [job.status, job.summary, job.waitingOn])).toEqual([
      ["queued", "app.plain Say goodbye.", [first]],
      ["queued", "app.plain Count to ten.", [planned[0]!.id]],
    ]);
    gate.release!();
    await loop.drain();
    expect(ran.map((job) => job.add)).toEqual([["1"], ["2"], ["3"]]);
    expect(loop.planned()).toEqual([]);
  });

  it("lets the running job finish when the change comes on top of what it builds", async () => {
    writeFileSync(join(dir, "app.plain"), app(["Say hello."]));
    const { ran, gate, holdNext, run } = runner();
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false, run });
    holdNext();
    await loop.bringUp("app.plain");
    const first = loop.status()[0]!.running!.jobId;
    writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye."]));
    await loop.bringUp("app.plain");
    expect(registry.get(first)!.status).toBe("running");
    gate.release!();
    await loop.drain();
    expect(ran.map((job) => job.add)).toEqual([["1"], ["2"]]);
  });

  it("halts a module whose job did not land, until the spec changes or it is asked for again", async () => {
    writeFileSync(join(dir, "app.plain"), app(["Say hello."]));
    const { ran, gate, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    gate.land = false;
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(ran).toHaveLength(1);
    expect(loop.status()[0]!.why).toMatch(/did not land/);
    gate.land = true;
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(ran).toHaveLength(2);
    expect(readRecord(codeDir())).not.toBeNull();
  });

  it("builds a module built on another only once that one is built, from what it inherits", async () => {
    writeFileSync(join(dir, "base.plain"), "***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n- Users register.\n");
    writeFileSync(join(dir, "top.plain"), "---\nrequires:\n  - base\n---\n\n***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n- The home page says hello.\n");
    const { ran, holdNext, gate, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    holdNext();
    await loop.bringUp("top.plain");
    expect(loop.status().map((module) => [module.module, module.running !== undefined, module.why])).toEqual([
      ["base", true, undefined],
      ["top", false, "waiting for base: the code it is built on is not built yet"],
    ]);
    // Not planned yet, it is in the queue all the same: behind the job of the module it waits for.
    const running = loop.status()[0]!.running!.jobId;
    expect(loop.planned().map((job) => [job.summary, job.status, job.waitingOn])).toEqual([["top.plain - waits for base", "queued", [running]]]);
    gate.release!();
    await loop.drain();
    expect(loop.planned()).toEqual([]);
    expect(ran.map((job) => [job.module, job.add])).toEqual([
      ["base", ["1"]],
      ["top", ["1"]],
    ]);
    // Built on base, it is not fresh: it starts from base's code.
    expect(ran[1]!.fresh).toBe(false);
    expect(JSON.stringify(readRecord(codeDir("top")))).toContain("Users register.");
  });

  it("builds two modules that share nothing side by side - neither waits for the other", async () => {
    writeFileSync(join(dir, "frontend.plain"), app(["Show the home page."]));
    writeFileSync(join(dir, "backend.plain"), app(["Serve the users."]));
    const { ran, gate, holdNext, run } = runner();
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false, run });
    holdNext();
    await loop.bringUp("frontend.plain");
    await loop.bringUp("backend.plain");
    // The frontend's job is held, and the backend's lands all the same.
    await vi.waitFor(() => expect(readRecord(codeDir("backend"))).not.toBeNull());
    expect(ran.map((job) => job.module).sort()).toEqual(["backend", "frontend"]);
    expect(loop.status().find((module) => module.module === "frontend")!.running).toBeDefined();
    expect(readRecord(codeDir("frontend"))).toBeNull();
    gate.release!();
    await loop.drain();
    expect(readRecord(codeDir("frontend"))).not.toBeNull();
  });

  describe("in a requires chain", () => {
    const base = (definition = "a person with an account") =>
      `***definitions***\n\n- :User: is ${definition}.\n\n***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n- A :User: registers.\n`;
    const on = (module: string, spec: string) => `---\nrequires:\n  - base\n---\n\n***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n- ${spec}\n`;

    async function builtChain() {
      writeFileSync(join(dir, "base.plain"), base());
      writeFileSync(join(dir, "app.plain"), on("app", "The home page says hello."));
      const r = runner();
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: r.run });
      await loop.bringUp("app.plain");
      await loop.drain();
      return { ...r, loop };
    }

    it("records in the codebase at the tip the whole chain it holds - the definitions of the module below tagged with it, and what both say once", async () => {
      await builtChain();
      const record = readRecord(codeDir("app"))!;
      expect(record.definitions).toEqual([{ markdown: "- :User: is a person with an account.", module: "base" }]);
      // Both say it: the code below implements it already, so it is base's.
      expect(record["implementation reqs"]).toEqual([{ markdown: "- :Implementation: is Python.", module: "base" }]);
      expect(JSON.stringify(record["required functional specs"])).toContain("A :User: registers.");
    });

    it("makes a change to the module below in the codebase at the tip, and leaves the one below as it was", async () => {
      const { ran, run } = await builtChain();
      const baseRecord = JSON.stringify(readRecord(codeDir("base")));
      writeFileSync(join(dir, "base.plain"), base("a person with a verified email"));
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
      await loop.bringUp("base.plain");
      await loop.drain();
      expect(ran.map((job) => job.module)).toEqual(["base", "app", "app"]);
      expect(JSON.stringify(readRecord(codeDir("app")))).toContain("a verified email");
      expect(JSON.stringify(readRecord(codeDir("base")))).toBe(baseRecord);
    });

    it("brings a codebase left behind up to its spec first, when a new module is to start from it", async () => {
      const { ran, run } = await builtChain();
      writeFileSync(join(dir, "base.plain"), base("a person with a verified email"));
      writeFileSync(join(dir, "admin.plain"), on("admin", "The admin page lists every user."));
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
      await loop.bringUp("admin.plain");
      await loop.drain();
      expect(ran.slice(2).map((job) => job.module)).toEqual(["base", "admin"]);
      expect(JSON.stringify(readRecord(codeDir("base")))).toContain("a verified email");
      expect(JSON.stringify(readRecord(codeDir("admin")))).toContain("a verified email");
    });
  });
});
