import { describe, expect, it, vi } from "vitest";
import { createJobRegistry, describeJob, shouldWait } from "../../src/render/jobs.ts";

const outcome = (report: string) => ({ report });

describe("shouldWait", () => {
  it("runs in the background in the interactive TUI", () => {
    expect(shouldWait("tui", undefined)).toBe(false);
  });

  it("blocks everywhere else, where a detached job would not survive the turn", () => {
    for (const mode of ["print", "json", "rpc"]) expect(shouldWait(mode, undefined)).toBe(true);
  });

  it("lets an explicit choice win", () => {
    expect(shouldWait("tui", true)).toBe(true);
    expect(shouldWait("print", false)).toBe(false);
  });
});

describe("the job registry", () => {
  it("returns immediately while the work continues", async () => {
    const registry = createJobRegistry();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const job = registry.start({
      kind: "render",
      summary: "demo 1",
      run: async () => {
        await blocked;
        return outcome("built it");
      },
    });

    expect(job.status).toBe("running");
    expect(registry.get(job.id)?.status).toBe("running");

    release();
    const finished = await registry.wait(job.id);
    expect(finished.status).toBe("succeeded");
    expect(finished.report).toBe("built it");
  });

  it("records a failure instead of throwing into the session", async () => {
    const registry = createJobRegistry();
    const job = registry.start({
      kind: "render",
      summary: "demo 1",
      run: async () => {
        throw new Error("provider exploded");
      },
    });

    const finished = await registry.wait(job.id);
    expect(finished.status).toBe("failed");
    expect(finished.error).toBe("provider exploded");
  });

  it("notifies once the job settles", async () => {
    const onFinish = vi.fn();
    const registry = createJobRegistry({ onFinish });

    const job = registry.start({ kind: "render", summary: "demo 1", run: async () => outcome("done") });
    await registry.wait(job.id);

    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish.mock.calls[0]![0].id).toBe(job.id);
  });

  it("survives a listener that throws", async () => {
    const registry = createJobRegistry({
      onFinish: () => {
        throw new Error("listener broke");
      },
    });

    const job = registry.start({ kind: "render", summary: "demo 1", run: async () => outcome("done") });

    await expect(registry.wait(job.id)).resolves.toMatchObject({ status: "succeeded" });
  });

  it("keeps a bounded tail of the streamed output", async () => {
    const registry = createJobRegistry({ tailChars: 10 });
    const job = registry.start({
      kind: "render",
      summary: "demo 1",
      run: async (onDelta) => {
        onDelta("0123456789");
        onDelta("abcdef");
        return outcome("done");
      },
    });

    await registry.wait(job.id);
    expect(registry.get(job.id)!.tail).toBe("6789abcdef");
  });

  it("lists newest first", async () => {
    const registry = createJobRegistry();
    const first = registry.start({ kind: "render", summary: "one", run: async () => outcome("a") });
    await registry.wait(first.id);
    const second = registry.start({ kind: "render", summary: "two", run: async () => outcome("b") });
    await registry.wait(second.id);

    expect(registry.list().map((job) => job.summary)).toEqual(["two", "one"]);
  });

  it("rejects a wait on an unknown job", async () => {
    await expect(createJobRegistry().wait("nope")).rejects.toThrow("No such job: nope");
  });

  it("shows the latest output while running and the report once done", async () => {
    const registry = createJobRegistry();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const job = registry.start({
      kind: "render_module",
      summary: "greeter",
      run: async (onDelta) => {
        onDelta("working on it");
        await blocked;
        return outcome("all done");
      },
    });

    await vi.waitFor(() => expect(registry.get(job.id)!.tail).toContain("working"));
    expect(describeJob(registry.get(job.id)!)).toContain("working on it");

    release();
    expect(describeJob(await registry.wait(job.id))).toContain("all done");
  });
});
