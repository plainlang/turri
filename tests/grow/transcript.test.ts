import { describe, expect, it } from "vitest";
import { describeUsage, reportSpec, reportStage, reportTranscript, reportUsage } from "../../src/grow/activity.ts";
import { createJobRegistry, describeJob } from "../../src/grow/jobs.ts";
import { jobPanelLines } from "../../src/grow/job-panel.ts";
import { transcriptLines } from "../../src/grow/transcript-view.ts";

async function jobWith(run: () => void) {
  const jobs = createJobRegistry();
  const job = jobs.start({ kind: "render", summary: "app.plain fs 1", run: async () => (run(), { report: "" }) });
  await jobs.wait(job.id);
  return job;
}

describe("what a job spends", () => {
  it("adds up every model response", async () => {
    const job = await jobWith(() => {
      reportUsage({ input: 1000, output: 200, cacheRead: 5000, cacheWrite: 0, cost: 0.02 });
      reportUsage({ input: 500, output: 300, cacheRead: 6000, cacheWrite: 0, cost: 0.03 });
    });
    expect(job.usage).toEqual({ input: 1500, output: 500, cacheRead: 11000, cacheWrite: 0, cost: 0.05 });
    expect(describeUsage(job.usage)).toBe("13.0k tok · $0.05");
  });

  it("says nothing before anything is spent", () => {
    expect(describeUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })).toBe("");
  });
});

describe("a job's transcript", () => {
  it("joins the deltas of one reply, and keeps stages, prompts, tool calls and results in order", async () => {
    const job = await jobWith(() => {
      reportStage("app 1: writing code and unit tests");
      reportTranscript({ kind: "prompt", text: "Implement functionality 1." });
      reportTranscript({ kind: "thinking", text: "Start " });
      reportTranscript({ kind: "thinking", text: "with the model." });
      reportTranscript({ kind: "tool", text: 'write {"path":"app.py"}' });
      reportTranscript({ kind: "result", text: "Wrote app.py" });
      reportTranscript({ kind: "text", text: "Done, " });
      reportTranscript({ kind: "text", text: "tests pass." });
    });
    expect(job.transcript.map((e) => [e.kind, e.text])).toEqual([
      ["stage", "app 1: writing code and unit tests"],
      ["prompt", "Implement functionality 1."],
      ["thinking", "Start with the model."],
      ["tool", 'write {"path":"app.py"}'],
      ["result", "Wrote app.py"],
      ["text", "Done, tests pass."],
    ]);
  });

  it("keeps a long run's transcript bounded, dropping the oldest", async () => {
    const job = await jobWith(() => {
      for (let i = 0; i < 400; i += 1) reportTranscript({ kind: i % 2 ? "result" : "tool", text: `${i} ${"x".repeat(2000)}` });
    });
    const size = job.transcript.reduce((sum, e) => sum + e.text.length, 0);
    expect(size).toBeLessThanOrEqual(600_000);
    expect(job.transcript.at(-1)!.text.startsWith("399 ")).toBe(true);
  });
});

