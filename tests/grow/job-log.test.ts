import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reportActivity, reportAgent, reportNote, reportStage, reportTranscript } from "../../src/grow/activity.ts";
import { createJobRegistry, describeJob } from "../../src/grow/jobs.ts";

let root: string;
let lane: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "turri-job-log-"));
  lane = join(root, "plain_modules", "app");
  mkdirSync(lane, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("a job's log", () => {
  it("keeps the harness's notes - which walls are up, what was put back - and not every activity line", async () => {
    const jobs = createJobRegistry();
    const job = jobs.start({
      kind: "regenerate",
      summary: "app.plain render spec diff",
      lanes: [lane],
      run: async () => {
        reportNote("  commands on this machine behind the command check, Seatbelt and the audit");
        reportActivity("$ mkdir -p src");
        reportTranscript({ kind: "thinking", text: "First the folders." });
        reportNote("  an agent's command changed app.plain - put back");
        reportTranscript({ kind: "thinking", text: "Now the code." });
        return { report: "Rendered the spec change." };
      },
    });
    await jobs.wait(job.id);
    expect(jobs.get(job.id)!.activity).toContain("$ mkdir -p src");
    const dir = join(root, ".turri", "jobs");
    const text = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8");
    expect(text).toMatch(/\[[\d:.]+\] · commands on this machine behind the command check, Seatbelt and the audit/);
    expect(text).toMatch(/\[[\d:.]+\] · an agent's command changed app\.plain - put back/);
    expect(text).not.toContain("mkdir");
    // A note between two thoughts parts them: the second is not run on into the note.
    expect(text).toMatch(/· an agent's command changed app\.plain - put back\n+\[[\d:.]+\] thinking ▸\nNow the code\./);
  });

  it("ends with each of its agents - turns, compactions and what it cost - and growth says the same", async () => {
    const jobs = createJobRegistry();
    const spent = { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 0, cost: 0.05 };
    const job = jobs.start({
      kind: "render",
      summary: "app.plain fs 1",
      lanes: [lane],
      run: async () => {
        for (let turn = 0; turn < 3; turn += 1) reportAgent({ label: "app 1 coding agent", model: "anthropic/claude-sonnet-5", turns: 1, usage: spent });
        reportAgent({ label: "app 1 coding agent", compactions: 1 });
        reportAgent({ label: "app 1 reviewer", turns: 2, usage: spent });
        return { report: "Built it." };
      },
    });
    await jobs.wait(job.id);
    const finished = jobs.get(job.id)!;
    expect(finished.agents.map((agent) => [agent.label, agent.turns, agent.compactions])).toEqual([
      ["app 1 coding agent", 3, 1],
      ["app 1 reviewer", 2, 0],
    ]);
    const dir = join(root, ".turri", "jobs");
    const text = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8");
    expect(text).toContain("── its agents\n  app 1 coding agent · 3 turns · 1 compaction · 18.6k tok · $0.15 · anthropic/claude-sonnet-5\n  app 1 reviewer · 2 turns · 6.2k tok · $0.05");
    expect(describeJob(finished)).toContain("<its agents>\napp 1 coding agent · 3 turns");
  });

  it("is what /watch shows, whole: the harness's stages, every prompt, reply, thought and tool call, unclipped, and how it ended", async () => {
    const jobs = createJobRegistry();
    const longResult = `${"x".repeat(5000)}\nFAILED test_app.py`;
    const job = jobs.start({
      kind: "regenerate",
      summary: "app.plain render spec diff",
      diff: "+- Say hello.",
      model: "anthropic/claude-sonnet-5",
      lanes: ["render-queue:abc", lane],
      run: async () => {
        reportStage("app: turri is implementing the spec change");
        reportTranscript({ kind: "prompt", text: "Make the code match the spec change." });
        reportTranscript({ kind: "thinking", text: "The spec wants " });
        reportTranscript({ kind: "thinking", text: "hello." });
        reportTranscript({ kind: "tool", text: "run_unit_tests {}", full: "run_unit_tests {}" });
        reportTranscript({ kind: "result", text: "clipped…", full: longResult, error: true });
        reportTranscript({ kind: "text", text: "Fixed " });
        reportTranscript({ kind: "text", text: "it." });
        return { report: "Rendered the spec change." };
      },
    });
    await jobs.wait(job.id);

    const dir = join(root, ".turri", "jobs");
    const [file] = readdirSync(dir);
    expect(file).toMatch(new RegExp(`-${job.id}-regenerate\\.log$`));
    const text = readFileSync(join(dir, file!), "utf8");
    expect(text).toContain(`turri job ${job.id} · regenerate · app.plain render spec diff`);
    expect(text).toContain("── the spec change\n+- Say hello.");
    expect(text).toMatch(/\] ── app: turri is implementing the spec change\n/);
    expect(text).toMatch(/\] harness ▸\nMake the code match the spec change\.\n/);
    expect(text).toMatch(/\] thinking ▸\nThe spec wants hello\./);
    expect(text).toMatch(/\] ⚙ run_unit_tests \{\}\n/);
    // Whole, where the screen keeps a clip.
    expect(text).toContain(`    ${"x".repeat(5000)}\n    FAILED test_app.py\n`);
    expect(text).toMatch(/\] agent ▸\nFixed it\./);
    expect(text).toMatch(/\] ── finished\nRendered the spec change\.\n$/);
    // The screen's transcript keeps the clip, and not the whole.
    expect(jobs.get(job.id)!.transcript.find((entry) => entry.kind === "result")).toEqual({ kind: "result", text: "clipped…", error: true });
  });

  it("is not written for a job that writes no module", async () => {
    const jobs = createJobRegistry();
    const job = jobs.start({ kind: "render", summary: "x", run: async () => ({ report: "" }) });
    await jobs.wait(job.id);
    expect(() => readdirSync(join(root, ".turri", "jobs"))).toThrow();
  });
});
