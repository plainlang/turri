import { describe, expect, it } from "vitest";
import { ask } from "../../src/pi.ts";
import { createJobRegistry } from "../../src/regenerate/jobs.ts";

function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  return { opened, release };
}

/** An agent session whose turn lasts until it is aborted. */
function stallingSession() {
  let finish!: () => void;
  let aborted = false;
  const session = {
    model: undefined,
    subscribe: () => () => {},
    prompt: () => new Promise<void>((resolve) => (finish = resolve)),
    abort: async () => {
      aborted = true;
      finish();
    },
  };
  return { session: session as never, wasAborted: () => aborted };
}

describe("stopping a job", () => {
  it("stops a queued job before it starts, and the one behind it runs instead", async () => {
    const jobs = createJobRegistry();
    const { opened, release } = gate();
    const ran: string[] = [];
    const run = (name: string) => async () => {
      ran.push(name);
      if (name === "a") await opened;
      return { report: name };
    };
    const a = jobs.start({ kind: "render", summary: "a", lanes: ["m"], run: run("a") });
    const b = jobs.start({ kind: "render", summary: "b", lanes: ["m"], run: run("b") });
    const c = jobs.start({ kind: "render", summary: "c", lanes: ["m"], run: run("c") });

    expect(jobs.stop(b.id)?.status).toBe("stopped");
    release();
    await jobs.wait(c.id);

    expect(ran).toEqual(["a", "c"]);
    expect([a.status, b.status, c.status]).toEqual(["succeeded", "stopped", "succeeded"]);
  });

  it("keeps a new job behind a stopped one until the job ahead of both is done", async () => {
    const jobs = createJobRegistry();
    const { opened, release } = gate();
    const order: string[] = [];
    const a = jobs.start({ kind: "render", summary: "a", lanes: ["m"], run: async () => (order.push("a start"), await opened, order.push("a end"), { report: "" }) });
    const b = jobs.start({ kind: "render", summary: "b", lanes: ["m"], run: async () => ({ report: "" }) });
    jobs.stop(b.id);
    const c = jobs.start({ kind: "render", summary: "c", lanes: ["m"], run: async () => (order.push("c"), { report: "" }) });

    expect(c.status).toBe("queued");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["a start"]);
    release();
    await jobs.wait(c.id);
    expect(order).toEqual(["a start", "a end", "c"]);
    expect(a.status).toBe("succeeded");
  });

  it("aborts a running job's agent, and calls the job stopped rather than failed", async () => {
    const jobs = createJobRegistry();
    const agent = stallingSession();
    let turns = 0;
    const job = jobs.start({
      kind: "render",
      summary: "a",
      run: async () => {
        turns += 1;
        await ask(agent.session, "Implement functionality 1.");
        turns += 1; // a harness loop that would carry on to its next turn
        await ask(agent.session, "The tests fail. Fix them.");
        return { report: "" };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    jobs.stop(job.id);
    await jobs.wait(job.id);

    expect(agent.wasAborted()).toBe(true);
    expect(turns).toBe(1);
    expect(job.status).toBe("stopped");
  });

  it("will not stop a job that has already finished", async () => {
    const jobs = createJobRegistry();
    const job = jobs.start({ kind: "render", summary: "a", run: async () => ({ report: "" }) });
    await jobs.wait(job.id);
    expect(jobs.stop(job.id)).toBeUndefined();
    expect(job.status).toBe("succeeded");
  });
});

describe("a spec that contradicts itself, for the person", () => {
  it("says exactly which two functional specs, as they read, what cannot hold - and that the decision is theirs", async () => {
    const { describeSpecConflict } = await import("../../src/regenerate/stop-report.ts");
    const text = describeSpecConflict({
      moduleName: "cognio",
      plainFile: "/p/cognio.plain",
      specs: [
        { module: "accounts", frid: "1", plainFile: "/p/accounts.plain", text: "- A user can register.\n  - A duplicate email returns `400`." },
        { module: "cognio", frid: "4", plainFile: "/p/cognio.plain", text: "- A duplicate email returns `409`." },
      ],
      reasons: ["1 says 400, 4 says 409 for the same request.", "1 says 400, 4 says 409 for the same request.", "Both cannot hold."],
    });
    // Across modules: each named with its module and the file it is in.
    expect(text).toContain("functional spec 1 of accounts and functional spec 4 of cognio cannot both hold");
    expect(text).toContain("Functional spec 1 of accounts (accounts.plain):\n  - A user can register.\n    - A duplicate email returns `400`.");
    expect(text).toContain("Functional spec 4 of cognio (cognio.plain):\n  - A duplicate email returns `409`.");
    // Each reason once.
    expect(text.match(/1 says 400/g)).toHaveLength(1);
    expect(text).toContain("found 3 times");
    expect(text).toContain("only you can say what is meant");
    // Nothing of the code or the tests: the spec is all the person works on.
    expect(text).not.toContain("plain_modules");
  });
});
