import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpecSnapshot } from "../../src/render/spec-change.ts";

/** Everything the queue ran, in order, and whether each render passes. */
const ran: string[] = [];
let renderPasses = true;
const conformanceLaterSeen: Array<boolean | undefined> = [];

vi.mock("../../src/render/spec-change.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/render/spec-change.ts")>();
  return {
    ...actual,
    renderSpecDiff: async (options: { conformanceLater?: boolean }) => {
      ran.push("render spec diff");
      conformanceLaterSeen.push(options.conformanceLater);
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
const { createRenderQueue } = await import("../../src/render/queue.ts");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plainwright-queue-conformance-"));
  ran.length = 0;
  conformanceLaterSeen.length = 0;
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

  it("are not queued with conformance off, or with no test reqs to write them from - the render keeps them itself", () => {
    const { queue: q } = queue();
    expect(q.enqueueSpecDiff({ plainFile: "app.plain", diff: "+x", applied: "already applied", spec: spec(false) }).conformanceJobId).toBeUndefined();
    expect(q.enqueueSpecDiff({ plainFile: "app.plain", diff: "+x", applied: "already applied", spec: spec(true), conformance: false }).conformanceJobId).toBeUndefined();
    writeFileSync(join(dir, "config.yaml"), "conformance-tests: false\n");
    expect(q.enqueueSpecDiff({ plainFile: "app.plain", diff: "+x", applied: "already applied", spec: spec(true) }).conformanceJobId).toBeUndefined();
    expect(conformanceLaterSeen.every((seen) => seen !== true)).toBe(true);
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