describe("the transcript viewer", () => {
  it("shows everything, labelled by who said it", async () => {
    const job = await jobWith(() => {
      reportTranscript({ kind: "prompt", text: "Implement functionality 1." });
      reportTranscript({ kind: "tool", text: "run_unit_tests pytest" });
      reportTranscript({ kind: "result", text: "exit code: 1", error: true });
      reportTranscript({ kind: "text", text: "Fixed it." });
    });
    const lines = transcriptLines(job, 80);
    expect(lines).toContain("harness ▸");
    expect(lines).toContain("  Implement functionality 1.");
    expect(lines).toContain("  ⚙ run_unit_tests pytest");
    expect(lines).toContain("    exit code: 1");
    expect(lines).toContain("agent ▸");
  });

  it("shows a spec change a job renders where it comes, coloured, as the change a render spec diff job leads with", async () => {
    const job = await jobWith(() => {
      reportTranscript({ kind: "stage", text: "cognio: spec diff 2 of 3 - Reject duplicate registrations" });
      reportTranscript({ kind: "diff", text: "--- a/cognio.plain\n+++ b/cognio.plain\n@@ -3 +3,2 @@\n - A student can register.\n+  - Duplicates return 409.\n-  - Old line." });
      reportTranscript({ kind: "prompt", text: "Make the code match the spec change." });
    });
    const style = { heading: (t: string) => t, muted: (t: string) => `~${t}`, accent: (t: string) => t, error: (t: string) => t, added: (t: string) => `+${t}`, removed: (t: string) => `-${t}` };
    const lines = transcriptLines(job, 80, style);
    const at = lines.indexOf("── the spec change");
    expect(at).toBeGreaterThan(lines.indexOf("── harness · cognio: spec diff 2 of 3 - Reject duplicate registrations"));
    // The file named once, quietly; each line after its sign, added and removed ones padded out for their band.
    expect(lines.slice(at + 1, at + 5).map((line) => line.trimEnd())).toEqual([
      "~cognio.plain  ++1 -−1",
      "  - A student can register.",
      "++   - Duplicates return 409.",
      "--   - Old line.",
    ]);
    expect(lines.indexOf("~harness ▸")).toBeGreaterThan(at);
  });

  it("wraps a spec diff line wider than the screen, so a change near its end is still there", async () => {
    const long = `+- A student can register with an email and a handle, and a request whose email or handle already exists returns 409 Conflict`;
    const job = await jobWith(() => reportTranscript({ kind: "diff", text: long }));
    const lines = transcriptLines(job, 60);
    expect(lines.every((line) => line.length <= 60)).toBe(true);
    expect(lines.join(" ").replace(/\s+/g, " ")).toContain("already exists returns 409 Conflict");
  });

});

/** Open the finished section and the first job in it, with the keys: it starts collapsed. */
function openFinished(panel: { render(width: number): string[]; handleInput(data: string): void }, width = 100): void {
  const down = "\x1b[B";
  for (const key of [down, down, "\r", down, "\r"]) {
    panel.render(width);
    panel.handleInput(key);
  }
}

