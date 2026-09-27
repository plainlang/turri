import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reportStage, reportTranscript } from "../../src/render/activity.ts";
import { createJobRegistry } from "../../src/render/jobs.ts";

let root: string;
let lane: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plainwright-job-log-"));
  lane = join(root, "plain_modules", "app");
  mkdirSync(lane, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("a job's log", () => {
  it("is what /watch shows, whole: the harness's stages, every prompt, reply, thought and tool call, unclipped, and how it ended", async () => {
    const jobs = createJobRegistry();
    const longResult = `${"x".repeat(5000)}\nFAILED test_app.py`;
    const job = jobs.start({
      kind: "render_spec_diff",
      summary: "app.plain render spec diff",
      diff: "+- Say hello.",
      model: "anthropic/claude-sonnet-5",
      lanes: ["render-queue:abc", lane],
      run: async () => {
        reportStage("app: plainwright is implementing the spec change");
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

    const dir = join(root, ".plainwright", "jobs");
    const [file] = readdirSync(dir);
    expect(file).toMatch(new RegExp(`-${job.id}-render_spec_diff\\.log$`));
    const text = readFileSync(join(dir, file!), "utf8");
    expect(text).toContain(`plainwright job ${job.id} · render_spec_diff · app.plain render spec diff`);
    expect(text).toContain("── the spec change\n+- Say hello.");
    expect(text).toMatch(/\] ── app: plainwright is implementing the spec change\n/);
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
    expect(() => readdirSync(join(root, ".plainwright", "jobs"))).toThrow();
  });
});
