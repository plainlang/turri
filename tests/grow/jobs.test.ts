import { describe, expect, it, vi } from "vitest";
import { createJobRegistry, describeJob, shouldWait } from "../../src/grow/jobs.ts";

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
    await expect(createJobRegistry().wait("nope")).rejects.toThrow("No such pulse: nope");
  });

  it("shows the latest output while running and the report once done", async () => {
    const registry = createJobRegistry();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const job = registry.start({
      kind: "regenerate",
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

describe("a job that fails", () => {
  it("is run once more; failing again, it is diagnosed and every job queued behind it fails without running", async () => {
    let runs = 0;
    let laterRan = false;
    const diagnose = vi.fn(async (_job: unknown, failures: string[]) => `What happened: failed ${failures.length} times.\nTo fix - in the spec:\n  1. Say where the auth data comes from.`);
    const registry = createJobRegistry({ retries: 1, diagnose });
    const first = registry.start({
      kind: "bind",
      summary: "backend.plain spec diff conformance",
      lanes: ["queue"],
      run: async () => ((runs += 1), { report: `attempt ${runs}: the tests do not pass`, details: { passed: false } }),
    });
    const second = registry.start({ kind: "render", summary: "backend.plain fs 2", lanes: ["queue"], run: async () => ((laterRan = true), { report: "built" }) });
    const third = registry.start({ kind: "render", summary: "backend.plain fs 3", lanes: ["queue"], run: async () => ((laterRan = true), { report: "built" }) });

    const done = await registry.wait(first.id);
    expect(runs).toBe(2);
    expect(done.status).toBe("failed");
    expect(done.failedForGood).toBe(true);
    expect(diagnose).toHaveBeenCalledWith(expect.objectContaining({ id: first.id }), ["attempt 1: the tests do not pass", "attempt 2: the tests do not pass"], undefined);
    expect(done.error).toContain("Failed 2 times, so it and every pulse queued behind it have stopped.");
    expect(done.error).toContain("Say where the auth data comes from.");

    // Everything behind it fails without running - pointing at it, with its diagnosis.
    for (const later of [second, third]) {
      const settled = await registry.wait(later.id);
      expect(settled.status).toBe("failed");
      expect(settled.error).toMatch(/^Not run: pulse \S+ ahead of it in the queue \(.+\) failed twice/);
    }
    expect(laterRan).toBe(false);
  });

  it("runs as many jobs at once as it has slots - ten modules that share nothing wait their turn, and every one runs", async () => {
    const registry = createJobRegistry({ maxRunning: 3 });
    let running = 0;
    let most = 0;
    const release: Array<() => void> = [];
    const started = Array.from({ length: 10 }, (_, index) =>
      registry.start({
        kind: "regenerate",
        summary: `module${index}.plain render spec diff`,
        lanes: [`plain_modules/module${index}`],
        run: async () => {
          running += 1;
          most = Math.max(most, running);
          await new Promise<void>((resolve) => release.push(resolve));
          running -= 1;
          return { report: "built" };
        },
      }),
    );
    while (release.length < 3) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(started.filter((job) => registry.get(job.id)!.status === "running")).toHaveLength(3);
    const waiting = registry.get(started[5]!.id)!;
    expect(waiting.status).toBe("queued");
    expect(waiting.stage).toContain("waiting for a free slot - 3 of 3 pulses running at once");
    // A job stopped while it waits for a slot gives its turn up, and never runs.
    registry.stop(started[9]!.id);
    for (let done = 0; done < 9; done += 1) {
      while (release.length === 0) await new Promise((resolve) => setTimeout(resolve, 2));
      release.shift()!();
    }
    for (const job of started) await registry.wait(job.id);
    expect(most).toBe(3);
    expect(started.slice(0, 9).every((job) => registry.get(job.id)!.status === "succeeded")).toBe(true);
    expect(registry.get(started[9]!.id)!.status).toBe("stopped");
  });

  it("failing for good stops only what is queued behind it on its own lanes - a module that shares nothing goes on", async () => {
    const registry = createJobRegistry({ retries: 1, diagnose: async () => undefined });
    const failing = registry.start({ kind: "regenerate", summary: "frontend.plain render spec diff", lanes: ["plain_modules/frontend"], run: async () => ({ report: "no", details: { passed: false } }) });
    const behind = registry.start({ kind: "regenerate", summary: "frontend.plain render spec diff", lanes: ["plain_modules/frontend"], run: async () => ({ report: "built" }) });
    const other = registry.start({ kind: "regenerate", summary: "backend.plain render spec diff", lanes: ["plain_modules/backend"], run: async () => ({ report: "built" }) });
    expect((await registry.wait(failing.id)).failedForGood).toBe(true);
    expect((await registry.wait(behind.id)).status).toBe("failed");
    expect((await registry.wait(other.id)).status).toBe("succeeded");
  });

  it("that passes on its second try goes on as if it had passed the first time - and one that throws is retried the same way", async () => {
    let runs = 0;
    const registry = createJobRegistry({ retries: 1 });
    const flaky = registry.start({ kind: "render", summary: "app fs 1", run: async () => { runs += 1; if (runs === 1) throw new Error("provider down"); return { report: "built", details: { passed: true } }; } });
    const done = await registry.wait(flaky.id);
    expect(done.status).toBe("succeeded");
    expect(runs).toBe(2);
    expect(done.transcript.some((entry) => entry.kind === "stage" && entry.text.includes("trying it once more"))).toBe(true);
  });

  it("without retries - a registry that does not ask for them - is reported and the queue goes on", async () => {
    const plain = createJobRegistry();
    let ran = false;
    const failing = plain.start({ kind: "render", summary: "a", lanes: ["q"], run: async () => ({ report: "no", details: { passed: false } }) });
    const next = plain.start({ kind: "render", summary: "b", lanes: ["q"], run: async () => ((ran = true), { report: "yes" }) });
    expect((await plain.wait(failing.id)).status).toBe("succeeded");
    expect((await plain.wait(next.id)).status).toBe("succeeded");
    expect(ran).toBe(true);
  });
});
