import { describe, expect, it } from "vitest";
import { describeUsage, reportStage, reportTranscript, reportUsage } from "../../src/render/activity.ts";
import { createJobRegistry } from "../../src/render/jobs.ts";
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

  it("follows the newest line, and scrolls back when asked", async () => {
    const job = await jobWith(() => {
      for (let i = 0; i < 50; i += 1) reportTranscript({ kind: "result", text: `line ${i}` });
    });
    let back = 0;
    let closed = false;
    const view = createTranscriptView({ job: () => job, rows: () => 10, back: () => (back += 1), close: () => (closed = true) });

    const following = view.render(60);
    expect(following).toHaveLength(10);
    expect(following.at(-2)).toContain("line 49");
    expect(following.at(-1)).toContain("following");

    view.handleInput("g");
    expect(view.render(60)[2]).toContain("line 0");

    view.handleInput("G");
    expect(view.render(60).at(-2)).toContain("line 49");

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