describe("the side panel", () => {
  const PLAIN = { heading: (t: string) => t, muted: (t: string) => t, accent: (t: string) => t, error: (t: string) => t, added: (t: string) => t, removed: (t: string) => t };
  const judge = { label: "app 1 judge", model: "bedrock/sonnet-5:medium" };
  const coder = { label: "app 1 coding agent", model: "bedrock/sonnet-5:low" };

  it("shows the queue and the agents' traces - each agent's turn headed by who it is, one agent at a time when asked", async () => {
    const { createSidePanel } = await import("../../src/grow/side-panel.ts");
    const job = await jobWith(() => {
      reportSpec({ label: "app 1 of 1", text: "The app prints hello.\n\nMore of it." });
      reportStage("conformance tests failing - working out whether the code, the tests or the spec are wrong");
      reportTranscript({ kind: "prompt", text: "Decide what is wrong.", agent: judge });
      reportTranscript({ kind: "text", text: "The code drops the /api/v2 prefix.", agent: judge });
      reportTranscript({ kind: "prompt", text: "Fix the code.", agent: coder });
      reportTranscript({ kind: "tool", text: "edit StorageServiceClient.java", agent: coder });
    });
    let back = 0;
    let closed = false;
    const panel = createSidePanel({ jobs: () => [job], rows: () => 40, style: PLAIN, key: "alt+o", back: () => (back += 1), close: () => (closed = true) });
    const text = () => panel.render(100).join("\n");

    // Jobs first: the queue, with what finished - and, opened, what each was about.
    expect(text()).toContain("[Regeneration]");
    expect(text()).toContain("▸ finished (1)");
    openFinished(panel);
    expect(text()).toContain("▾ finished (1)");
    // Everything is shown already: no ctrl+o to expand it, no pointer to the panel it is in.
    expect(text()).not.toContain("ctrl+o");
    expect(text()).not.toContain("in the side panel:");
    expect(text()).toContain("app.plain fs 1");
    // The functional spec it built, whole.
    expect(text()).toContain("app 1 of 1:");
    expect(text()).toContain("The app prints hello.");
    expect(text()).toContain("More of it.");

    panel.handleInput("\t");
    expect(text()).toContain("[Trace]");
    // The harness's own steps are labelled as the harness's; each agent's turn as that agent's.
    expect(text()).toContain("── harness · conformance tests failing - working out whether");
    expect(text()).toContain("── agent · app 1 judge · bedrock/sonnet-5:medium");
    expect(text()).toContain("judge ▸");
    expect(text()).toContain("── agent · app 1 coding agent · bedrock/sonnet-5:low");

    // One agent at a time: every agent, then each in the order they spoke, then every agent again.
    panel.handleInput("a");
    expect(text()).toContain("The code drops the /api/v2 prefix.");
    expect(text()).not.toContain("edit StorageServiceClient.java");
    panel.handleInput("a");
    expect(text()).toContain("edit StorageServiceClient.java");
    expect(text()).not.toContain("The code drops the /api/v2 prefix.");
    panel.handleInput("a");
    expect(text()).toContain("every agent");

    // Scrolled by keys and by the wheel, following the newest line at the bottom.
    expect(text()).toContain("following");
    panel.handleMouse({ type: "wheel", button: "none", x: 0, y: 0, screenX: 0, screenY: 0, width: 100, height: 40, shift: false, alt: false, ctrl: false, wheelDelta: -1 });

    panel.handleInput("\x1b");
    expect(back).toBe(1);
    expect(closed).toBe(false);
  });

  it("shows under each finished spec diff the whole change, and says which render a conformance job was the conformance of", async () => {
    const { createSidePanel } = await import("../../src/grow/side-panel.ts");
    const { createJobRegistry } = await import("../../src/grow/jobs.ts");
    const registry = createJobRegistry();
    const diff = "--- a/backend.plain\n+++ b/backend.plain\n@@ -1 +1,2 @@\n+- :OrderController: takes the :AuthData: from the request.\n";
    const job = registry.start({ kind: "regrow", summary: "backend.plain render spec diff", diff, run: async () => ({ report: "" }) });
    await registry.wait(job.id);
    const conformance = registry.start({ kind: "bind", summary: "backend.plain spec diff conformance", diff, follows: job.id, run: async () => ({ report: "" }) });
    await registry.wait(conformance.id);
    const panel = createSidePanel({ jobs: () => registry.list(), rows: () => 30, style: PLAIN, key: "ctrl+h", back: () => {}, close: () => {} });
    // Newest first: the conformance job, then the spec diff - each opened, past the row of the conformance job's file.
    const down = "\x1b[B";
    for (const key of [down, down, "\r", down, "\r", down, down, "\r"]) {
      panel.render(120);
      panel.handleInput(key);
    }
    const lines = panel.render(120).join("\n");
    expect(lines).toContain("backend.plain render spec diff");
    expect(lines).toContain("+ - :OrderController: takes the :AuthData: from the request.");
    expect(lines).not.toContain("+++ b/backend.plain");
    expect(lines).toContain(`the conformance of backend.plain render spec diff (pulse ${job.id}, succeeded)`);
  });

  it("says what a module's render planned - the spec diffs it queued - and, under each, which job planned it", async () => {
    const { createSidePanel } = await import("../../src/grow/side-panel.ts");
    const { createJobRegistry } = await import("../../src/grow/jobs.ts");
    const registry = createJobRegistry();
    const diff = "--- a/backend.plain\n+++ b/backend.plain\n@@ -1 +1,2 @@\n+- Comments on study sessions.\n";
    const step = registry.start({ kind: "regrow", summary: "backend.plain render spec diff", diff, run: async () => ({ report: "" }) });
    const planner = registry.start({
      kind: "regrow",
      summary: "backend.plain module",
      run: async () => ({ report: "", details: { passed: true, planned: [{ title: "Implement comments on study sessions", jobId: step.id }] } }),
    });
    await registry.wait(planner.id);
    await registry.wait(step.id);
    const panel = createSidePanel({ jobs: () => registry.list(), rows: () => 40, style: PLAIN, key: "ctrl+h", back: () => {}, close: () => {} });
    const down = "\x1b[B";
    for (const key of [down, down, "\r", down, "o"]) {
      panel.render(140);
      panel.handleInput(key);
    }
    const lines = panel.render(140).join("\n");
    expect(lines).toContain("planned 1 spec diff:");
    expect(lines).toContain(`1. Implement comments on study sessions → backend.plain render spec diff (pulse ${step.id}, succeeded)`);
    expect(lines).toContain(`planned by backend.plain module (pulse ${planner.id}, succeeded)`);
  });
});

