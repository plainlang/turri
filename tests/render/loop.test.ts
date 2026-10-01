import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJobRegistry } from "../../src/render/jobs.ts";
import { moduleLanes } from "../../src/render/lanes.ts";
import { createWorkLoop, describeModules, type JobRunner } from "../../src/render/loop.ts";
import { codeTree, readRecord, writeCodeRecord, writeTestsRecord } from "../../src/render/records.ts";
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

  describe("the conformance tests", () => {
    const testsDir = (module = "app") => join(dir, "plain_modules", module, "tests");

    /** A conformance job that records what it wrote the tests for, as the real one does - or does not pass. */
    function conformanceRunner() {
      const ran: Array<{ add: string[]; patch: string[] }> = [];
      const gate = { pass: true };
      const runConformance: JobRunner = async (job) => {
        ran.push({ add: job.planned.cases.add.map((spec) => spec.frid), patch: job.planned.cases.patch.map((spec) => spec.frid) });
        if (!gate.pass) return { landed: false, report: "the tests do not pass" };
        mkdirSync(testsDir(job.moduleName), { recursive: true });
        writeFileSync(join(testsDir(job.moduleName), "test_app.py"), "# conformance\n", { flag: "a" });
        writeTestsRecord(testsDir(job.moduleName), job.planned.step.tree);
        recordHistory(job.buildDir, `conformance: ${job.planned.title}`);
        return { landed: true, report: "passed" };
      };
      return { ran, gate, runConformance };
    }

    it("are written after a job lands and before the next builds on it, with the config on - each functional spec's, as built", async () => {
      writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye."]));
      const code = runner();
      const tests = conformanceRunner();
      const order: string[] = [];
      const loop = createWorkLoop({
        registry: createJobRegistry(),
        cwd: dir,
        planner: false,
        conformanceOn: () => true,
        run: async (job, onDelta) => (order.push(`code ${job.planned.cases.add.join(",")}`), code.run(job, onDelta)),
        runConformance: async (job, onDelta) => (order.push(`tests ${job.planned.cases.add.map((spec) => spec.frid).join(",")}`), tests.runConformance(job, onDelta)),
      });
      await loop.bringUp("app.plain");
      await loop.drain();
      expect(order.map((entry) => entry.split(" ")[0])).toEqual(["code", "tests", "code", "tests"]);
      expect(tests.ran.map((job) => job.add)).toEqual([["1"], ["2"]]);
      const tested = readRecord(testsDir())!;
      expect(JSON.stringify(tested)).toContain("Say goodbye.");
      expect(JSON.stringify(tested)).toContain("use pytest.");
    });

    it("are not written with the config off, until the conversation asks for them - then only for the functional specs it names", async () => {
      writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye."]));
      const code = runner();
      const tests = conformanceRunner();
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, conformanceOn: () => false, run: code.run, runConformance: tests.runConformance });
      await loop.bringUp("app.plain");
      await loop.drain();
      expect(tests.ran).toEqual([]);
      await loop.conformance("app.plain", { frids: ["2"] });
      await loop.drain();
      expect(tests.ran.map((job) => job.add)).toEqual([["2"]]);
      expect(JSON.stringify(readRecord(testsDir()))).not.toContain("Say hello.");
      // Nothing more to write: they are written for what was asked.
      await loop.conformance("app.plain", { frids: ["2"] });
      await loop.drain();
      expect(tests.ran).toHaveLength(1);
    });

    it("rewrite a functional spec's tests once its changed code lands, and write none for what only changed its test reqs in the code", async () => {
      writeFileSync(join(dir, "app.plain"), app(["Say hello."]));
      const code = runner();
      const tests = conformanceRunner();
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, conformanceOn: () => true, run: code.run, runConformance: tests.runConformance });
      await loop.bringUp("app.plain");
      await loop.drain();
      writeFileSync(join(dir, "app.plain"), app(["Say hello loudly."]));
      await loop.bringUp("app.plain");
      await loop.drain();
      expect(tests.ran.at(-1)).toMatchObject({ patch: ["1"] });
      // Only the test reqs: no code job, a conformance job with nothing but them - mechanical.
      const codeJobs = code.ran.length;
      writeFileSync(join(dir, "app.plain"), app(["Say hello loudly."]).replace("use pytest.", "use pytest, one file each."));
      await loop.bringUp("app.plain");
      await loop.drain();
      expect(code.ran).toHaveLength(codeJobs);
      expect(tests.ran.at(-1)).toMatchObject({ add: [], patch: [] });
    });

    it("under conformance-tests: chosen, are written for a functional spec with acceptance tests, and for the rest only once the conversation chooses them - and kept", async () => {
      const withAcceptance = "Say hello.\n\n  ***acceptance tests***\n\n  - It prints hello.";
      writeFileSync(join(dir, "app.plain"), app([withAcceptance, "Say goodbye."]));
      const code = runner();
      const tests = conformanceRunner();
      const registry = createJobRegistry();
      const loop = createWorkLoop({ registry, cwd: dir, planner: false, conformanceOn: () => true, conformanceChosen: () => true, run: code.run, runConformance: tests.runConformance });
      await loop.bringUp("app.plain");
      await loop.drain();
      // Only the one with acceptance tests is tested; the code job that built the other says so, for the conversation to choose.
      expect(tests.ran.map((job) => job.add)).toEqual([["1"]]);
      const reports = registry.list().map((job) => job.report ?? "");
      expect(reports.find((report) => report.includes("conformance-tests: chosen"))).toContain("- fs 2: Say goodbye.");
      expect(reports.filter((report) => report.includes("- fs 1:"))).toEqual([]);

      await loop.conformance("app.plain", { frids: ["2"] });
      await loop.drain();
      expect(tests.ran.map((job) => job.add)).toEqual([["1"], ["2"]]);
      // Chosen once, kept: its changed text has its tests rewritten, with nothing asked again.
      writeFileSync(join(dir, "app.plain"), app([withAcceptance, "Say goodbye politely."]));
      await loop.bringUp("app.plain");
      await loop.drain();
      expect(tests.ran.at(-1)).toMatchObject({ patch: ["2"] });
    });

    it("named in the conversation one after the other, are written for every one named - never taking out the tests of those named before", async () => {
      writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye."]));
      const code = runner();
      const tests = conformanceRunner();
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, conformanceOn: () => false, run: code.run, runConformance: tests.runConformance });
      await loop.bringUp("app.plain");
      await loop.drain();
      await loop.conformance("app.plain", { frids: ["1"] });
      await loop.drain();
      await loop.conformance("app.plain", { frids: ["2"] });
      await loop.drain();
      const tested = JSON.stringify(readRecord(testsDir()));
      expect(tested).toContain("Say hello.");
      expect(tested).toContain("Say goodbye.");
      expect(tests.ran.flatMap((job) => job.add)).toEqual(["1", "2"]);
    });

    it("scheduled ahead of their code, are written in one job once every functional spec named is built - after the code job that builds the last, before the next", async () => {
      writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye.", "Say thanks.", "Say sorry."]));
      const code = runner();
      const tests = conformanceRunner();
      const order: string[] = [];
      const loop = createWorkLoop({
        registry: createJobRegistry(),
        cwd: dir,
        planner: false,
        conformanceOn: () => false,
        run: async (job, onDelta) => (order.push(`code ${job.planned.cases.add.map((spec) => spec.frid).join(",")}`), code.run(job, onDelta)),
        runConformance: async (job, onDelta) => (order.push(`tests ${job.planned.cases.add.map((spec) => spec.frid).join(",")}`), tests.runConformance(job, onDelta)),
      });
      code.holdNext();
      await loop.bringUp("app.plain");
      // Scheduled while the first code job runs: shown at once, after the code job that builds the last of them.
      const [status] = await loop.conformance("app.plain", { frids: ["1", "2"] });
      await loop.conformance("app.plain", { frids: ["4"] });
      const planned = loop.status()[0]!.planned;
      expect(status!.planned.map((job) => job.waitsFor)).toEqual([undefined, ["1", "2"], undefined, undefined]);
      expect(planned.map((job) => `${job.track} ${job.title}`)).toEqual(["code Say goodbye.", "conformance fs 1, fs 2", "code Say thanks.", "code Say sorry.", "conformance fs 4"]);
      code.gate.release!();
      await loop.drain();
      expect(order).toEqual(["code 1", "code 2", "tests 1,2", "code 3", "code 4", "tests 4"]);
      expect(JSON.stringify(readRecord(testsDir()))).not.toContain("Say thanks.");
    });

    it("under conformance-tests: chosen, are to be chosen when the work is planned: what is planned lists what the code jobs add that none is for, chosen or scheduled", async () => {
      const withAcceptance = "Say hello.\n\n  ***acceptance tests***\n\n  - It prints hello.";
      writeFileSync(join(dir, "app.plain"), app([withAcceptance, "Say goodbye.", "Say thanks."]));
      const code = runner();
      const tests = conformanceRunner();
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, conformanceOn: () => true, conformanceChosen: () => true, run: code.run, runConformance: tests.runConformance });
      code.holdNext();
      const [planned] = await loop.bringUp("app.plain");
      expect(planned!.toChoose?.map((touched) => touched.frid)).toEqual(["2", "3"]);
      expect(describeModules([planned!])).toContain("Decide now which are worth black-box tests");
      const [scheduled] = await loop.conformance("app.plain", { frids: ["3"] });
      expect(scheduled!.toChoose?.map((touched) => touched.frid)).toEqual(["2"]);
      code.gate.release!();
      await loop.drain();
      expect(tests.ran.map((job) => job.add)).toEqual([["1"], ["3"]]);
    });

    it("scheduled together, are planned as their group with no agent asked - the code's work still is", async () => {
      writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye.", "Say thanks."]));
      const code = runner();
      const tests = conformanceRunner();
      const asked: number[][] = [];
      const planner = { group: async (specs: Array<{ number: number }>) => (asked.push(specs.map((spec) => spec.number)), undefined), place: async () => undefined };
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner, conformanceOn: () => false, run: code.run, runConformance: tests.runConformance });
      await loop.conformance("app.plain", { frids: ["1", "2"] });
      await loop.bringUp("app.plain");
      await loop.drain();
      expect(tests.ran.map((job) => job.add)).toEqual([["1", "2"]]);
      // Asked once, for the code's three new functional specs - never for the conformance tests.
      expect(asked).toEqual([[1, 2, 3]]);
    });

    it("show the work as being planned while the planner works - never nothing while nothing runs", async () => {
      writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye."]));
      const code = runner();
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const planner = { group: async () => (await held, undefined), place: async () => undefined };
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner, conformanceOn: () => false, run: code.run });
      const brought = loop.bringUp("app.plain");
      await vi.waitFor(() => expect(loop.status()[0]?.planned[0]).toMatchObject({ planning: true, track: "code", title: "the work" }));
      expect(loop.planned()[0]!.note).toMatch(/^Being planned into jobs now/);
      release();
      await brought;
      await loop.drain();
      expect(loop.status()[0]!.planned).toEqual([]);
    });

    it("refuse functional specs the spec does not have - no code job builds them - and schedule nothing", async () => {
      writeFileSync(join(dir, "app.plain"), app(["Say hello."]));
      const code = runner();
      const tests = conformanceRunner();
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, conformanceOn: () => false, run: code.run, runConformance: tests.runConformance });
      await expect(loop.conformance("app.plain", { frids: ["1", "3"] })).rejects.toThrow(/fs 3 is not one of them.*Nothing was scheduled/);
      await loop.bringUp("app.plain");
      await loop.drain();
      expect(tests.ran).toEqual([]);
    });

    it("do not start when the code record does not have a functional spec they test, as they test it - checked as the job starts", async () => {
      writeFileSync(join(dir, "app.plain"), app(["Say hello."]));
      const code = runner();
      const tests = conformanceRunner();
      const registry = createJobRegistry();
      const loop = createWorkLoop({ registry, cwd: dir, planner: false, conformanceOn: () => false, run: code.run, runConformance: tests.runConformance });
      await loop.bringUp("app.plain");
      await loop.drain();
      // Something else holds the module's lanes, so the conformance job is planned now and starts later - by when the record says otherwise.
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      registry.start({ kind: "other", summary: "holds the module", lanes: moduleLanes(join(dir, "app.plain")), run: async () => (await held, { report: "" }) });
      await loop.conformance("app.plain", { frids: ["1"] });
      // Built from other text since - committed, as a regenerate leaves it - and the code job that would catch it up does not land.
      const record = readRecord(codeDir())!;
      writeCodeRecord(codeDir(), { ...record, "functional specs": [{ markdown: "Say hi." }] } as typeof record);
      recordHistory(codeDir(), "built from other text");
      code.gate.land = false;
      release();
      await loop.drain();
      expect(tests.ran).toEqual([]);
      const refused = registry.list().find((job) => job.kind === "render_spec_diff_conformance")!;
      expect(refused.report).toMatch(/Not started: .*fs 1 is not built - plain_modules\/app\/code\/\.plainwright\.json does not have it/);
    });

    it("halt on their own when they do not pass - the code goes on being built - until the spec or the code changes", async () => {
      writeFileSync(join(dir, "app.plain"), app(["Say hello."]));
      const code = runner();
      const tests = conformanceRunner();
      tests.gate.pass = false;
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, conformanceOn: () => true, run: code.run, runConformance: tests.runConformance });
      await loop.bringUp("app.plain");
      await loop.drain();
      expect(tests.ran).toHaveLength(1);
      expect(loop.status()[0]!.why).toMatch(/did not pass/);
      // The code goes on: a new functional spec is built, and - the code changed - its tests are tried again.
      tests.gate.pass = true;
      writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye."]));
      await loop.bringUp("app.plain");
      await loop.drain();
      expect(code.ran).toHaveLength(2);
      expect(tests.ran.length).toBeGreaterThan(1);
      expect(JSON.stringify(readRecord(testsDir()))).toContain("Say goodbye.");
    });
  });
});

