import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpecSnapshot } from "../../src/render/spec-change.ts";

/** Everything the queue ran, in order, and whether each render passes. */
const ran: string[] = [];
/** Whether the functionality conformance suite passes. */
let conformancePasses = true;
let renderPasses = true;
const conformanceLaterSeen: Array<boolean | undefined> = [];
/** What each render was told about conformance: false, off. */
const conformanceSeen: Array<boolean | undefined> = [];
const renderedDiffs: string[] = [];
/** Set, the next render is held until `releaseSlow` - running, for the queue master to find. */
let holdNext = false;
let releaseSlow: (() => void) | undefined;

vi.mock("../../src/render/spec-change.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/render/spec-change.ts")>();
  return {
    ...actual,
    renderSpecDiff: async (options: { conformance?: boolean; conformanceLater?: boolean; diff?: string; spec?: { tree: object; chain?: Array<{ buildDir: string }> } }) => {
      ran.push("render spec diff");
      conformanceSeen.push(options.conformance);
      if (holdNext) {
        holdNext = false;
        await new Promise<void>((resolve) => (releaseSlow = resolve));
        // Stopped, a real render's agent is aborted and it lands nothing.
        return { passed: false, stoppedAt: "unit tests" };
      }
      renderedDiffs.push(options.diff ?? "");
      conformanceLaterSeen.push(options.conformanceLater);
      // Landing, it records the spec it was given - as the real one does.
      const buildDir = options.spec?.chain?.at(-1)?.buildDir;
      if (renderPasses && buildDir !== undefined) (await import("../../src/render/state.ts")).writeBuiltTree(buildDir, options.spec!.tree as never);
      return { passed: renderPasses, stoppedAt: renderPasses ? null : "unit tests", conformanceLater: options.conformanceLater };
    },
    describeSpecDiff: () => "rendered",
  };
});
vi.mock("../../src/render/spec-change-conformance.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/render/spec-change-conformance.ts")>();
  return {
    ...actual,
    renderSpecDiffConformance: async () => (ran.push("spec diff conformance"), { passed: true, stoppedAt: null }),
    describeSpecDiffConformance: () => "tests in line",
  };
});
vi.mock("../../src/render/conformance-suite.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/render/conformance-suite.ts")>();
  return {
    ...actual,
    renderConformanceSuite: async (options: { frids?: string[]; regression?: boolean }) => (ran.push(`conformance ${options.frids?.join(",")}${options.regression === true ? " + suite" : ""}`), { passed: conformancePasses }),
    describeConformanceSuite: () => "suite passes",
  };
});

const { createJobRegistry } = await import("../../src/render/jobs.ts");
const { moduleLanes } = await import("../../src/render/lanes.ts");
const { createRenderQueue } = await import("../../src/render/queue.ts");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plainwright-queue-conformance-"));
  ran.length = 0;
  conformanceLaterSeen.length = 0;
  conformanceSeen.length = 0;
  holdNext = false;
  releaseSlow = undefined;
  conformancePasses = true;
  renderedDiffs.length = 0;
  renderPasses = true;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const WITH_TEST_REQS = "***implementation reqs***\n\n- Python.\n\n***test reqs***\n\n- pytest.\n\n***functional specs***\n\n- Say hello.\n";
const spec = (testReqs: boolean) =>
  ({ tree: testReqs ? { "test reqs": [{ markdown: "- pytest." }] } : {}, chain: [{ plainFile: join(dir, "app.plain"), buildDir: join(dir, "plain_modules", "app", "code") }] }) as unknown as SpecSnapshot;

function queue(run?: Parameters<typeof createRenderQueue>[0]["run"]) {
  const registry = createJobRegistry();
  return { registry, queue: createRenderQueue({ registry, cwd: dir, run }) };
}

describe("a spec diff's conformance tests", () => {
  it("are a job of their own, queued right behind its render, which leaves them to it", async () => {
    writeFileSync(join(dir, "app.plain"), WITH_TEST_REQS);
    const { registry, queue: q } = queue();
    const queued = q.enqueueSpecDiff({ plainFile: "app.plain", diff: "+- Say hello.", applied: "already applied", spec: spec(true) });

    expect(queued.conformanceJobId).toBeDefined();
    expect(registry.get(queued.conformanceJobId!)).toMatchObject({ kind: "render_spec_diff_conformance", diff: "+- Say hello." });
    expect(q.status().map((entry) => entry.what)).toEqual([expect.stringMatching(/^spec diff: .*Say hello\.$/), expect.stringMatching(/^spec diff conformance: .*Say hello\.$/)]);
    await registry.wait(queued.conformanceJobId!);
    expect(ran).toEqual(["render spec diff", "spec diff conformance"]);
    expect(conformanceLaterSeen).toEqual([true]);
  });

  it("do not run when the render did not land", async () => {
    writeFileSync(join(dir, "app.plain"), WITH_TEST_REQS);
    renderPasses = false;
    const { registry, queue: q } = queue();
    const queued = q.enqueueSpecDiff({ plainFile: "app.plain", diff: "+- Say hello.", applied: "already applied", spec: spec(true) });
    const conformance = await registry.wait(queued.conformanceJobId!);
    expect(ran).toEqual(["render spec diff"]);
    expect(conformance.report).toContain("did not land");
  });

  it("are not queued with conformance off, or with no test reqs to write them from - the render keeps them itself", async () => {
    const { queue: q } = queue();
    expect(q.enqueueSpecDiff({ plainFile: "app.plain", diff: "+x", applied: "already applied", spec: spec(false) }).conformanceJobId).toBeUndefined();
    expect(q.enqueueSpecDiff({ plainFile: "app.plain", diff: "+x", applied: "already applied", spec: spec(true), conformance: false }).conformanceJobId).toBeUndefined();
    writeFileSync(join(dir, "config.yaml"), "conformance-tests: false\n");
    expect(q.enqueueSpecDiff({ plainFile: "app.plain", diff: "+x", applied: "already applied", spec: spec(true) }).conformanceJobId).toBeUndefined();
    expect(conformanceLaterSeen.every((seen) => seen !== true)).toBe(true);
    // Its renders finish here, not in the next test.
    await q.drain();
  });
});