describe("a job that is over, in /watch", () => {
  it("ends with how it ended, so it does not look stuck at its last stage", async () => {
    const jobs = createJobRegistry();
    const failed = jobs.start({
      kind: "render",
      summary: "rt_tuples fs 2",
      run: async () => {
        reportStage("rt_tuples 2: checking the unit tests");
        throw new Error("Stopped at rt_tuples functionality 2: after 20 attempts it still could not be built.");
      },
    });
    await jobs.wait(failed.id);
    const lines = transcriptLines(failed, 80);
    const at = lines.indexOf("── finished - failed");
    expect(at).toBeGreaterThan(lines.findIndex((line) => line.includes("checking the unit tests")));
    expect(lines.slice(at + 1).join(" ")).toContain("Stopped at rt_tuples functionality 2: after 20 attempts");

    const running = jobs.start({ kind: "render", summary: "still going", run: () => new Promise(() => {}) });
    reportStage("unused");
    expect(transcriptLines(running, 80).join("\n")).not.toContain("── finished");
  });
});

describe("the functional spec a job is building", () => {
  const spec = {
    label: "rt_tuples functionality 2 of 5",
    text: "A :Tuple: supports arithmetic.\n  - Adding two tuples adds each component.\n\nacceptance tests:\n- (3, -2, 5, 1) + (-2, 3, 1, 0) is (1, 1, 6, 1).",
  };

  it("is shown with the job: its first line, and all of it while expanded", async () => {
    const jobs = createJobRegistry();
    let release = () => {};
    const job = jobs.start({
      kind: "render",
      summary: "rt_tuples.plain module",
      run: async () => {
        reportSpec(spec);
        reportStage("rt_tuples 2: turri is writing the code and its unit tests");
        await new Promise<void>((done) => (release = done));
        return { report: "" };
      },
    });
    await new Promise((done) => setTimeout(done, 10));

    // With how long it has been on it.
    const now = job.building!.since! + 7_000;
    const compact = jobPanelLines([job], { now });
    expect(compact).toContain("    rt_tuples functionality 2 of 5 · 7s: A :Tuple: supports arithmetic.  (+3 lines · ctrl+o)");
    expect(compact.join("\n")).not.toContain("Adding two tuples");

    const expanded = jobPanelLines([job], { expanded: true, now });
    expect(expanded).toContain("    rt_tuples functionality 2 of 5 · 7s:");
    expect(expanded).toContain("      │   - Adding two tuples adds each component.");
    expect(expanded).toContain("      │ - (3, -2, 5, 1) + (-2, 3, 1, 0) is (1, 1, 6, 1).");

    // A module build's own progress widget shows it: the panel does not write it twice.
    const module = jobs.start({
      kind: "regrow",
      summary: "rt_tuples.plain module",
      run: async () => {
        reportSpec(spec);
        await new Promise<void>(() => {});
        return { report: "" };
      },
    });
    await new Promise((done) => setTimeout(done, 10));
    expect(jobPanelLines([module], { expanded: true }).join("\n")).not.toContain("supports arithmetic");
    expect(transcriptLines(module, 80)).toContain("── building rt_tuples functionality 2 of 5");

    // And whole in /watch, where it began.
    const lines = transcriptLines(job, 80);
    expect(lines).toContain("── building rt_tuples functionality 2 of 5");
    expect(lines.join("\n")).toContain("Adding two tuples adds each component.");
    expect(describeJob(job)).toContain("building rt_tuples functionality 2 of 5:");
    release();
    await jobs.wait(job.id);
  });
});