describe("a codebase built without a module it now requires", () => {
  it("is left as it is until starting it over is asked for - then its code goes, kept in its history, and the chain is built from the bottom", async () => {
    const { describeModules } = await import("../../src/render/loop.ts");
    const { historyLog } = await import("../../src/render/history.ts");
    const { existsSync } = await import("node:fs");
    writeFileSync(join(dir, "app.plain"), app(["Say hello."]));
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    await loop.bringUp("app.plain");
    await loop.drain();
    // Its spec is split: saying hello moves into a module app now requires.
    writeFileSync(join(dir, "greeting.plain"), app(["Say hello."]));
    writeFileSync(join(dir, "app.plain"), `---\nrequires:\n  - greeting\n---\n\n${app(["Say goodbye."])}`);

    const [status] = await loop.bringUp("app.plain");
    await loop.drain();
    expect(status).toMatchObject({ module: "app", startOver: { requires: ["greeting"], codebases: ["app"] } });
    expect(ran).toHaveLength(1);
    expect(existsSync(join(codeDir(), "app.py"))).toBe(true);
    // The chat is told to ask, and why; the command line, how.
    expect(describeModules([status!])).toContain("Ask the user whether to start app over, and say why: app was built without greeting");
    expect(describeModules([status!], { for: "command line" })).toContain("plainwright module app.plain --start-over");

    await loop.startOver("app.plain");
    await loop.drain();
    expect(ran.slice(1).map((job) => job.module)).toEqual(["greeting", "app"]);
    expect(historyLog(codeDir())).toContain("start from scratch: it now requires greeting");
    expect(loop.status().find((entry) => entry.module === "app")).toMatchObject({ planned: [], why: "built from the spec as it is" });
  });

  it("is not started over when nothing has to be", async () => {
    writeFileSync(join(dir, "app.plain"), app(["Say hello."]));
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: runner().run });
    await expect(loop.startOver("app.plain")).rejects.toThrow("Nothing of app has to be started over");
  });
});

