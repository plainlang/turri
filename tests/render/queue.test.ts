import { describe, expect, it, vi } from "vitest";
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
