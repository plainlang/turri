import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpecSnapshot } from "../../src/render/spec-change.ts";

/** Everything the queue ran, in order, and whether each render passes. */
const ran: string[] = [];
let renderPasses = true;
const conformanceLaterSeen: Array<boolean | undefined> = [];
const renderedDiffs: string[] = [];

vi.mock("../../src/render/spec-change.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/render/spec-change.ts")>();
  return {
    ...actual,
    renderSpecDiff: async (options: { conformanceLater?: boolean; diff?: string; spec?: { tree: object; chain?: Array<{ buildDir: string }> } }) => {
      ran.push("render spec diff");
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
    renderConformanceSuite: async (options: { frids?: string[] }) => (ran.push(`conformance ${options.frids?.join(",")}`), { passed: true }),
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

  it("are not queued for a regeneration, which brings its own tests in line", () => {
    writeFileSync(join(dir, "app.plain"), WITH_TEST_REQS);
    const { registry, queue: q } = queue(async () => ({ report: "built", details: { landed: true } }));
    q.enqueue({ plainFile: "app.plain", frid: "1", regenerate: true });
    expect(registry.list().some((job) => job.kind === "render_functionality_conformance")).toBe(false);
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

    expect(asked).toEqual([undefined, "run the feed before the nav bar"]);
    expect(said).toContain("Put the feed first, as asked.");
    expect(said).toMatch(/in the order they run:\n- job .* · .*\n- job /);
    // The jobs keep their places; what each renders is the plan's.
    expect(registry.get(navJob.jobId)!.status).toBe("succeeded");
    expect(renderedDiffs).toHaveLength(2);
  });
});