describe("a preview of the next job", () => {
  it("plans on a loop of its own and starts nothing - the job each codebase would start, with its coding agent's prompt - and copies nothing up", async () => {
    const { previewJobs } = await import("../../src/render/loop.ts");
    const { existsSync } = await import("node:fs");
    const { writeTestScripts } = await import("../test-scripts.ts");
    writeTestScripts(dir);
    writeFileSync(join(dir, "app.plain"), app(["Say hello."]));
    const { run } = runner();
    const real = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    await real.bringUp("app.plain");
    await real.drain();
    // A module on top of it, not started: a dry run reads what it would start from, and writes nothing.
    writeFileSync(join(dir, "greet.plain"), `---\nrequires:\n  - app\n---\n\n${app(["Say goodbye."])}`);

    const { previews, busy } = await previewJobs({ plainFile: join(dir, "greet.plain"), cwd: dir, plannerModel: undefined });
    expect(busy).toEqual([]);
    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({ module: "greet", track: "code" });
    expect(previews[0]!.task).toContain("Say goodbye.");
    // What it starts from is app's code, as it would be copied up.
    expect(previews[0]!.task).toContain('<functionality module="app" id="1" status="implemented">');
    expect(existsSync(join(dir, "plain_modules", "greet"))).toBe(false);
  });

  it("leaves out a codebase with a job running: its next job depends on what that one lands", async () => {
    const { previewJobs } = await import("../../src/render/loop.ts");
    const { writeTestScripts } = await import("../test-scripts.ts");
    writeTestScripts(dir);
    writeFileSync(join(dir, "app.plain"), app(["Say hello."]));
    const { previews, busy } = await previewJobs({ plainFile: join(dir, "app.plain"), cwd: dir, busy: (module) => module === "app" });
    expect(previews).toEqual([]);
    expect(busy).toEqual(["app"]);
  });
});

