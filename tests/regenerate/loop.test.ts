import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJobRegistry } from "../../src/regenerate/jobs.ts";
import { moduleLanes } from "../../src/regenerate/lanes.ts";
import { createWorkLoop, describeDrift, describeModules, type JobRunner } from "../../src/regenerate/loop.ts";
import { codeTree, readRecord, writeCodeRecord, writeTestsRecord } from "../../src/regenerate/records.ts";
import { recordHistory } from "../../src/regenerate/lineage.ts";
import { copyRequiredCode } from "../../src/regenerate/requires.ts";
import { snapshotSpec } from "../../src/regenerate/regenerate.ts";

let dir: string;
let cwd: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-loop-"));
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
    // Its agent is in its turn: a steer reaches it at once.
    if (job.steering !== undefined) job.steering.deliver = () => true;
    ran.push({ module: job.moduleName, title: job.planned.title, add: job.planned.cases.add.map((spec) => spec.frid), patch: job.planned.cases.patch.map((spec) => spec.frid), fresh: job.planned.cases.fresh });
    const hold = gate.hold;
    gate.hold = undefined;
    if (hold !== undefined) await hold;
    if (!gate.land) return { landed: false, report: "did not pass" };
    // As a render leaves it: code, and the record of what it is built from, committed.
    mkdirSync(job.buildDir, { recursive: true });
    writeFileSync(join(job.buildDir, `${job.moduleName}.py`), `# ${job.planned.title}\n`, { flag: "a" });
    // Steered while it ran, it lands what it was steered to - as a render does.
    writeCodeRecord(job.buildDir, job.steering?.target ?? job.spec.tree);
    recordHistory(job.buildDir, job.planned.title);
    return { landed: true, report: "landed" };
  };
  return { ran, gate, holdNext, run };
}

describe("releasing after each pulse", () => {
  it("releases what each pulse landed as its last stage, under release-after-pulse - before the next pulse starts", async () => {
    writeFileSync(join(dir, "config.yaml"), "conformance-tests: false\nrelease-after-pulse: true\n");
    writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye.", "Count to ten."]));
    const { ran, run } = runner();
    const events: string[] = [];
    const tracked: JobRunner = async (job, onDelta) => {
      events.push(`build ${job.planned.title}`);
      return run(job, onDelta);
    };
    const registry = createJobRegistry();
    const loop = createWorkLoop({
      registry,
      cwd: dir,
      planner: false,
      run: tracked,
      release: async ({ moduleName, title }) => {
        events.push(`release ${title}`);
        return `${moduleName} is running`;
      },
    });
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(ran).toHaveLength(3);
    // One release a pulse, each before the next pulse builds.
    expect(events).toEqual(["build Say hello.", "release Say hello.", "build Say goodbye.", "release Say goodbye.", "build Count to ten.", "release Count to ten."]);
    expect(registry.list().every((job) => job.report?.includes("Released after the pulse: app is running"))).toBe(true);
  });

  it("releases nothing when release-after-pulse is off - the default - or the pulse did not land", async () => {
    writeFileSync(join(dir, "app.plain"), app(["Say hello."]));
    const { gate, run } = runner();
    const release = vi.fn(async () => "released");
    let loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run, release });
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(release).not.toHaveBeenCalled();

    rmSync(join(dir, "plain_modules"), { recursive: true, force: true });
    writeFileSync(join(dir, "config.yaml"), "conformance-tests: false\nrelease-after-pulse: true\n");
    gate.land = false;
    loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run, release });
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(release).not.toHaveBeenCalled();
  });

  it("keeps what a pulse landed when its release fails, and says so", async () => {
    writeFileSync(join(dir, "config.yaml"), "conformance-tests: false\nrelease-after-pulse: true\n");
    writeFileSync(join(dir, "app.plain"), app(["Say hello."]));
    const { run } = runner();
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false, run, release: async () => { throw new Error("port 8000 is taken"); } });
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(registry.list()[0]).toMatchObject({ status: "succeeded", details: { landed: true } });
    expect(registry.list()[0]!.report).toContain("The release after the pulse failed: port 8000 is taken");
  });
});