describe("the spec text shown for a functionality", () => {
  it("carries its acceptance tests, which the conformance tests are written from", async () => {
    const { buildingSpec } = await import("../../src/grow/conformance.ts");
    const specifications = { "functional specs": ["- One.", "- A :Tuple: supports arithmetic."], acceptance_tests: ["- 1 + 1 is 2."] };
    expect(buildingSpec("rt_tuples", "2", 5, specifications as never)).toEqual({
      label: "rt_tuples functionality 2 of 5",
      text: "- A :Tuple: supports arithmetic.\n\nacceptance tests:\n- 1 + 1 is 2.",
    });
  });
});

describe("how long the job has been on what it is building now", () => {
  it("is shown beside the job's own time - for a module under it, for anything else on its building line - and kept through its later stages", async () => {
    let finish!: () => void;
    const held = new Promise<void>((resolve) => (finish = resolve));
    const jobs = createJobRegistry();
    const job = jobs.start({
      kind: "regrow",
      summary: "app.plain module",
      run: async () => {
        reportSpec({ label: "app functionality 17 of 23", text: "- Back it up." });
        await held;
        return { report: "" };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const since = job.building!.since!;
    const lines = jobPanelLines(jobs.list(), { now: since + 192_000 });
    expect(lines[0]).toMatch(/app\.plain module · \d+s/);
    expect(lines).toContain("    app functionality 17 of 23 · 3m 12s");

    const other = createJobRegistry();
    const render = other.start({ kind: "render", summary: "app.plain fs 3", run: async () => (reportSpec({ label: "app functionality 3 of 5", text: "- Say hello." }), await held, { report: "" }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(jobPanelLines(other.list(), { now: render.building!.since! + 42_000 })).toContain("    app functionality 3 of 5 · 42s: - Say hello.");
    finish();
    await jobs.wait(job.id);
  });

  it("keeps its clock when the same functionality goes on to its next stage, and starts a new one for the next", async () => {
    const released: Array<() => void> = [];
    const hold = () => new Promise<void>((resolve) => released.push(resolve));
    const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
    const jobs = createJobRegistry();
    const job = jobs.start({
      kind: "regrow",
      summary: "m",
      run: async () => {
        reportSpec({ label: "app functionality 1 of 2", text: "one" });
        await hold();
        reportSpec({ label: "app functionality 1 of 2", text: "one, with its acceptance tests" });
        await hold();
        reportSpec({ label: "app functionality 2 of 2", text: "two" });
        return { report: "" };
      },
    });
    await tick();
    const first = job.building!.since!;
    released.shift()!();
    await tick();
    // Its conformance stage: the same functionality, the same clock.
    expect(job.building!.text).toBe("one, with its acceptance tests");
    expect(job.building!.since).toBe(first);
    released.shift()!();
    await jobs.wait(job.id);
    expect(job.building!.label).toBe("app functionality 2 of 2");
    expect(job.building!.since!).toBeGreaterThan(first);
  });

  it("reads in hours once it passes one", async () => {
    const { formatElapsed } = await import("../../src/grow/jobs.ts");
    expect(formatElapsed(35 * 60_000)).toBe("35m 0s");
    expect(formatElapsed(3 * 3_600_000 + 5 * 60_000)).toBe("3h 5m");
  });
});