describe("a linked resource", () => {
  const spec = () =>
    "***definitions***\n\n- :Api: is the API the app calls, defined by [api.yaml](api.yaml).\n\n" +
    "***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n- Call :Api: for the users.\n\n- Say hello.\n";

  it("is hashed in the record, on its own: a change to what it holds patches the functional specs using what links it - the job's diff and the agent's change say so", async () => {
    writeFileSync(join(dir, "api.yaml"), "paths:\n  /users: {}\n");
    writeFileSync(join(dir, "app.plain"), spec());
    const code = runner();
    const jobs: Array<{ textDiff: string; changes: string }> = [];
    const { describeSpecChange } = await import("../../src/render/prompt.ts");
    const loop = createWorkLoop({
      registry: createJobRegistry(),
      cwd: dir,
      planner: false,
      run: async (job, onDelta) => (jobs.push({ textDiff: job.planned.step.textDiff, changes: describeSpecChange(job.planned.step.changes) }), code.run(job, onDelta)),
    });
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(JSON.stringify(readRecord(codeDir()))).toMatch(/"target":"api.yaml","digest":"[0-9a-f]{64}"|"digest":"[0-9a-f]{64}"[^}]*"target":"api.yaml"/);
    const built = code.ran.length;

    // Nothing in the .plain file changes: only what the file it links holds.
    writeFileSync(join(dir, "api.yaml"), "paths:\n  /v2/users: {}\n");
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(code.ran.slice(built)).toEqual([expect.objectContaining({ add: [], patch: ["1"] })]);
    const job = jobs.at(-1)!;
    expect(job.textDiff).toContain("diff --git a/api.yaml b/api.yaml");
    expect(job.textDiff).toMatch(/\+api\.yaml, linked by :Api: in app\.plain: its content changed, sha256 [0-9a-f]{64}/);
    expect(job.changes).toContain("its text is as it was:");
    expect(job.changes).toContain("what api.yaml holds changed - it is in <linked resources> as it is now");
  });

  it("in a record written before resources were hashed, is taken as its file is now - hashed and committed, nothing built again", async () => {
    writeFileSync(join(dir, "api.yaml"), "paths:\n  /users: {}\n");
    writeFileSync(join(dir, "app.plain"), spec());
    const code = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: code.run });
    await loop.bringUp("app.plain");
    await loop.drain();
    // As an earlier plainwright wrote it: the links without their hashes.
    const record = readRecord(codeDir())!;
    writeCodeRecord(codeDir(), JSON.parse(JSON.stringify(record), (key, value) => (key === "digest" ? undefined : value)));
    recordHistory(codeDir(), "an older record");
    expect(JSON.stringify(readRecord(codeDir()))).not.toContain("digest");
    const built = code.ran.length;
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(code.ran).toHaveLength(built);
    expect(JSON.stringify(readRecord(codeDir()))).toContain("digest");
  });
});
