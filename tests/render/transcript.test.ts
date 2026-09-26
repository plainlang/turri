import { describe, expect, it } from "vitest";
import { describeUsage, reportSpec, reportStage, reportTranscript, reportUsage } from "../../src/render/activity.ts";
import { createJobRegistry, describeJob } from "../../src/render/jobs.ts";
import { jobPanelLines } from "../../src/render/job-panel.ts";
import { createTranscriptView, transcriptLines } from "../../src/render/transcript-view.ts";

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
    expect(at).toBeGreaterThan(lines.indexOf("── cognio: spec diff 2 of 3 - Reject duplicate registrations"));
    expect(lines.slice(at + 1, at + 7)).toEqual([
      "~--- a/cognio.plain",
      "~+++ b/cognio.plain",
      "~@@ -3 +3,2 @@",
      "~ - A student can register.",
      "++  - Duplicates return 409.",
      "--  - Old line.",
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

  it("follows the newest line, and scrolls back when asked", async () => {
    const job = await jobWith(() => {
      for (let i = 0; i < 50; i += 1) reportTranscript({ kind: "result", text: `line ${i}` });
    });
    let back = 0;
    let closed = false;
    const view = createTranscriptView({ job: () => job, rows: () => 10, back: () => (back += 1), close: () => (closed = true) });

    const following = view.render(60);
    expect(following).toHaveLength(10);
    // The newest line, then how the job ended.
    expect(following.at(-4)).toContain("line 49");
    expect(following.at(-2)).toBe("── finished");
    expect(following.at(-1)).toContain("following");

    view.handleInput("g");
    expect(view.render(60)[2]).toContain("line 0");

    view.handleInput("G");
    expect(view.render(60).at(-4)).toContain("line 49");

    // Paging without PgUp/PgDn, as in less: b/f a page, u/d half a page, ctrl as well.
    const where = () => view.render(60).at(-1)!;
    view.handleInput("b");
    expect(where()).toContain("6 lines up");
    view.handleInput("f");
    expect(where()).toContain("following");
    view.handleInput("u");
    expect(where()).toContain("3 lines up");
    view.handleInput("d");
    expect(where()).toContain("following");
    view.handleInput("\x02");
    expect(where()).toContain("6 lines up");
    view.handleInput(" ");
    expect(where()).toContain("following");

    // q goes back to the conversation and keeps the place; x closes it for good.
    view.handleInput("g");
    view.handleInput("q");
    expect(back).toBe(1);
    expect(closed).toBe(false);
    expect(view.render(60)[2]).toContain("line 0");

    view.handleInput("x");
    expect(closed).toBe(true);
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
        reportStage("rt_tuples 2: plainwright is writing the code and its unit tests");
        await new Promise<void>((done) => (release = done));
        return { report: "" };
      },
    });
    await new Promise((done) => setTimeout(done, 10));

    const compact = jobPanelLines([job]);
    expect(compact).toContain("    rt_tuples functionality 2 of 5: A :Tuple: supports arithmetic.  (+3 lines · ctrl+o)");
    expect(compact.join("\n")).not.toContain("Adding two tuples");

    const expanded = jobPanelLines([job], { expanded: true });
    expect(expanded).toContain("    rt_tuples functionality 2 of 5:");
    expect(expanded).toContain("      │   - Adding two tuples adds each component.");
    expect(expanded).toContain("      │ - (3, -2, 5, 1) + (-2, 3, 1, 0) is (1, 1, 6, 1).");

    // A module build's own progress widget shows it: the panel does not write it twice.
    const module = jobs.start({
      kind: "render_module",
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
  it("carries its acceptance tests only when conformance is on", async () => {
    const { buildingSpec } = await import("../../src/render/render.ts");
    const specifications = { "functional specs": ["- One.", "- A :Tuple: supports arithmetic."], acceptance_tests: ["- 1 + 1 is 2."] };
    expect(buildingSpec("rt_tuples", "2", 5, specifications as never, true)).toEqual({
      label: "rt_tuples functionality 2 of 5",
      text: "- A :Tuple: supports arithmetic.\n\nacceptance tests:\n- 1 + 1 is 2.",
    });
    expect(buildingSpec("rt_tuples", "2", 5, specifications as never, false).text).toBe("- A :Tuple: supports arithmetic.");
  });
});