describe("the work loop", () => {
  it("plans the work not running yet again when the steering changes - a running pulse goes on - and says what the planner did not follow", async () => {
    writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye.", "Count to ten.", "Count to twenty."]));
    const { ran, gate, holdNext, run } = runner();
    let wishes: string[] = [];
    const seen: Array<string[]> = [];
    const planner = {
      group: async (specs: Array<{ number: number }>, _check: unknown, steering?: Array<{ text: string }>) => {
        seen.push((steering ?? []).map((entry) => entry.text));
        // Grouped only once it is asked to be: the counting together, the rest alone.
        return wishes.length === 0
          ? undefined
          : { groups: specs.length === 4 ? [{ specs: [1], title: "Hello" }, { specs: [2], title: "Goodbye" }, { specs: [3, 4], title: "Counting" }] : [{ specs: [1], title: "Goodbye" }, { specs: [2, 3], title: "Counting" }], notes: "Hello and goodbye stay apart: they build nothing together." };
      },
      place: async () => undefined,
    };
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner, steering: () => wishes.map((text) => ({ source: "the conversation", text })), run });
    holdNext();
    const [first] = await loop.bringUp("app.plain");
    expect(first!.planned).toHaveLength(3);
    expect(first!.planNotes).toContain("the grouping was not given - a functional spec a pulse");

    // Steered while the first pulse runs: the spec is as it was, and what comes after it is planned again.
    wishes = ["Group the counting together."];
    const [steered] = await loop.bringUp("app.plain");
    expect(steered!.running?.title).toBe("Say hello.");
    expect(steered!.planned.map((job) => job.title)).toEqual(["Goodbye", "Counting"]);
    expect(steered!.planNotes).toEqual(["the grouping: Hello and goodbye stay apart: they build nothing together."]);
    expect(describeModules([steered!])).toContain("what the plan did not do as asked:\n    - the grouping: Hello and goodbye stay apart");
    expect(seen.at(-1)).toEqual(["Group the counting together."]);

    // Asked again, the steering as it was: the plan is kept, no agent asked.
    const asked = seen.length;
    await loop.bringUp("app.plain");
    expect(seen).toHaveLength(asked);
    gate.release!();
    await loop.drain();
    expect(ran.map((job) => job.title)).toEqual(["Say hello.", "Goodbye", "Counting"]);
  });

  it("plans again with a request's new guidance when nothing runs", async () => {
    writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye."]));
    const guided: string[][] = [];
    const planner = {
      group: async (_specs: unknown, _check: unknown, steering?: Array<{ text: string }>) => (guided.push((steering ?? []).map((entry) => entry.text)), undefined),
      place: async () => undefined,
    };
    // A dry run plans and starts nothing: what is planned stays planned.
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner, dryRun: true, run: runner().run });
    await loop.bringUp("app.plain");
    await loop.bringUp("app.plain");
    expect(guided).toEqual([[]]);
    await loop.bringUp("app.plain", { guidance: "Hello and goodbye together." });
    expect(guided).toEqual([[], ["Hello and goodbye together."]]);
  });

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
    expect(describeModules(loop.status())).toBe("app is up to date: its code is built from the spec as it is now in app.plain, so there is nothing to regenerate.");
  });

  it("is not fully regenerated while a pulse that ended without passing has its work undone - and is, once it lands", async () => {
    writeFileSync(join(dir, "app.plain"), app(["Say hello."]));
    const { gate, run } = runner();
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false, run });
    // It ends - succeeded, not failed - without passing: nothing of it lands, and the codebase is halted.
    gate.land = false;
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(registry.list()[0]).toMatchObject({ status: "succeeded", details: { passed: false, landed: false } });
    expect(readRecord(codeDir())).toBeNull();
    const drift = describeDrift(loop.drift("app.plain"));
    expect(drift).toContain("code: drifted from the spec - to regenerate: sets the project up, adds fs 1");
    expect(drift).toMatch(/pulse \w+ \("Say hello\."\) did not land - it runs again once the spec changes, or the module is asked for again/);
    expect(drift).not.toContain("Fully regenerated");
    // Asked again, it lands: then, and only then, the module is fully regenerated.
    gate.land = true;
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(describeDrift(loop.drift("app.plain"))).toContain("Fully regenerated: every codebase is regenerated from the spec as it is");
  });

  it("writes each pulse's line into the notes as it ends - landed or rolled back - and commits it, so the next pulse keeps it", async () => {
    writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye."]));
    const { gate, run } = runner();
    const told: JobRunner = async (job, onDelta) => ({ ...(await run(job, onDelta)), story: "2 rounds of the unit tests, 5 test runs" });
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: told });
    await loop.bringUp("app.plain");
    await loop.drain();
    const { readNotes } = await import("../../src/regenerate/notes.ts");
    const git = (...args: string[]) => execFileSync("git", ["--git-dir", join(dir, "plain_modules", "app", ".plaingit"), "--work-tree", join(dir, "plain_modules", "app"), ...args], { encoding: "utf8" });
    const pulses = readNotes(codeDir()).pulses;
    expect(pulses).toHaveLength(2);
    expect(pulses[0]).toMatch(/^\[[^\]]* · app pulse 1\] Say hello\. - landed; 2 rounds of the unit tests, 5 test runs · \d+s/);
    expect(pulses[1]).toContain("app pulse 2] Say goodbye. - landed");
    // Each in its pulse's own commit: nothing left uncommitted, no commit of its own.
    expect(git("status", "--porcelain")).toBe("");
    expect(git("log", "--format=%s")).not.toContain("pulse 1 landed");
    // A pulse that does not pass is rolled back - and its line kept, in a commit of its own.
    writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye.", "Count to ten."]));
    gate.land = false;
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(readNotes(codeDir()).pulses.at(-1)).toContain("app pulse 3] Count to ten. - did not pass - rolled back");
    expect(git("log", "-1", "--format=%s")).toBe("pulse 3 rolled back: Count to ten.\n");
    expect(git("status", "--porcelain")).toBe("");
  });

  it("keeps the spec gaps a pulse's agents met in its job's details, for a headless run to say", async () => {
    writeFileSync(join(dir, "app.plain"), app(["Say hello."]));
    const { run } = runner();
    const gap = { question: "Should hello be capitalised?", assumption: "Hello is capitalised" };
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false, run: async (job, onDelta) => ({ ...(await run(job, onDelta)), specGaps: [gap] }) });
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(registry.list().map((job) => (job.details as { specGaps?: unknown }).specGaps)).toEqual([[gap]]);
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
    // The functional spec it is building is replaced by another while it runs - no steer: a spec taken out, one put in.
    writeFileSync(join(dir, "app.plain"), app(["Count the stars in the night sky."]));
    await loop.bringUp("app.plain");
    // Stopped, its agent is aborted and it lands nothing.
    gate.land = false;
    gate.release!();
    const stopped = await registry.wait(first);
    expect(stopped.status).toBe("stopped");
    gate.land = true;
    await loop.drain();
    expect(ran).toHaveLength(2);
    expect(JSON.stringify(readRecord(codeDir()))).toContain("Count the stars in the night sky.");
  });

  it("says it was turri that stopped the job, and what changed under it", async () => {
    writeFileSync(join(dir, "app.plain"), app(["Say hello."]));
    const { gate, holdNext, run } = runner();
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false, run });
    holdNext();
    await loop.bringUp("app.plain");
    const first = loop.status()[0]!.running!.jobId;
    writeFileSync(join(dir, "app.plain"), app(["Count the stars in the night sky."]));
    await loop.bringUp("app.plain");
    gate.land = false;
    gate.release!();
    const stopped = await registry.wait(first);
    expect(stopped.error).toContain("Stopped by turri, not by you: functional specs 1 reads otherwise now");
    expect(stopped.error).toContain("allow-to-stop-jobs: false");
    gate.land = true;
    await loop.drain();
  });

  describe("steering the running job", () => {
    /** A module whose one job is running, held, and the loop over it. */
    async function running(specs: string[]) {
      writeFileSync(join(dir, "app.plain"), app(specs));
      const stub = runner();
      const registry = createJobRegistry();
      const loop = createWorkLoop({ registry, cwd: dir, planner: false, run: stub.run });
      stub.holdNext();
      await loop.bringUp("app.plain");
      return { ...stub, registry, loop, first: loop.status()[0]!.running!.jobId };
    }

    it("steers it when a functional spec it regenerates is reworded or gains a sub-bullet - not stopped, and it lands the spec as it is now", async () => {
      const { ran, gate, registry, loop, first } = await running(["Say hello."]);
      writeFileSync(join(dir, "app.plain"), app(["Say hello.\n  - In French."]));
      await loop.bringUp("app.plain");
      expect(loop.status()[0]!.running).toMatchObject({ jobId: first, steered: [expect.stringContaining("functional specs 1")] });
      expect(describeModules(loop.status())).toContain("⇢ steered");
      gate.release!();
      expect((await registry.wait(first)).status).toBe("succeeded");
      await loop.drain();
      // One job: the steer was it, no second one for the change.
      expect(ran).toHaveLength(1);
      expect(JSON.stringify(readRecord(codeDir()))).toContain("In French.");
    });

    it("steers it when a file one of its specs links is edited", async () => {
      mkdirSync(join(dir, "resources"));
      writeFileSync(join(dir, "resources", "api.yaml"), "openapi: 3.0.0\n");
      const { ran, gate, registry, loop, first } = await running(["Say hello as [the API](resources/api.yaml) says."]);
      writeFileSync(join(dir, "resources", "api.yaml"), "openapi: 3.1.0\n");
      await loop.bringUp("app.plain");
      expect(loop.status()[0]!.running!.steered).toEqual([expect.stringContaining("resources/api.yaml holds something else now")]);
      gate.release!();
      expect((await registry.wait(first)).status).toBe("succeeded");
      await loop.drain();
      expect(ran).toHaveLength(1);
    });

    it("leaves a new item to the next job - the running one goes on, unsteered", async () => {
      const { ran, gate, registry, loop, first } = await running(["Say hello."]);
      writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye."]));
      await loop.bringUp("app.plain");
      expect(loop.status()[0]!.running!.steered).toBeUndefined();
      gate.release!();
      expect((await registry.wait(first)).status).toBe("succeeded");
      await loop.drain();
      expect(ran.map((job) => job.add)).toEqual([["1"], ["2"]]);
    });

    it("steers it twice at most: a third change stops it, as allow-to-stop-jobs says", async () => {
      const { gate, registry, loop, first } = await running(["Say hello."]);
      for (const version of ["Say hello.\n  - In French.", "Say hello.\n  - In German."]) {
        writeFileSync(join(dir, "app.plain"), app([version]));
        await loop.bringUp("app.plain");
      }
      expect(loop.status()[0]!.running!.steered).toHaveLength(2);
      writeFileSync(join(dir, "app.plain"), app(["Say hello.\n  - In Italian."]));
      await loop.bringUp("app.plain");
      gate.land = false;
      gate.release!();
      expect((await registry.wait(first)).status).toBe("stopped");
      gate.land = true;
      await loop.drain();
      expect(JSON.stringify(readRecord(codeDir()))).toContain("In Italian.");
    });
  });

  it("lets the running job land under allow-to-stop-jobs: false, and regenerates what changed since on top of it", async () => {
    writeFileSync(join(dir, "config.yaml"), "conformance-tests: false\nallow-to-stop-jobs: false\n");
    writeFileSync(join(dir, "app.plain"), app(["Say hello."]));
    const { ran, gate, holdNext, run } = runner();
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false, run });
    holdNext();
    await loop.bringUp("app.plain");
    const first = loop.status()[0]!.running!.jobId;
    // Not a steer - the spec replaced by another - and not stopped either.
    writeFileSync(join(dir, "app.plain"), app(["Count the stars in the night sky."]));
    await loop.bringUp("app.plain");
    gate.release!();
    // Not stopped: it lands what it was regenerating.
    expect((await registry.wait(first)).status).toBe("succeeded");
    await loop.drain();
    // Then the change - the spec taken out, another put in - in jobs of its own on top of what it landed.
    expect(ran[0]).toMatchObject({ add: ["1"] });
    expect(ran.length).toBeGreaterThan(1);
    expect(JSON.stringify(readRecord(codeDir()))).toContain("Count the stars in the night sky.");
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

    it("are not planned out for a functional spec edited while its tests are being written - they are written again for its new text", async () => {
      // The running pulse is let finish: what comes after it is planned ahead, from what it will land.
      writeFileSync(join(dir, "config.yaml"), "allow-to-stop-jobs: false\n");
      writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye."]));
      const code = runner();
      const tests = conformanceRunner();
      // The conformance pulse is held while it writes, so the spec can change under it.
      let release!: () => void;
      let hold: Promise<void> | undefined = new Promise((resolve) => (release = resolve));
      let started!: () => void;
      const writing = new Promise<void>((resolve) => (started = resolve));
      /** The functional specs a conformance pulse took the tests of out. */
      const deleted: string[] = [];
      const loop = createWorkLoop({
        registry: createJobRegistry(),
        cwd: dir,
        planner: false,
        conformanceOn: () => true,
        run: code.run,
        runConformance: async (job, onDelta) => {
          deleted.push(...job.planned.cases.delete.map((spec) => spec.frid));
          const held = hold;
          hold = undefined;
          if (held !== undefined) {
            started();
            await held;
          }
          return tests.runConformance(job, onDelta);
        },
      });
      await loop.bringUp("app.plain");
      await writing;
      // While it writes fs 2's tests for "Say goodbye.", fs 2 is edited: its code is behind the spec now.
      writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye, loudly."]));
      await loop.bringUp("app.plain");
      release();
      await loop.drain();
      // What ran after: fs 2's code regenerated again, and its tests written again for the new text - never taken out first,
      // to be written again a pulse later.
      expect(deleted).toEqual([]);
      const after = tests.ran.slice(1);
      expect(after.length).toBeGreaterThan(0);
      expect(after.some((run) => run.patch.includes("2") || run.add.includes("2"))).toBe(true);
      const tested = JSON.stringify(readRecord(testsDir()));
      expect(tested).toContain("Say goodbye, loudly.");
      expect(tested).not.toContain('"Say goodbye."');
    });

    it("are written once the module's code is built - every code job of it landed - in one job for the module, with the config on", async () => {
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
      expect(order.map((entry) => entry.split(" ")[0])).toEqual(["code", "code", "tests"]);
      expect(tests.ran.map((job) => job.add)).toEqual([["1", "2"]]);
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

    it("under conformance-tests: chosen, are written for a functional spec with acceptance tests, and for the rest only once they are chosen - and kept", async () => {
      const withAcceptance = "Say hello.\n\n  ***acceptance tests***\n\n  - It prints hello.";
      writeFileSync(join(dir, "app.plain"), app([withAcceptance, "Say goodbye."]));
      const code = runner();
      const tests = conformanceRunner();
      const registry = createJobRegistry();
      const loop = createWorkLoop({ registry, cwd: dir, planner: false, conformanceOn: () => true, conformanceChosen: () => true, run: code.run, runConformance: tests.runConformance });
      await loop.bringUp("app.plain");
      await loop.drain();
      // Only the one with acceptance tests is tested: nothing chose the other, and the conversation is never asked to.
      expect(tests.ran.map((job) => job.add)).toEqual([["1"]]);
      expect(registry.list().map((job) => job.report ?? "").join("\n")).not.toContain("call conform");

      await loop.conformance("app.plain", { frids: ["2"] });
      await loop.drain();
      expect(tests.ran.map((job) => job.add)).toEqual([["1"], ["2"]]);
      // Chosen once, kept: its changed text has its tests rewritten, with nothing asked again.
      writeFileSync(join(dir, "app.plain"), app([withAcceptance, "Say goodbye politely."]));
      await loop.bringUp("app.plain");
      await loop.drain();
      expect(tests.ran.at(-1)).toMatchObject({ patch: ["2"] });
    });

    it("under conformance-tests: chosen, ask the chooser as each code pulse ends, of what it regenerated - scheduled before anything is built on it, and said in its report", async () => {
      const withAcceptance = "Say hello.\n\n  ***acceptance tests***\n\n  - It prints hello.";
      writeFileSync(join(dir, "app.plain"), app([withAcceptance, "Say goodbye.", "Say thanks."]));
      const code = runner();
      const tests = conformanceRunner();
      const registry = createJobRegistry();
      const told: Array<{ frids: string[]; when: string }> = [];
      const loop = createWorkLoop({
        registry,
        cwd: dir,
        planner: false,
        conformanceOn: () => true,
        conformanceChoosing: () => "pulse",
        run: code.run,
        runConformance: tests.runConformance,
        onChoose: async (_plainFile, specs, _budget, when) => {
          told.push({ frids: specs.map((touched) => touched.frid), when });
          return specs.some((touched) => touched.frid === "2") ? { frids: ["2"], why: "callers rely on the goodbye" } : { frids: [], why: "an internal detail" };
        },
      });
      await loop.bringUp("app.plain");
      await loop.drain();
      // Asked after each code pulse, of what that pulse regenerated - never of the one with acceptance tests.
      expect(told).toEqual([
        { frids: ["2"], when: "pulse" },
        { frids: ["3"], when: "pulse" },
      ]);
      expect(tests.ran.map((job) => job.add)).toEqual([["1", "2"]]);
      const reports = registry.list().map((job) => job.report ?? "");
      expect(reports).toContainEqual(expect.stringContaining("conformance: fs 2 chosen - callers rely on the goodbye"));
      expect(reports).toContainEqual(expect.stringContaining("conformance: none of fs 3 chosen - an internal detail"));
    });

    it("under conformance-tests: module, ask the chooser once the whole module is regenerated - what to test, and in which pulses", async () => {
      writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye.", "Say thanks."]));
      const code = runner();
      const tests = conformanceRunner();
      const told: Array<{ frids: string[]; when: string }> = [];
      const loop = createWorkLoop({
        registry: createJobRegistry(),
        cwd: dir,
        planner: false,
        conformanceOn: () => true,
        conformanceChoosing: () => "module",
        run: code.run,
        runConformance: tests.runConformance,
        onChoose: async (_plainFile, specs, _budget, when) => (told.push({ frids: specs.map((touched) => touched.frid), when }), { frids: ["1", "3"], groups: [["1"], ["3"]], why: "two separate contracts" }),
      });
      await loop.bringUp("app.plain");
      await loop.drain();
      // Once, with the whole module in view, after its last code pulse.
      expect(code.ran).toHaveLength(3);
      expect(told).toEqual([{ frids: ["1", "2", "3"], when: "module" }]);
      // In the pulses it planned.
      expect(tests.ran.map((job) => job.add)).toEqual([["1"], ["3"]]);
    });

    it("under conformance-budget:, offer the chooser only what the module's budget has left, every earlier choice counted - and schedule no more", async () => {
      const withAcceptance = "Say hello.\n\n  ***acceptance tests***\n\n  - It prints hello.";
      writeFileSync(join(dir, "app.plain"), app([withAcceptance, "Say goodbye.", "Say thanks.", "Say sorry."]));
      writeFileSync(join(dir, "config.yaml"), "conformance-budget: 2\n");
      const code = runner();
      const tests = conformanceRunner();
      const told: Array<{ frids: string[]; budget?: number }> = [];
      const loop = createWorkLoop({
        registry: createJobRegistry(),
        cwd: dir,
        planner: false,
        conformanceOn: () => true,
        conformanceChosen: () => true,
        run: code.run,
        runConformance: tests.runConformance,
        // It answers with more than it may: only the first that fit are scheduled.
        onChoose: async (_plainFile, specs, budget) => (told.push({ frids: specs.map((touched) => touched.frid), ...(budget !== undefined ? { budget } : {}) }), { frids: ["2", "3", "4"] }),
      });
      code.holdNext();
      await loop.bringUp("app.plain");
      // One chosen ahead of the code: it counts.
      await loop.conformance("app.plain", { frids: ["4"] });
      code.gate.release!();
      await loop.drain();
      // Asked after fs 2's pulse with what is left; after fs 3's, the budget is spent and it is not asked.
      expect(told).toEqual([{ frids: ["2"], budget: 1 }]);
      // Acceptance tests' fs 1 does not count against it; fs 4 and the one that fit do.
      expect(tests.ran.map((job) => job.add)).toEqual([["1", "2", "4"]]);
    });

    const base = (spec: string) => `***implementation reqs***\n\n- :Implementation: is Python.\n\n***test reqs***\n\n- :ConformanceTests: use pytest.\n\n***functional specs***\n\n- ${spec}\n`;
    const top = (spec: string) => `---\nrequires:\n  - base\n---\n\n${base(spec)}`;

    it("are written and pass for a module before one built on it starts - which starts from its code and its conformance tests", async () => {
      writeFileSync(join(dir, "base.plain"), base("Users register."));
      writeFileSync(join(dir, "top.plain"), top("The home page says hello."));
      const order: string[] = [];
      const code = runner();
      const tests = conformanceRunner();
      const loop = createWorkLoop({
        registry: createJobRegistry(),
        cwd: dir,
        planner: false,
        conformanceOn: () => true,
        run: async (job, onDelta) => (order.push(`code ${job.moduleName}`), code.run(job, onDelta)),
        runConformance: async (job, onDelta) => {
          order.push(`tests ${job.moduleName}`);
          return tests.runConformance(job, onDelta);
        },
      });
      await loop.bringUp("top.plain");
      await loop.drain();
      expect(order).toEqual(["code base", "tests base", "code top", "tests top"]);
      // The module above started from the conformance tests below it - base's, then its own added.
      expect(readFileSync(join(testsDir("top"), "test_app.py"), "utf8")).toBe("# conformance\n# conformance\n");
      expect(readFileSync(join(codeDir("top"), "base.py"), "utf8")).toContain("Users register.");
    });

    it("that do not pass halt their module - no more of its code - and every module built on it", async () => {
      writeFileSync(join(dir, "base.plain"), base("Users register."));
      writeFileSync(join(dir, "top.plain"), top("The home page says hello."));
      const code = runner();
      const tests = conformanceRunner();
      tests.gate.pass = false;
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, conformanceOn: () => true, run: code.run, runConformance: tests.runConformance });
      await loop.bringUp("top.plain");
      await loop.drain();
      expect(code.ran.map((job) => job.module)).toEqual(["base"]);
      const [below, above] = loop.status();
      expect(below!.why).toMatch(/did not pass/);
      expect(above!.why).toMatch(/^waiting for base: its conformance tests did not pass/);
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

    it("asked for the whole module while its code is still to build, are listed last as planned once it is built - and asked again, say they were on already", async () => {
      writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye.", "Say thanks."]));
      const code = runner();
      const tests = conformanceRunner();
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, conformanceOn: () => false, run: code.run, runConformance: tests.runConformance });
      code.holdNext();
      const [before] = await loop.bringUp("app.plain");
      expect(before!.planned.map((job) => job.track)).toEqual(["code", "code"]);
      const [status] = await loop.conformance("app.plain");
      expect(status!.planned.map((job) => `${job.track} ${job.title}`)).toEqual(["code Say goodbye.", "code Say thanks.", "conformance conformance tests"]);
      expect(describeModules([status!])).toContain("  3. conformance tests - planned once the code is built");
      expect(status!.conformanceNote).toBeUndefined();
      // Not a pulse yet: the regeneration lists the code's alone.
      expect(loop.mapPlan().codebases[0]!.pulses.map((pulse) => pulse.track)).toEqual(["code", "code", "code"]);
      const [again] = await loop.conformance("app.plain", { frids: ["1", "2"] });
      expect(describeModules([again!])).toContain("conformance tests were on for the whole of app already: they are planned into pulses once its code is built");
      code.gate.release!();
      await loop.drain();
      expect(tests.ran.map((job) => job.add)).toEqual([["1", "2", "3"]]);
      expect(loop.status()[0]!.planned).toEqual([]);
    });

    it("scheduled ahead of their code, are written once the module's code is built - after its last code job, the groups together", async () => {
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
      // Scheduled while the first code job runs: shown at once, after the module's last code job.
      const [status] = await loop.conformance("app.plain", { frids: ["1", "2"] });
      await loop.conformance("app.plain", { frids: ["4"] });
      const planned = loop.status()[0]!.planned;
      expect(status!.planned.map((job) => job.waitsFor)).toEqual([undefined, undefined, undefined, ["1", "2"]]);
      expect(planned.map((job) => `${job.track} ${job.title}`)).toEqual(["code Say goodbye.", "code Say thanks.", "code Say sorry.", "conformance fs 1, fs 2", "conformance fs 4"]);
      // The regeneration numbers them among the code's pulses, by the functional specs they are for.
      expect(loop.mapPlan().codebases[0]!.pulses.map((pulse) => [pulse.number, pulse.track, pulse.specs])).toEqual([
        [1, "code", undefined],
        [2, "code", undefined],
        [3, "code", undefined],
        [4, "code", undefined],
        [5, "conformance", ["Say hello.", "Say goodbye."]],
        [6, "conformance", ["Say sorry."]],
      ]);
      code.gate.release!();
      await loop.drain();
      expect(order).toEqual(["code 1", "code 2", "code 3", "code 4", "tests 1,2,4"]);
      expect(JSON.stringify(readRecord(testsDir()))).not.toContain("Say thanks.");
    });

    it("asked for, are written for every functional spec in one job - or one a functional spec when the person asked for that", async () => {
      writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye.", "Say thanks."]));
      const code = runner();
      const tests = conformanceRunner();
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, conformanceOn: () => false, run: code.run, runConformance: tests.runConformance });
      await loop.bringUp("app.plain");
      await loop.drain();
      await loop.conformance("app.plain", { frids: ["1"], separately: true });
      await loop.drain();
      await loop.conformance("app.plain");
      await loop.drain();
      expect(tests.ran.map((job) => job.add)).toEqual([["1"], ["2", "3"]]);

      writeFileSync(join(dir, "app.plain"), app(["Say hello loudly.", "Say goodbye loudly.", "Say thanks loudly."]));
      await loop.bringUp("app.plain");
      await loop.conformance("app.plain", { separately: true });
      await loop.drain();
      expect(tests.ran.slice(2).map((job) => job.patch)).toEqual([["1"], ["2"], ["3"]]);
    });

    it("asked for in groups of the person's own - 1-2, then 3-4 - are written a pulse a group, never two groups in one", async () => {
      writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye.", "Say thanks.", "Say sorry."]));
      const code = runner();
      const tests = conformanceRunner();
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, conformanceOn: () => false, run: code.run, runConformance: tests.runConformance });
      await loop.bringUp("app.plain");
      await loop.drain();
      const [status] = await loop.conformance("app.plain", { groups: [["1", "2"], ["3", "4"]] });
      // The first group's pulse has started; the second is a pulse of its own, after it.
      expect(status!.planned.filter((job) => job.track === "conformance").map((job) => job.title)).toEqual(["Say thanks.; Say sorry."]);
      await loop.drain();
      expect(tests.ran.map((job) => job.add)).toEqual([["1", "2"], ["3", "4"]]);
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
      expect(loop.planned()[0]!.note).toMatch(/^Being planned into pulses now/);
      release();
      await brought;
      await loop.drain();
      expect(loop.status()[0]!.planned).toEqual([]);
    });

    it("of a functional spec regenerated again by name are kept while it regenerates - never taken out as if it were gone", async () => {
      writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye."]));
      const code = runner();
      const tests = conformanceRunner();
      const order: string[] = [];
      const loop = createWorkLoop({
        registry: createJobRegistry(),
        cwd: dir,
        planner: false,
        conformanceOn: () => true,
        run: async (job, onDelta) => (order.push(`code ${job.planned.cases.again.map((spec) => spec.frid).join(",")}`), code.run(job, onDelta)),
        runConformance: async (job, onDelta) => (order.push(`tests -${job.planned.cases.delete.map((spec) => spec.frid).join(",")}`), tests.runConformance(job, onDelta)),
      });
      await loop.bringUp("app.plain");
      await loop.drain();
      order.length = 0;
      // Its spec did not change: named, it is regenerated again - its tests untouched while it does, and none taken out.
      await loop.regenerateAgain("app.plain", ["1"]);
      await loop.drain();
      expect(order).toEqual(["code 1"]);
      expect(JSON.stringify(readRecord(testsDir()))).toContain("Say hello.");
      // Regenerated again, it is built as the spec says it: the mark is gone from the record.
      expect(JSON.stringify(readRecord(codeDir()))).not.toContain("regenerate_again");
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
      const refused = registry.list().find((job) => job.kind === "conformance")!;
      expect(refused.report).toMatch(/Not started: .*fs 1 is not built - plain_modules\/app\/code\/\.turri\.json does not have it/);
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

    describe("of a module another is built on", () => {
      const top = "---\nrequires:\n  - app\n---\n\n***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n- The home page says hello.\n";

      async function builtBelow() {
        writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye.", "Say thanks."]));
        writeFileSync(join(dir, "top.plain"), top);
        const code = runner();
        const tests = conformanceRunner();
        const loop = () =>
          createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, conformanceOn: () => true, conformanceChosen: () => true, run: code.run, runConformance: tests.runConformance });
        const first = loop();
        await first.bringUp("app.plain");
        await first.drain();
        return { code, tests, loop };
      }

      it("are written in its own codebase when the one built on it has only been started from its code - that one starts again from it once they pass", async () => {
        const { code, tests, loop } = await builtBelow();
        const before = code.ran.length;
        // A pulse of top's was started - its codebase seeded with app's code - and stopped: nothing of its own built.
        copyRequiredCode(codeDir("app"), codeDir("top"), "top", "app");
        const work = loop();
        const statuses = await work.conformance("app.plain", { frids: ["2", "3"] });
        expect(statuses.map((status) => status.module)).toEqual(["app"]);
        expect(readRecord(codeDir("top"))).toBeNull();
        await work.bringUp("top.plain");
        await work.drain();
        expect(tests.ran.map((job) => job.add)).toEqual([["2", "3"]]);
        expect(JSON.stringify(readRecord(testsDir("app")))).toContain("Say thanks.");
        // Built on app once its tests passed, from app's code.
        expect(code.ran.slice(before).map((job) => job.module)).toEqual(["top"]);
        expect(JSON.stringify(readRecord(codeDir("top")))).toContain("The home page says hello.");
        expect(readFileSync(join(testsDir("top"), "test_app.py"), "utf8")).toContain("# conformance");
      });

      it("delete the codebase built on it when the one above has built code of its own - disposable, no history kept - and regenerate it after they pass", async () => {
        const { code, tests, loop } = await builtBelow();
        const work = loop();
        await work.bringUp("top.plain");
        await work.drain();
        const before = code.ran.length;
        const statuses = await work.conformance("app.plain", { frids: ["2", "3"] });
        expect(statuses.map((status) => status.module)).toEqual(["app"]);
        // Gone whole, its history with it.
        expect(existsSync(join(dir, "plain_modules", "top"))).toBe(false);
        await work.drain();
        expect(tests.ran.map((job) => job.add)).toEqual([["2", "3"]]);
        expect(code.ran.slice(before).map((job) => job.module)).toEqual(["top"]);
        expect(JSON.stringify(readRecord(codeDir("top")))).toContain("The home page says hello.");
      });

      it("touch nothing built on it when they are written already", async () => {
        const { loop } = await builtBelow();
        const work = loop();
        await work.conformance("app.plain", { frids: ["2"] });
        await work.drain();
        await work.bringUp("top.plain");
        await work.drain();
        await expect(work.conformance("app.plain", { frids: ["2"] })).rejects.toThrow("app's conformance tests for fs 2 are written already. Nothing was scheduled.");
        expect(JSON.stringify(readRecord(codeDir("top")))).toContain("The home page says hello.");
      });

      it("asked ahead for a module above the one being regenerated, are written once its code is built - the module below left as it is", async () => {
        writeFileSync(join(dir, "app.plain"), app(["Say hello."]));
        writeFileSync(join(dir, "top.plain"), top.replace("***functional specs***", "***test reqs***\n\n- :ConformanceTests: use pytest.\n\n***functional specs***"));
        const code = runner();
        const tests = conformanceRunner();
        const order: string[] = [];
        const work = createWorkLoop({
          registry: createJobRegistry(),
          cwd: dir,
          planner: false,
          conformanceOn: () => false,
          run: async (job, onDelta) => (order.push(`code ${job.moduleName}`), code.run(job, onDelta)),
          runConformance: async (job, onDelta) => (order.push(`tests ${job.moduleName}`), tests.runConformance(job, onDelta)),
        });
        code.holdNext();
        await work.bringUp("top.plain");
        // app is being regenerated; top's tests are asked for now.
        const statuses = await work.conformance("top.plain", { frids: ["1"] });
        expect(statuses.map((status) => status.module)).toEqual(["app", "top"]);
        code.gate.release!();
        await work.drain();
        expect(order).toEqual(["code app", "code top", "tests top"]);
      });

      it("stop a pulse building the first code of the one above on it - that one starts again from it once they pass", async () => {
        const { code, tests, loop } = await builtBelow();
        const before = code.ran.length;
        const work = loop();
        // top's first pulse is running - its codebase seeded with app's code - when app's tests are asked for.
        code.holdNext();
        await work.bringUp("top.plain");
        await vi.waitFor(() => expect(work.status().find((module) => module.module === "top")?.running).toBeDefined());
        const statuses = await work.conformance("app.plain", { frids: ["2", "3"] });
        expect(statuses.map((status) => status.module)).toEqual(["app"]);
        code.gate.release!();
        await work.drain();
        // The stopped pulse landed nothing; app's tests were written; top was built again, from app's code and tests.
        expect(tests.ran.map((job) => job.add)).toEqual([["2", "3"]]);
        expect(code.ran.slice(before).map((job) => job.module)).toEqual(["top", "top"]);
        expect(JSON.stringify(readRecord(codeDir("top")))).toContain("The home page says hello.");
        expect(readFileSync(join(testsDir("top"), "test_app.py"), "utf8")).toContain("# conformance");
      });

      it("stop a pulse building on it even under allow-to-stop-jobs: false - the person asked", async () => {
        writeFileSync(join(dir, "config.yaml"), "allow-to-stop-jobs: false\n");
        const { code, tests, loop } = await builtBelow();
        const work = loop();
        code.holdNext();
        await work.bringUp("top.plain");
        await vi.waitFor(() => expect(work.status().find((module) => module.module === "top")?.running).toBeDefined());
        await work.conformance("app.plain", { frids: ["2"] });
        code.gate.release!();
        await work.drain();
        expect(tests.ran.map((job) => job.add)).toEqual([["2"]]);
        expect(JSON.stringify(readRecord(codeDir("top")))).toContain("The home page says hello.");
      });
    });
  });
});

