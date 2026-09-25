import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { plainFileParser } from "../../src/plain/parser.ts";
import { resolveTemplateDirs } from "../../src/render/render.ts";
import { recordBuiltFunctionality } from "../../src/render/state.ts";
import { createJobRegistry } from "../../src/render/jobs.ts";
import { createRenderQueue, type RenderRunner } from "../../src/render/queue.ts";

/** Records the order renders start and finish, and lets each be released by hand. */
function tracker() {
  const started: string[] = [];
  const finished: string[] = [];
  const release = new Map<string, () => void>();
  const gates = new Map<string, Promise<void>>();

  const run: RenderRunner = async (request) => {
    started.push(request.frid);
    if (!gates.has(request.frid)) {
      gates.set(request.frid, new Promise<void>((resolve) => release.set(request.frid, resolve)));
    }
    await gates.get(request.frid);
    finished.push(request.frid);
    return { report: `built ${request.frid}` };
  };

  const hold = (frid: string) => {
    if (!gates.has(frid)) {
      gates.set(frid, new Promise<void>((resolve) => release.set(frid, resolve)));
    }
  };

  return { started, finished, run, hold, release };
}

describe("the render queue", () => {
  it("returns immediately so the interview never waits", () => {
    const t = tracker();
    t.hold("1");
    const queue = createRenderQueue({ registry: createJobRegistry(), cwd: ".", run: t.run });

    const entry = queue.enqueue({ plainFile: "app.plain", frid: "1" });

    expect(entry.jobId).toBeTruthy();
    expect(entry.position).toBe(1);
  });

  it("runs one at a time, in the order asked for", async () => {
    const t = tracker();
    for (const frid of ["1", "2", "3"]) t.hold(frid);
    const queue = createRenderQueue({ registry: createJobRegistry(), cwd: ".", run: t.run });

    queue.enqueue({ plainFile: "app.plain", frid: "1" });
    queue.enqueue({ plainFile: "app.plain", frid: "2" });
    queue.enqueue({ plainFile: "app.plain", frid: "3" });

    await vi.waitFor(() => expect(t.started).toEqual(["1"]));
    expect(t.started).not.toContain("2");

    t.release.get("1")!();
    await vi.waitFor(() => expect(t.started).toEqual(["1", "2"]));

    t.release.get("2")!();
    t.release.get("3")!();
    await queue.drain();

    expect(t.finished).toEqual(["1", "2", "3"]);
  });

  it("does not let a failed render cancel the ones behind it", async () => {
    const started: string[] = [];
    const run: RenderRunner = async (request) => {
      started.push(request.frid);
      if (request.frid === "1") throw new Error("render blew up");
      return { report: `built ${request.frid}` };
    };
    const registry = createJobRegistry();
    const queue = createRenderQueue({ registry, cwd: ".", run });

    const first = queue.enqueue({ plainFile: "app.plain", frid: "1" });
    queue.enqueue({ plainFile: "app.plain", frid: "2" });
    await queue.drain();

    expect(started).toEqual(["1", "2"]);
    expect(registry.get(first.jobId)!.status).toBe("failed");
  });

  it("reports what is queued, in order, with each state", async () => {
    const t = tracker();
    t.hold("1");
    t.hold("2");
    const queue = createRenderQueue({ registry: createJobRegistry(), cwd: ".", run: t.run });

    queue.enqueue({ plainFile: "app.plain", frid: "1" });
    queue.enqueue({ plainFile: "app.plain", frid: "2" });

    expect(queue.status().map((e) => [e.position, e.frid])).toEqual([
      [1, "1"],
      [2, "2"],
    ]);

    t.release.get("1")!();
    t.release.get("2")!();
    await queue.drain();

    expect(queue.status().every((e) => e.status === "succeeded")).toBe(true);
  });

  it("carries the regenerate flag through", async () => {
    const seen: Array<boolean | undefined> = [];
    const run: RenderRunner = async (request) => {
      seen.push(request.regenerate);
      return { report: "ok" };
    };
    const queue = createRenderQueue({ registry: createJobRegistry(), cwd: ".", run });

    queue.enqueue({ plainFile: "app.plain", frid: "1" });
    queue.enqueue({ plainFile: "app.plain", frid: "1", regenerate: true });
    await queue.drain();

    expect(seen).toEqual([undefined, true]);
  });
});

describe("re-queueing what the specification changed under", () => {
  const spec = (two = "- Two.") =>
    `***implementation reqs***\n\n- A req.\n\n***functional specs***\n\n- One.\n\n${two}\n\n- Three.\n`;

  function project() {
    const dir = mkdtempSync(join(tmpdir(), "queue-stale-"));
    const build = join(dir, "build");
    writeFileSync(join(dir, "app.plain"), spec());
    const tree = () => plainFileParser("app.plain", resolveTemplateDirs(join(dir, "app.plain")))[1];
    const built = (frid: string) =>
      recordBuiltFunctionality(build, tree(), frid);
    return { dir, build, tree, built, change: (t: string) => writeFileSync(join(dir, "app.plain"), spec(t)) };
  }

  it("queues nothing when every built functionality still matches", () => {
    const p = project();
    p.built("1");
    const queue = createRenderQueue({ registry: createJobRegistry(), cwd: p.dir, buildDir: p.build, run: async () => ({ report: "" }) });

    expect(queue.requeueStale("app.plain")).toEqual([]);
    rmSync(p.dir, { recursive: true, force: true });
  });

  it("queues a regeneration for a functionality whose spec changed after it was built", async () => {
    const p = project();
    p.built("1");
    p.built("2");
    p.change("- Two, rewritten.");

    const seen: Array<{ frid: string; regenerate?: boolean }> = [];
    const queue = createRenderQueue({
      registry: createJobRegistry(), cwd: p.dir, buildDir: p.build,
      run: async (request) => {
        seen.push({ frid: request.frid, regenerate: request.regenerate });
        return { report: "" };
      },
    });

    const requeued = queue.requeueStale("app.plain");
    await queue.drain();

    // Only 2: it was built and its spec has since changed. 3 was never built, so there is
    // nothing of it to regenerate, however much its spec has moved.
    expect(requeued.map((r) => r.frid)).toEqual(["2"]);
    expect(seen.every((s) => s.regenerate === true)).toBe(true);
    rmSync(p.dir, { recursive: true, force: true });
  });

  it("ignores a spec that was never built - there is nothing to regenerate", () => {
    const p = project();
    p.change("- Two, rewritten.");
    const queue = createRenderQueue({ registry: createJobRegistry(), cwd: p.dir, buildDir: p.build, run: async () => ({ report: "" }) });

    expect(queue.requeueStale("app.plain")).toEqual([]);
    rmSync(p.dir, { recursive: true, force: true });
  });

  it("does not re-queue a functionality that is already building", async () => {
    const p = project();
    p.built("1");
    p.change("- Two, rewritten.");

    let release!: () => void;
    const blocked = new Promise<void>((r) => { release = r; });
    const queue = createRenderQueue({
      registry: createJobRegistry(), cwd: p.dir, buildDir: p.build,
      run: async () => { await blocked; return { report: "" }; },
    });

    queue.enqueue({ plainFile: "app.plain", frid: "2" });
    await vi.waitFor(() => expect(queue.status()[0]!.status).toBe("running"));
    const requeued = queue.requeueStale("app.plain");

    expect(requeued.map((r) => r.frid)).not.toContain("2");
    release();
    await queue.drain();
    rmSync(p.dir, { recursive: true, force: true });
  });
});