describe("a functionality's conformance tests", () => {
  it("are a job of their own behind its render, run once it lands", async () => {
    writeFileSync(join(dir, "app.plain"), WITH_TEST_REQS);
    const { registry, queue: q } = queue(async (request) => (ran.push(`render ${request.frid}`), { report: "built", details: { landed: true } }));
    q.enqueue({ plainFile: "app.plain", frid: "1" });
    const conformance = registry.list().find((job) => job.kind === "render_functionality_conformance")!;
    expect(conformance.summary).toBe("app.plain conformance, functionality 1");
    await registry.wait(conformance.id);
    expect(ran).toEqual(["render 1", "conformance 1"]);
  });

  it("can be queued on their own, for functionalities already built", async () => {
    writeFileSync(join(dir, "app.plain"), WITH_TEST_REQS);
    const { registry, queue: q } = queue();
    const { jobId } = q.enqueueConformance({ plainFile: "app.plain", frids: ["1", "2"], scope: "functionality 1, 2" });
    await registry.wait(jobId);
    expect(ran).toEqual(["conformance 1,2"]);
  });
});

describe("the queue master", () => {
  it("reworks the queued spec diffs around each new change - one that undoes a queued job takes it out, and only the rest render", async () => {
    const { writeBuiltTree } = await import("../../src/render/state.ts");
    const buildDir = join(dir, "plain_modules", "backend", "code");
    const specs = (items: string[]) => ({ "functional specs": items.map((markdown) => ({ markdown })) });
    writeBuiltTree(buildDir, specs(["- Users sign up."]) as never);
    writeFileSync(join(dir, "backend.plain"), "***functional specs***\n\n- Users sign up.\n- Users comment on sessions.\n");
    const snapshot = (items: string[]) => ({ moduleName: "backend", plainFile: join(dir, "backend.plain"), tree: specs(items), chain: [{ moduleName: "backend", plainFile: join(dir, "backend.plain"), buildDir }] }) as unknown as SpecSnapshot;

    // A stand-in master: every job the new change left with nothing to do goes; the rest stays as proposed.
    const seen: number[] = [];
    const master = async (_input: unknown, tools: { draft(): Array<{ jobId?: string; title: string; changes: string[] }>; deleteJob(job: string, reason: string): string; commit(summary: string): { ok: boolean } }) => {
      seen.push(tools.draft().length);
      for (const job of tools.draft()) if (job.changes.length === 0) tools.deleteJob(job.jobId ?? job.title, "the new change undid it");
      tools.commit("Took out the profile page: the latest change removed it again.");
    };
    const registry = createJobRegistry();
    const q = createRenderQueue({ registry, cwd: dir, queueMaster: master as never });
    const comments = q.enqueueSpecDiff({ plainFile: "backend.plain", diff: "+- Users comment on sessions.", applied: "already applied", spec: snapshot(["- Users sign up.", "- Users comment on sessions."]) });
    const profiles = q.enqueueSpecDiff({ plainFile: "backend.plain", diff: "+- Users have a profile page.", applied: "already applied", spec: snapshot(["- Users sign up.", "- Users comment on sessions.", "- Users have a profile page."]) });
    const undo = q.enqueueSpecDiff({ plainFile: "backend.plain", diff: "-- Users have a profile page.", applied: "already applied", spec: snapshot(["- Users sign up.", "- Users comment on sessions."]) });

    for (const id of [comments.jobId, profiles.jobId, undo.jobId]) await registry.wait(id);
    // All three were submitted before the master's turn came: it saw the three together once - and left 1.
    expect(seen).toEqual([3]);
    expect(ran).toEqual(["render spec diff"]);
    expect(renderedDiffs[0]).toContain("Users comment on sessions.");
    expect(renderedDiffs[0]).not.toContain("profile page");
    for (const id of [profiles.jobId, undo.jobId]) {
      const job = registry.get(id)!;
      expect(job.status).toBe("stopped");
      expect(job.note).toMatch(/^Not run - taken out by the queue master: its change is undone by a later one, or is part of/);
      expect(job.note).toContain("Took out the profile page");
    }
  });

  it("gives a queued job back its own change, edited since - taking the profile link out of the nav bar leaves the nav bar that job's - and runs each job as itself", async () => {
    const { writeBuiltTree } = await import("../../src/render/state.ts");
    const buildDir = join(dir, "plain_modules", "frontend", "code");
    const specs = (items: string[]) => ({ "functional specs": items.map((markdown) => ({ markdown })) });
    const signUp = "- A :Visitor: can sign up.";
    const nav = "- The nav bar has the links `Feed` to `/`, `Search` to `/search`, and `My profile` to `/users/<id>`.";
    const navNow = "- The nav bar has the links `Feed` to `/`, and `Search` to `/search`.";
    const profile = "- The profile page at `/users/<id>` shows the user's sessions and counts.";
    const feed = "- The feed at `/` lists the sessions of the users one follows, newest first.";
    writeBuiltTree(buildDir, specs([signUp]) as never);
    writeFileSync(join(dir, "frontend.plain"), `***functional specs***\n\n${[signUp, navNow, feed].join("\n")}\n`);
    const snapshot = (items: string[]) => ({ moduleName: "frontend", plainFile: join(dir, "frontend.plain"), tree: specs(items), chain: [{ moduleName: "frontend", plainFile: join(dir, "frontend.plain"), buildDir }] }) as unknown as SpecSnapshot;

    const drafts: Array<Array<{ jobId?: string; changes: string[] }>> = [];
    const master = async (_input: unknown, tools: { draft(): Array<{ jobId?: string; title: string; changes: string[] }>; deleteJob(job: string, reason: string): string; commit(summary: string): { ok: boolean; problems: string[] } }) => {
      drafts.push(tools.draft());
      for (const job of tools.draft()) if (job.changes.length === 0) tools.deleteJob(job.jobId ?? job.title, "the profile page is gone");
      expect(tools.commit("Took the profile page out of the queue.").problems).toEqual([]);
    };
    // Held until all four are queued, so the master sees them together.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const registry = createJobRegistry();
    registry.start({ kind: "render", summary: "ahead", lanes: moduleLanes(join(dir, "frontend.plain")), run: async () => (await held, { report: "" }) });
    const q = createRenderQueue({ registry, cwd: dir, queueMaster: master as never });
    const navJob = q.enqueueSpecDiff({ plainFile: "frontend.plain", diff: `+${nav}`, applied: "already applied", spec: snapshot([signUp, nav]) });
    const profileJob = q.enqueueSpecDiff({ plainFile: "frontend.plain", diff: `+${profile}`, applied: "already applied", spec: snapshot([signUp, nav, profile]) });
    const feedJob = q.enqueueSpecDiff({ plainFile: "frontend.plain", diff: `+${feed}`, applied: "already applied", spec: snapshot([signUp, nav, profile, feed]) });
    const removal = q.enqueueSpecDiff({ plainFile: "frontend.plain", diff: "- no profile page", applied: "already applied", spec: snapshot([signUp, navNow, feed]) });
    // What the tool that queued the removal tells the user: not that it is queued, but what became of it.
    const said = (await q.afterRework(removal.jobId))!;
    expect(said).toContain("The queue master reworked the queue: Took the profile page out of the queue.");
    expect(said).toContain(`Job ${removal.jobId}, this change, does not run as a job of its own`);
    expect(said).toContain(`Taken out, never to run: job ${profileJob.jobId}.`);
    expect(said).toMatch(new RegExp(`Rewritten to render the change as it now is: job ${navJob.jobId}`));
    // Named for what it renders now: the nav bar without the profile link.
    expect(said).toMatch(new RegExp(`- job ${navJob.jobId} · .*The nav bar has the links \`Feed\` to \`/\`, and \`Search\``));
    expect(said).not.toContain(`- job ${removal.jobId}`);
    release();
    for (const id of [navJob.jobId, profileJob.jobId, feedJob.jobId, removal.jobId]) await registry.wait(id);

    // The harness's proposal already gave the nav bar, as it is now, back to the nav bar's job.
    expect(drafts[0]!.map((job) => job.changes.length)).toEqual([1, 0, 1, 0]);
    expect(ran).toEqual(["render spec diff", "render spec diff"]);
    expect(renderedDiffs[0]).toContain("`Search` to `/search`.");
    expect(renderedDiffs[0]).not.toContain("My profile");
    expect(renderedDiffs[1]).toContain("The feed at `/`");
    // Each ran as itself: the nav bar's job rendered the nav bar, the feed's the feed.
    expect(registry.get(navJob.jobId)!.status).toBe("succeeded");
    expect(registry.get(feedJob.jobId)!.status).toBe("succeeded");
    for (const id of [profileJob.jobId, removal.jobId]) expect(registry.get(id)!.status).toBe("stopped");
  });

  it("takes a spec diff's change again from what is built when the job ahead of it was stopped - so what it records is what it built", async () => {
    const { writeBuiltTree } = await import("../../src/render/state.ts");
    const buildDir = join(dir, "plain_modules", "backend", "code");
    const specs = (items: string[]) => ({ "functional specs": items.map((markdown) => ({ markdown })) });
    writeBuiltTree(buildDir, specs(["- Users sign up."]) as never);
    writeFileSync(join(dir, "backend.plain"), "***functional specs***\n\n- Users sign up.\n- Users comment on sessions.\n- Users give kudos.\n");
    const snapshot = (items: string[]) => ({ moduleName: "backend", plainFile: join(dir, "backend.plain"), tree: specs(items), chain: [{ moduleName: "backend", plainFile: join(dir, "backend.plain"), buildDir }] }) as unknown as SpecSnapshot;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const registry = createJobRegistry();
    registry.start({ kind: "render", summary: "ahead", lanes: moduleLanes(join(dir, "backend.plain")), run: async () => (await held, { report: "" }) });
    const q = createRenderQueue({ registry, cwd: dir, queueMaster: false });
    const comments = q.enqueueSpecDiff({ plainFile: "backend.plain", diff: "+- Users comment on sessions.", applied: "already applied", spec: snapshot(["- Users sign up.", "- Users comment on sessions."]) });
    const kudos = q.enqueueSpecDiff({ plainFile: "backend.plain", diff: "+- Users give kudos.", applied: "already applied", spec: snapshot(["- Users sign up.", "- Users comment on sessions.", "- Users give kudos."]) });
    registry.stop(comments.jobId);
    release();
    await registry.wait(kudos.jobId);

    expect(renderedDiffs).toHaveLength(1);
    expect(renderedDiffs[0]).toContain("Users comment on sessions.");
    expect(renderedDiffs[0]).toContain("Users give kudos.");
    expect(registry.get(kudos.jobId)!.note).toContain("Rebased when it started");
  });

  it("takes a first build's change again from nothing when the scaffold ahead of it was stopped - nothing built is the empty spec", async () => {
    const buildDir = join(dir, "plain_modules", "backend", "code");
    const scaffold = { "implementation reqs": [{ markdown: "- TypeScript." }] };
    const withSpec = { ...scaffold, "functional specs": [{ markdown: "- Users sign up." }] };
    writeFileSync(join(dir, "backend.plain"), "***implementation reqs***\n\n- TypeScript.\n\n***functional specs***\n\n- Users sign up.\n");
    const snapshot = (tree: object) => ({ moduleName: "backend", plainFile: join(dir, "backend.plain"), tree, chain: [{ moduleName: "backend", plainFile: join(dir, "backend.plain"), buildDir }] }) as unknown as SpecSnapshot;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const registry = createJobRegistry();
    registry.start({ kind: "render", summary: "ahead", lanes: moduleLanes(join(dir, "backend.plain")), run: async () => (await held, { report: "" }) });
    const q = createRenderQueue({ registry, cwd: dir, queueMaster: false });
    const first = q.enqueueSpecDiff({ plainFile: "backend.plain", diff: "+- TypeScript.", applied: "already applied", spec: snapshot(scaffold) });
    const second = q.enqueueSpecDiff({ plainFile: "backend.plain", diff: "+- Users sign up.", applied: "already applied", spec: snapshot(withSpec) });
    registry.stop(first.jobId);
    release();
    await registry.wait(second.jobId);

    expect(renderedDiffs).toHaveLength(1);
    expect(renderedDiffs[0]).toContain("TypeScript.");
    expect(renderedDiffs[0]).toContain("Users sign up.");
    expect(registry.get(second.jobId)!.note).toContain("Rebased when it started");
  });

  it("runs a first build's jobs one after the other, though the spec had no functional specs when the first was queued", async () => {
    const spec = join(dir, "backend.plain");
    const buildDir = join(dir, "plain_modules", "backend", "code");
    const snapshot = (tree: object) => ({ moduleName: "backend", plainFile: spec, tree, chain: [{ moduleName: "backend", plainFile: spec, buildDir }] }) as unknown as SpecSnapshot;
    writeFileSync(spec, "***implementation reqs***\n\n- :Implementation: is TypeScript.\n");
    const registry = createJobRegistry();
    const q = createRenderQueue({ registry, cwd: dir, queueMaster: false });
    holdNext = true;
    const scaffold = q.enqueueSpecDiff({ plainFile: "backend.plain", diff: "+- :Implementation: is TypeScript.", applied: "already applied", spec: snapshot({ "implementation reqs": [{ markdown: "- TypeScript." }] }) });
    writeFileSync(spec, "***implementation reqs***\n\n- :Implementation: is TypeScript.\n\n***functional specs***\n\n- Users sign up.\n");
    const first = q.enqueueSpecDiff({ plainFile: "backend.plain", diff: "+- Users sign up.", applied: "already applied", spec: snapshot({ "implementation reqs": [{ markdown: "- TypeScript." }], "functional specs": [{ markdown: "- Users sign up." }] }) });
    await vi.waitFor(() => expect(releaseSlow).toBeDefined());
    expect(registry.get(scaffold.jobId)!.status).toBe("running");
    expect(registry.get(first.jobId)!.status).toBe("queued");
    releaseSlow!();
    await registry.wait(first.jobId);
  });

  it("reworks the queue as the person asks - the feed before the nav bar - and says what it left", async () => {
    const { writeBuiltTree } = await import("../../src/render/state.ts");
    const buildDir = join(dir, "plain_modules", "frontend", "code");
    const specs = (items: string[]) => ({ "functional specs": items.map((markdown) => ({ markdown })) });
    writeBuiltTree(buildDir, specs(["- Sign up."]) as never);
    writeFileSync(join(dir, "frontend.plain"), "***functional specs***\n\n- Sign up.\n- The nav bar.\n- The feed.\n");
    const snapshot = (items: string[]) => ({ moduleName: "frontend", plainFile: join(dir, "frontend.plain"), tree: specs(items), chain: [{ moduleName: "frontend", plainFile: join(dir, "frontend.plain"), buildDir }] }) as unknown as SpecSnapshot;
    const asked: Array<string | undefined> = [];
    const master = async (input: { instruction?: string; queued: unknown[] }, tools: { draft(): Array<{ title: string; changes: string[] }>; rewriteJob(job: string, change: { title?: string; changes?: string[] }): string; commit(summary: string): { ok: boolean; problems: string[] } }) => {
      asked.push(input.instruction);
      if (input.instruction === undefined) return void tools.commit("As queued.");
      // Both are functional specs added at the end: the feed's change goes first, the nav bar's second.
      const [nav, feed] = tools.draft();
      tools.rewriteJob("1", { title: feed!.title, changes: feed!.changes });
      tools.rewriteJob("2", { title: nav!.title, changes: nav!.changes });
      tools.commit("Put the feed first, as asked.");
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const registry = createJobRegistry();
    registry.start({ kind: "render", summary: "ahead", lanes: moduleLanes(join(dir, "frontend.plain")), run: async () => (await held, { report: "" }) });
    const q = createRenderQueue({ registry, cwd: dir, queueMaster: master as never });
    const navJob = q.enqueueSpecDiff({ plainFile: "frontend.plain", diff: "+- The nav bar.", applied: "already applied", spec: snapshot(["- Sign up.", "- The nav bar."]) });
    const feedJob = q.enqueueSpecDiff({ plainFile: "frontend.plain", diff: "+- The feed.", applied: "already applied", spec: snapshot(["- Sign up.", "- The nav bar.", "- The feed."]) });

    const said = await q.rework(join(dir, "frontend.plain"), "run the feed before the nav bar");
    release();
    await registry.wait(feedJob.jobId);

    // The feed only added on top of the nav bar: no agent was asked then. Only the person's request is a turn.
    expect(asked).toEqual(["run the feed before the nav bar"]);
    expect(said).toContain("Put the feed first, as asked.");
    expect(said).toMatch(/in the order they run:\n- job .* · .*\n- job /);
    // The jobs keep their places; what each renders is the plan's.
    expect(registry.get(navJob.jobId)!.status).toBe("succeeded");
    expect(renderedDiffs).toHaveLength(2);
  });

  it("leaves the jobs a queue master keeps as they are - their diffs as queued, and no word that it reworked them", async () => {
    const { writeBuiltTree } = await import("../../src/render/state.ts");
    const buildDir = join(dir, "plain_modules", "frontend", "code");
    const specs = (items: string[]) => ({ "functional specs": items.map((markdown) => ({ markdown })) });
    writeBuiltTree(buildDir, specs(["- Sign up."]) as never);
    writeFileSync(join(dir, "frontend.plain"), "***functional specs***\n\n- Sign up.\n- The nav bar.\n- The feed.\n");
    const snapshot = (items: string[]) => ({ moduleName: "frontend", plainFile: join(dir, "frontend.plain"), tree: specs(items), chain: [{ moduleName: "frontend", plainFile: join(dir, "frontend.plain"), buildDir }] }) as unknown as SpecSnapshot;
    // Asked to rework the queue, it finds nothing to change and commits it as it is.
    const master = async (_input: unknown, tools: { commit(summary: string): { ok: boolean; problems: string[] } }) => void tools.commit("Committed the queue unchanged.");
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const registry = createJobRegistry();
    registry.start({ kind: "render", summary: "ahead", lanes: moduleLanes(join(dir, "frontend.plain")), run: async () => (await held, { report: "" }) });
    const q = createRenderQueue({ registry, cwd: dir, queueMaster: master as never });
    const navDiff = "diff --git a/frontend.plain b/frontend.plain\n@@ -2 +2,2 @@\n - Sign up.\n+- The nav bar.";
    const navJob = q.enqueueSpecDiff({ plainFile: "frontend.plain", diff: navDiff, applied: "already applied", spec: snapshot(["- Sign up.", "- The nav bar."]) });
    const feedJob = q.enqueueSpecDiff({ plainFile: "frontend.plain", diff: "+- The feed.", applied: "already applied", spec: snapshot(["- Sign up.", "- The nav bar.", "- The feed."]) });

    await q.rework(join(dir, "frontend.plain"), "check the queue");
    for (const id of [navJob.jobId, feedJob.jobId]) expect(registry.get(id)!.note ?? "").not.toContain("Reworked");
    expect(registry.get(navJob.jobId)!.diff).toBe(navDiff);
    release();
    await registry.wait(feedJob.jobId);
    expect(renderedDiffs[0]).toBe(navDiff);
  });

  it("cancels the conformance jobs when asked - every one of them - and the spec diffs they followed render on their unit tests alone", async () => {
    const { writeBuiltTree } = await import("../../src/render/state.ts");
    const buildDir = join(dir, "plain_modules", "app", "code");
    const withTests = (items: string[]) => ({ "test reqs": [{ markdown: "- pytest." }], "functional specs": items.map((markdown) => ({ markdown })) });
    writeBuiltTree(buildDir, withTests(["- Say hello."]) as never);
    writeFileSync(join(dir, "app.plain"), WITH_TEST_REQS);
    const snapshot = (items: string[]) => ({ moduleName: "app", plainFile: join(dir, "app.plain"), tree: withTests(items), chain: [{ moduleName: "app", plainFile: join(dir, "app.plain"), buildDir }] }) as unknown as SpecSnapshot;
    const master = async (input: { instruction?: string }, tools: { setConformance(jobs: string[], on: boolean, reason: string): string; commit(summary: string): { ok: boolean; problems: string[] } }) => {
      if (input.instruction === undefined) return void tools.commit("As queued.");
      expect(tools.setConformance(["all"], false, "as asked")).toContain("conformance jobs are cancelled");
      expect(tools.commit("Turned the conformance tests off for every queued job, as asked.").problems).toEqual([]);
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const registry = createJobRegistry();
    registry.start({ kind: "render", summary: "ahead", lanes: moduleLanes(join(dir, "app.plain")), run: async () => (await held, { report: "" }) });
    const q = createRenderQueue({ registry, cwd: dir, queueMaster: master as never });
    const queued = [
      q.enqueueSpecDiff({ plainFile: "app.plain", diff: "+- Say goodbye.", applied: "already applied", spec: snapshot(["- Say hello.", "- Say goodbye."]) }),
      q.enqueueSpecDiff({ plainFile: "app.plain", diff: "+- Say thanks.", applied: "already applied", spec: snapshot(["- Say hello.", "- Say goodbye.", "- Say thanks."]) }),
    ];
    for (const item of queued) expect(item.conformanceJobId).toBeDefined();

    const said = await q.rework(join(dir, "app.plain"), "remove the conformance jobs");
    release();
    for (const item of queued) await registry.wait(item.jobId);
    for (const item of queued) await registry.wait(item.conformanceJobId!);

    for (const item of queued) {
      const conformance = registry.get(item.conformanceJobId!)!;
      expect(conformance.status).toBe("stopped");
      expect(conformance.note).toMatch(/^Cancelled by the queue master/);
      expect(said).toContain(`job ${item.conformanceJobId}`);
    }
    expect(said).toContain("Turned the conformance tests off for every queued job");
    expect(said).toMatch(/· no conformance tests/);
    // The renders ran, with conformance off - and no conformance job ran after them.
    expect(ran).toEqual(["render spec diff", "render spec diff"]);
    expect(conformanceSeen).toEqual([false, false]);
  });

  it("stops the spec diff running now when the new change undoes it, rolls it back, and renders only what is left", async () => {
    const { writeBuiltTree } = await import("../../src/render/state.ts");
    const buildDir = join(dir, "plain_modules", "frontend", "code");
    const specs = (items: string[]) => ({ "functional specs": items.map((markdown) => ({ markdown })) });
    const signUp = "- A visitor signs up.";
    const profile = "- The profile page shows a user's sessions and counts.";
    holdNext = true;
    const feed = "- The feed shows the sessions of the users one follows.";
    writeBuiltTree(buildDir, specs([signUp]) as never);
    writeFileSync(join(dir, "frontend.plain"), `***functional specs***\n\n${signUp}\n${feed}\n`);
    const snapshot = (items: string[]) => ({ moduleName: "frontend", plainFile: join(dir, "frontend.plain"), tree: specs(items), chain: [{ moduleName: "frontend", plainFile: join(dir, "frontend.plain"), buildDir }] }) as unknown as SpecSnapshot;
    const seen: Array<string | undefined> = [];
    const master = async (input: { running?: { jobId: string } }, tools: { draft(): Array<{ jobId?: string; changes: string[] }>; stopRunning(reason: string): string; deleteJob(job: string, reason: string): string; commit(summary: string): { ok: boolean; problems: string[] } }) => {
      seen.push(input.running?.jobId);
      tools.stopRunning("the new change drops the profile page it builds");
      for (const job of tools.draft()) if (job.changes.length === 0) tools.deleteJob(job.jobId!, "its page is gone");
      expect(tools.commit("Stopped the profile page: the change dropped it.").problems).toEqual([]);
    };
    const registry = createJobRegistry();
    const q = createRenderQueue({ registry, cwd: dir, queueMaster: master as never });
    const profileJob = q.enqueueSpecDiff({ plainFile: "frontend.plain", diff: `+${profile}`, applied: "already applied", spec: snapshot([signUp, profile]) });
    // It starts rendering, and is held there.
    while (registry.get(profileJob.jobId)?.status !== "running" || releaseSlow === undefined) await new Promise((resolve) => setTimeout(resolve, 5));
    const feedJob = q.enqueueSpecDiff({ plainFile: "frontend.plain", diff: `+${feed}`, applied: "already applied", spec: snapshot([signUp, feed]) });
    // Stopped, the held render ends when its agent does.
    setTimeout(() => releaseSlow?.(), 20);
    const said = (await q.afterRework(feedJob.jobId))!;
    await registry.wait(feedJob.jobId);

    expect(seen).toEqual([profileJob.jobId]);
    expect(registry.get(profileJob.jobId)!.status).toBe("stopped");
    expect(registry.get(profileJob.jobId)!.note).toMatch(/^Stopped while running, by the queue master: the new change drops the profile page it builds\. What it had done is rolled back/);
    expect(said).toContain(`Taken out, never to run: job ${profileJob.jobId}`);
    expect(ran).toEqual(["render spec diff", "render spec diff"]);
    // The held render never got to its diff; the one that ran after it is the feed's, and the profile page is in no render.
    expect(renderedDiffs).toHaveLength(1);
    expect(renderedDiffs[0]).toContain("The feed shows");
    expect(renderedDiffs[0]).not.toContain("profile page");
  });

  it("renders two modules that share nothing side by side - the frontend does not wait for the backend - and drains both", async () => {
    const snapshot = (module: string) => ({ moduleName: module, plainFile: join(dir, `${module}.plain`), tree: {}, chain: [{ moduleName: module, plainFile: join(dir, `${module}.plain`), buildDir: join(dir, "plain_modules", module, "code") }] }) as unknown as SpecSnapshot;
    writeFileSync(join(dir, "backend.plain"), "***functional specs***\n\n- Serve.\n");
    writeFileSync(join(dir, "frontend.plain"), "***functional specs***\n\n- Show.\n");
    const { registry, queue: q } = queue();
    holdNext = true;
    const backend = q.enqueueSpecDiff({ plainFile: "backend.plain", diff: "+- Serve.", applied: "already applied", spec: snapshot("backend") });
    while (releaseSlow === undefined) await new Promise((resolve) => setTimeout(resolve, 5));
    const frontend = q.enqueueSpecDiff({ plainFile: "frontend.plain", diff: "+- Show.", applied: "already applied", spec: snapshot("frontend") });
    // The backend is held rendering; the frontend renders all the same.
    expect((await registry.wait(frontend.jobId)).status).toBe("succeeded");
    expect(registry.get(backend.jobId)!.status).toBe("running");
    let drained = false;
    const draining = q.drain().then(() => (drained = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(drained).toBe(false);
    releaseSlow!();
    await draining;
    expect(registry.get(backend.jobId)!.status).not.toBe("running");
  });

  it("stacks renders and spec diffs: each render builds the spec as it was when it was queued, and the spec diff between them its own change - never re-taken", async () => {
    const { recordBuiltFunctionality } = await import("../../src/render/state.ts");
    const { plainFileParser } = await import("../../src/plain/parser.ts");
    const { resolveTemplateDirs } = await import("../../src/render/render.ts");
    const buildDir = join(dir, "plain_modules", "app", "code");
    const file = (definition: string, specs: string[]) =>
      `***definitions***\n\n- :Greeting: is ${definition}.\n\n***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n${specs.map((spec) => `- ${spec}`).join("\n\n")}\n`;
    const built: Array<{ frid: string; greeting: string }> = [];
    const registry = createJobRegistry();
    const q = createRenderQueue({
      registry,
      cwd: dir,
      queueMaster: false,
      // A render as the real one lands: it builds and records the spec it was given.
      run: async (request) => {
        const tree = request.pinned!.tree;
        built.push({ frid: request.frid, greeting: (tree["definitions"] as Array<{ markdown: string }>)[0]!.markdown });
        recordBuiltFunctionality(buildDir, tree, request.frid);
        return { report: "built", details: { passed: true, landed: true } };
      },
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    registry.start({ kind: "render", summary: "ahead", lanes: moduleLanes(join(dir, "app.plain")), run: async () => (await held, { report: "" }) });

    writeFileSync(join(dir, "app.plain"), file("a word of welcome", ["Say a :Greeting:."]));
    const first = q.enqueue({ plainFile: "app.plain", frid: "1" });
    // The definition changes after the render was queued: a spec diff of its own, behind it.
    writeFileSync(join(dir, "app.plain"), file("a word of welcome, in the user's language", ["Say a :Greeting:."]));
    const [, afterTree] = plainFileParser("app.plain", resolveTemplateDirs(join(dir, "app.plain")));
    const change = "-- :Greeting: is a word of welcome.\n+- :Greeting: is a word of welcome, in the user's language.";
    const diff = q.enqueueSpecDiff({ plainFile: "app.plain", diff: change, applied: "already applied", spec: { moduleName: "app", plainFile: join(dir, "app.plain"), tree: afterTree, chain: [{ moduleName: "app", plainFile: join(dir, "app.plain"), buildDir }] } as unknown as SpecSnapshot });
    writeFileSync(join(dir, "app.plain"), file("a word of welcome, in the user's language", ["Say a :Greeting:.", "Say goodbye."]));
    const second = q.enqueue({ plainFile: "app.plain", frid: "2" });
    release();
    for (const id of [first.jobId, diff.jobId, second.jobId]) await registry.wait(id);

    // The first render built the definition as it was when it was queued - not the change queued after it.
    expect(built[0]).toEqual({ frid: "1", greeting: "- :Greeting: is a word of welcome." });
    // The spec diff rendered its own change, as written: nothing it expected was missing, so nothing was re-taken.
    expect(renderedDiffs).toEqual([change]);
    expect(registry.get(diff.jobId)!.note ?? "").not.toContain("Rebased");
    // The render after it built from the spec with the change in.
    expect(built[1]).toEqual({ frid: "2", greeting: "- :Greeting: is a word of welcome, in the user's language." });
  });

  describe("functionality renders, reworked by the queue master", () => {
    const file = (specs: string[]) => `***implementation reqs***\n\n- Python.\n\n***test reqs***\n\n- pytest.\n\n***functional specs***\n\n${specs.map((spec) => `- ${spec}`).join("\n\n")}\n`;
    const setup = async (master: unknown) => {
      const rendered: string[] = [];
      const registry = createJobRegistry();
      const q = createRenderQueue({ registry, cwd: dir, queueMaster: master as never, run: async (request) => (rendered.push(request.frid), { report: "built", details: { passed: true, landed: true } }) });
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      registry.start({ kind: "render", summary: "ahead", lanes: moduleLanes(join(dir, "app.plain")), run: async () => (await held, { report: "" }) });
      return { rendered, registry, q, release };
    };
    const snapshotOf = async () => {
      const { plainFileParser } = await import("../../src/plain/parser.ts");
      const { resolveTemplateDirs } = await import("../../src/render/render.ts");
      const [, tree] = plainFileParser("app.plain", resolveTemplateDirs(join(dir, "app.plain")));
      return { moduleName: "app", plainFile: join(dir, "app.plain"), tree, chain: [{ moduleName: "app", plainFile: join(dir, "app.plain"), buildDir: join(dir, "plain_modules", "app", "code") }] } as unknown as SpecSnapshot;
    };
    const deleteEmpty = async (_input: unknown, tools: { draft(): Array<{ jobId?: string; changes: string[] }>; deleteJob(job: string, reason: string): string; commit(summary: string): { ok: boolean; problems: string[] } }) => {
      for (const job of tools.draft()) if (job.changes.length === 0) tools.deleteJob(job.jobId!, "undone");
      expect(tools.commit("Reworked the queue.").problems).toEqual([]);
    };

    it("takes out a queued render the new change undoes - its conformance job with it - and the rest render as asked", async () => {
      writeFileSync(join(dir, "app.plain"), file(["Users sign up."]));
      const { rendered, registry, q, release } = await setup(deleteEmpty);
      const signUp = q.enqueue({ plainFile: "app.plain", frid: "1" });
      writeFileSync(join(dir, "app.plain"), file(["Users sign up.", "Users have a profile page."]));
      const profile = q.enqueue({ plainFile: "app.plain", frid: "2" });
      writeFileSync(join(dir, "app.plain"), file(["Users sign up."]));
      const drop = q.enqueueSpecDiff({ plainFile: "app.plain", diff: "-- Users have a profile page.", applied: "already applied", spec: await snapshotOf() });
      const said = await q.afterRework(drop.jobId);
      release();
      await q.drain();

      expect(said).toContain(`Taken out, never to run: job ${profile.jobId}`);
      expect(registry.get(profile.jobId)!.status).toBe("stopped");
      expect(rendered).toEqual(["1"]);
      expect(renderedDiffs).toEqual([]);
      expect(registry.get(signUp.jobId)!.status).toBe("succeeded");
    });

    it("renders a queued render the new change edits as a spec diff in its place - the spec as it now is - and stops its conformance job", async () => {
      writeFileSync(join(dir, "app.plain"), file(["Users sign up.", "Users have a profile page."]));
      const { rendered, registry, q, release } = await setup(deleteEmpty);
      q.enqueue({ plainFile: "app.plain", frid: "1" });
      const profile = q.enqueue({ plainFile: "app.plain", frid: "2" });
      const profileConformance = q.status().find((entry) => entry.what === "conformance: functionality 2")!.jobId;
      writeFileSync(join(dir, "app.plain"), file(["Users sign up.", "Users have a profile page with their sessions."]));
      const edit = q.enqueueSpecDiff({ plainFile: "app.plain", diff: "-- Users have a profile page.\n+- Users have a profile page with their sessions.", applied: "already applied", spec: await snapshotOf() });
      await q.afterRework(edit.jobId);
      release();
      await q.drain();

      // Functionality 1 as asked; functionality 2 as a spec diff of the page as it now is - the edit folded into it.
      expect(rendered).toEqual(["1"]);
      expect(renderedDiffs).toHaveLength(1);
      expect(renderedDiffs[0]).toContain("Users have a profile page with their sessions.");
      expect(registry.get(profile.jobId)!.status).toBe("succeeded");
      expect(registry.get(profileConformance)!.status).toBe("stopped");
      expect(registry.get(profileConformance)!.note).toContain("was reworked into a spec diff");
      expect(registry.get(edit.jobId)!.status).toBe("stopped");
    });
  });

  it("takes back a render whose conformance tests fail for good - its code and its record - so it counts as not built", async () => {
    const { recordBuiltFunctionality, readBuiltTree } = await import("../../src/render/state.ts");
    const { recordHistory } = await import("../../src/render/history.ts");
    const { existsSync } = await import("node:fs");
    const buildDir = join(dir, "plain_modules", "app", "code");
    writeFileSync(join(dir, "app.plain"), WITH_TEST_REQS);
    const registry = createJobRegistry({ retries: 1, diagnose: async () => undefined });
    const q = createRenderQueue({
      registry,
      cwd: dir,
      queueMaster: false,
      // A render as the real one lands: its code, and the record of what it is built from, committed.
      run: async (request) => {
        writeFileSync(join(buildDir, "hello.py"), "print('hello')\n");
        recordBuiltFunctionality(buildDir, request.pinned!.tree, request.frid);
        recordHistory(buildDir, `render app fs ${request.frid}`);
        return { report: "built", details: { passed: true, landed: true } };
      },
    });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(join(buildDir, "README.md"), "app\n");
    recordHistory(buildDir, "the module as plainwright found it");
    conformancePasses = false;

    const render = q.enqueue({ plainFile: "app.plain", frid: "1" });
    const conformance = q.status().find((entry) => entry.what === "conformance: functionality 1")!.jobId;
    await registry.wait(conformance);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(registry.get(conformance)!.status).toBe("failed");
    // Back where it started: the render's code and its record are gone.
    expect(existsSync(join(buildDir, "hello.py"))).toBe(false);
    expect(readBuiltTree(buildDir)).toBeNull();
    expect(registry.get(render.jobId)!.note).toContain("Undone: its conformance tests");
  });

  it("gives a regeneration its conformance job behind it, as a render has - its tests brought in line, then the whole suite", async () => {
    writeFileSync(join(dir, "app.plain"), WITH_TEST_REQS);
    const asked: Array<{ frid: string; regenerate?: boolean; conformanceLater?: boolean }> = [];
    const registry = createJobRegistry();
    const q = createRenderQueue({ registry, cwd: dir, queueMaster: false, run: async (request) => (asked.push({ frid: request.frid, regenerate: request.regenerate, conformanceLater: request.conformanceLater }), { report: "rebuilt", details: { passed: true, landed: true, conformanceLater: true } }) });
    const queued = q.enqueue({ plainFile: "app.plain", frid: "1", regenerate: true });
    expect(queued.conformanceJobId).toBeDefined();
    expect(q.status().map((entry) => entry.what)).toEqual(["functionality 1 (rebuild)", "conformance: functionality 1 (rebuild)"]);
    await registry.wait(queued.conformanceJobId!);
    // It landed on its unit tests; the job behind it wrote its tests and ran the whole suite.
    expect(asked).toEqual([{ frid: "1", regenerate: true, conformanceLater: true }]);
    expect(ran).toEqual(["conformance 1 + suite"]);
  });
});