describe("a codebase built without a module it now requires", () => {
  it("is left as it is until starting it over is asked for - then its code goes, kept in its history, and the chain is built from the bottom", async () => {
    const { describeModules } = await import("../../src/regenerate/loop.ts");
    const { historyLog } = await import("../../src/regenerate/lineage.ts");
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
    expect(describeModules([status!], { for: "command line" })).toContain("turri regenerate app.plain --start-over");

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

describe("a module being planned", () => {
  it("is shown at once - the registry told as the plan begins and once it is made, the row saying since when", async () => {
    writeFileSync(join(dir, "app.plain"), app(["Say hello."]));
    const registry = createJobRegistry();
    const seen: Array<Array<{ id: string; since?: number }>> = [];
    let loop: ReturnType<typeof createWorkLoop> | undefined;
    registry.notify = () => seen.push(loop!.planned().map((job) => ({ id: job.id, ...(job.planning !== undefined ? { since: job.planning.since } : {}) })));
    loop = createWorkLoop({ registry, cwd: dir, planner: false, run: runner().run });
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]).toEqual([{ id: "planned-app-1", since: expect.any(Number) }]);
    expect(seen[1]!.some((row) => row.since !== undefined)).toBe(false);
  });
});

describe("a module regenerated from scratch", () => {
  it("has its code taken out, kept in its history, and all of it regenerated from its spec - built though nothing changed", async () => {
    const { historyLog } = await import("../../src/regenerate/lineage.ts");
    const { existsSync } = await import("node:fs");
    writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye."]));
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(ran).toHaveLength(2);
    // Built from the spec as it is: asked again, nothing regenerates.
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(ran).toHaveLength(2);

    await loop.fromScratch("app.plain");
    await loop.drain();
    expect(ran).toHaveLength(4);
    expect(historyLog(codeDir())).toContain("start from scratch: asked to be regenerated from scratch");
    expect(existsSync(join(codeDir(), "app.py"))).toBe(true);
    expect(loop.status().find((entry) => entry.module === "app")).toMatchObject({ planned: [], why: "built from the spec as it is" });
  });

  it("builds a module never built, as regenerate does", async () => {
    writeFileSync(join(dir, "app.plain"), app(["Say hello."]));
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    await loop.fromScratch("app.plain");
    await loop.drain();
    expect(ran).toHaveLength(1);
  });
});

describe("a preview of the next job", () => {
  it("plans on a loop of its own and starts nothing - the job each codebase would start, with its coding agent's prompt - and copies nothing up", async () => {
    const { previewJobs } = await import("../../src/regenerate/loop.ts");
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
    const { previewJobs } = await import("../../src/regenerate/loop.ts");
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
    const { describeSpecChange } = await import("../../src/regenerate/prompt.ts");
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
    // As an earlier turri wrote it: the links without their hashes.
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

describe("drift", () => {
  it("says what is left to regenerate - in the code and its conformance tests - planning and starting nothing", async () => {
    writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye."]));
    const code = runner();
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false, conformanceOn: () => false, run: code.run });
    const { describeDrift } = await import("../../src/regenerate/loop.ts");
    // Nothing regenerated: all of it.
    const fresh = loop.drift("app.plain");
    expect(fresh[0]!.code).toMatchObject({ add: [{ frid: "1" }, { frid: "2" }] });
    expect(describeDrift(fresh)).toMatch(/code: drifted from the spec - to regenerate: sets the project up, adds fs 1, fs 2/);
    expect(registry.list()).toEqual([]);
    expect(code.ran).toEqual([]);
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(describeDrift(loop.drift("app.plain"))).toContain("code: regenerated from the spec as it is - no drift");
    // The spec changes: the drift is the change, and nothing starts until regenerate.
    writeFileSync(join(dir, "app.plain"), app(["Say hello loudly.", "Say goodbye."]));
    const ran = code.ran.length;
    expect(describeDrift(loop.drift("app.plain"))).toContain("to regenerate: changes fs 1");
    expect(code.ran).toHaveLength(ran);
  });
});

const base = "***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n- Users register.\n";
const top = "---\nrequires:\n  - base\n---\n\n***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n- The home page says hello.\n";

describe("modules no longer brought up", () => {
  it("forgets a module whose .plain file is gone while it waits, rather than showing it waiting for good", async () => {
    writeFileSync(join(dir, "base.plain"), base);
    writeFileSync(join(dir, "top.plain"), top);
    const { ran, holdNext, gate, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    holdNext();
    await loop.bringUp("top.plain");
    expect(loop.planned().map((job) => job.summary)).toEqual(["top.plain - waits for base"]);
    rmSync(join(dir, "top.plain"));
    gate.release!();
    await loop.drain();
    expect(loop.planned()).toEqual([]);
    expect(loop.status().map((module) => module.module)).toEqual(["base"]);
    expect(loop.mapPlan().codebases.map((codebase) => codebase.module)).toEqual(["base"]);
    expect(ran.map((job) => job.module)).toEqual(["base"]);
  });

  it("drops the plan of a codebase left behind once a module is built on it, rather than listing its pulses for good", async () => {
    writeFileSync(join(dir, "base.plain"), base.replace("- Users register.", "- Users register.\n\n- Users log in."));
    const { ran, holdNext, gate, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    holdNext();
    await loop.bringUp("base.plain");
    expect(loop.planned().map((job) => job.id)).toEqual(["planned-base-1"]);
    // Meanwhile a module is built on it: base's code is regenerated there from now on.
    writeFileSync(join(dir, "top.plain"), top);
    mkdirSync(codeDir("top"), { recursive: true });
    writeFileSync(join(codeDir("top"), "top.py"), "# started\n");
    gate.release!();
    await loop.drain();
    // base's second functional spec is built in top, where base's code is regenerated now - not in base.
    expect(ran.map((job) => [job.module, job.add])).toEqual([
      ["base", ["1"]],
      ["top", ["1"]],
    ]);
    expect(loop.planned()).toEqual([]);
    expect(loop.status().find((module) => module.module === "base")!.why).toMatch(/^left behind/);
  });

  it("shows nothing planned for a module whose spec stopped parsing, nor what it waited for", async () => {
    writeFileSync(join(dir, "base.plain"), base);
    writeFileSync(join(dir, "top.plain"), top);
    const { holdNext, gate, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    holdNext();
    await loop.bringUp("top.plain");
    writeFileSync(join(dir, "top.plain"), top.replace("  - base", "  - missing"));
    gate.release!();
    await loop.drain();
    expect(loop.planned()).toEqual([]);
  });
});

describe("halting a module's planned work", () => {
  it("halts the whole module by a planned row: its running pulse is stopped, none of its planned pulses start", async () => {
    writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye.", "Count to ten."]));
    const { ran, holdNext, gate, run } = runner();
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false, run });
    holdNext();
    await loop.bringUp("app.plain");
    const running = loop.status()[0]!.running!.jobId;
    expect(loop.planned().map((job) => job.id)).toEqual(["planned-app-1", "planned-app-2"]);
    const said = loop.halt("planned-app-2", "the goodbye is being rethought");
    expect(said).toContain("Halted app (the goodbye is being rethought)");
    expect(said).toContain(`its running pulse ${running} is being stopped`);
    expect(said).toContain("its 2 planned pulses will not start");
    // Its agent stops once it is told to.
    gate.release!();
    await loop.drain();
    expect(ran).toHaveLength(1);
    expect(registry.get(running)!.status).toBe("stopped");
    expect(loop.planned()).toEqual([]);
    expect(loop.status()[0]!.why).toBe("you halted it (the goodbye is being rethought) - nothing runs here until it is asked for again");
  });

  it("keeps a module the person halted halted through a spec change, and runs it again once it is asked for", async () => {
    writeFileSync(join(dir, "app.plain"), app(["Say hello."]));
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    expect(loop.halt("app")).toBeUndefined();
    await loop.bringUp("app.plain");
    await loop.drain();
    writeFileSync(join(dir, "app.plain"), app(["Say hello.", "Say goodbye."]));
    loop.halt("app");
    await loop.bringUp("app.plain", { specChange: true });
    await loop.drain();
    expect(ran).toHaveLength(1);
    expect(loop.status()[0]!.why).toMatch(/^you halted it/);
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(ran.map((job) => job.add)).toEqual([["1"], ["2"]]);
  });

  it("has the modules built on a halted module wait for it, and says which", async () => {
    writeFileSync(join(dir, "base.plain"), base);
    writeFileSync(join(dir, "top.plain"), top);
    const { ran, holdNext, gate, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    holdNext();
    await loop.bringUp("top.plain");
    expect(loop.halt("base")).toContain("top waits for it");
    gate.release!();
    await loop.drain();
    expect(ran.map((job) => job.module)).toEqual(["base"]);
    expect(loop.status().map((module) => [module.module, module.why])).toEqual([
      ["base", "you halted it - nothing runs here until it is asked for again"],
      ["top", "waiting for base: you halted it - nothing is built on it until it is asked for again"],
    ]);
  });

  it("drops a module whose .plain file is gone when its waiting row is halted", async () => {
    writeFileSync(join(dir, "base.plain"), base);
    writeFileSync(join(dir, "top.plain"), top);
    const { holdNext, gate, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    holdNext();
    await loop.bringUp("top.plain");
    rmSync(join(dir, "top.plain"));
    expect(loop.halt("planned-top-waiting")).toBe("top is no longer in the project - top.plain is gone - so nothing was to be built there: it is dropped from the regeneration.");
    expect(loop.planned()).toEqual([]);
    gate.release!();
    await loop.drain();
  });
});
