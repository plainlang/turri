import { describe, expect, it } from "vitest";
import type { Job } from "../../src/grow/jobs.ts";
import { createJobsTreeState, jobsTreeLines, jobsTreeRows, keepCursorInView, scrollTree, selectJob, treeKey } from "../../src/grow/jobs-tree.ts";

const PLAIN = { heading: (t: string) => t, muted: (t: string) => t, accent: (t: string) => t, error: (t: string) => t, added: (t: string) => t, removed: (t: string) => t };

let sequence = 0;
function job(id: string, status: Job["status"], extra: Partial<Job> = {}): Job {
  sequence += 1;
  return {
    id,
    kind: "regenerate",
    summary: `app.plain ${id}`,
    status,
    sequence,
    queuedAt: 0,
    startedAt: 0,
    waitingOn: [],
    tail: "",
    activity: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    agents: [],
    transcript: [],
    ...extra,
  } as Job;
}

const diff = (line: string) => `--- a/app.plain\n+++ b/app.plain\n@@ -1 +1,2 @@\n+- ${line}\n`;
const rowsOf = (jobs: Job[], state = createJobsTreeState()) => jobsTreeRows(jobs, state).map((row) => (row.kind === "section" ? `[${row.section} ${row.count}]` : row.kind === "file" ? `${row.job.id}/${row.file}` : row.job.id));

describe("the jobs tree", () => {
  it("lists running, queued and finished, running and queued open and finished closed - finished newest first", () => {
    const jobs = [job("a", "succeeded", { finishedAt: 1 }), job("b", "running"), job("c", "queued"), job("d", "failed", { finishedAt: 2 })];
    expect(rowsOf(jobs)).toEqual(["[running 1]", "b", "[queued 1]", "c", "[finished 2]"]);
    const state = createJobsTreeState();
    state.open.finished = true;
    expect(rowsOf(jobs, state)).toEqual(["[running 1]", "b", "[queued 1]", "c", "[finished 2]", "d", "a"]);
  });

  it("is put on a pulse that went wrong - its section opened, the pulse opened, the cursor on it - for ctrl+h to open on", () => {
    const jobs = [job("a", "succeeded", { finishedAt: 1 }), job("b", "running"), job("d", "failed", { finishedAt: 2 })];
    const state = createJobsTreeState();
    expect(state.open.finished).toBe(false);
    expect(selectJob(jobs, state, "d")).toBe(true);
    expect(state.open.finished).toBe(true);
    expect(state.openJobs.get("d")).toBe("finished");
    const row = jobsTreeRows(jobs, state)[state.cursor]!;
    expect(row.kind !== "section" && row.job.id).toBe("d");
    expect(selectJob(jobs, state, "gone")).toBe(false);
  });

  it("opens and closes each section on its own", () => {
    const jobs = [job("b", "running"), job("c", "queued")];
    const state = createJobsTreeState();
    let rows = jobsTreeRows(jobs, state);
    state.cursor = 2; // [queued]
    treeKey(state, rows, "toggle");
    expect(rowsOf(jobs, state)).toEqual(["[running 1]", "b", "[queued 1]", "[finished 0]"]);
    rows = jobsTreeRows(jobs, state);
    state.cursor = 0;
    treeKey(state, rows, "close");
    expect(rowsOf(jobs, state)).toEqual(["[running 1]", "[queued 1]", "[finished 0]"]);
  });

  it("names a pulse by its module, kind and number alone - what it grows is in it, opened", () => {
    const jobs = [job("a", "succeeded", { finishedAt: 1, module: "d365_http_client", kind: "regenerate", pulse: 1, title: "Implement HttpClient" })];
    const state = createJobsTreeState();
    state.open.finished = true;
    const lines = jobsTreeLines(jobs, state, 120, PLAIN).lines.join("\n");
    expect(lines).toContain("✓ d365_http_client · regenerate pulse 1 · ");
    expect(lines).not.toContain("HttpClient");
  });

  it("shows a job in a line - its module, time and cost - and all of its diff once opened", () => {
    const usage = { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.5 };
    const jobs = [job("c", "queued", { module: "app", diff: diff("Users give kudos."), waitingOn: ["b"], usage })];
    const state = createJobsTreeState();
    const closed = jobsTreeLines(jobs, state, 120, PLAIN).lines.join("\n");
    expect(closed).toMatch(/▸ · app regenerate · .+ · \$0\.50$/m);
    expect(closed).not.toContain("app.plain");
    expect(closed).not.toContain("+ - Users give kudos.");
    state.cursor = 2; // [running], [queued], c
    treeKey(state, jobsTreeRows(jobs, state), "open");
    const open = jobsTreeLines(jobs, state, 120, PLAIN).lines.join("\n");
    expect(open).toMatch(/▾ · app regenerate · /);
    expect(open).not.toContain("app.plain c");
    expect(open).toContain("+ - Users give kudos.");
    expect(open).toContain("waits for pulse b");
  });

  it("shows a running job as its line alone, and - opened - what it is doing", () => {
    const jobs = [job("b", "running", { stage: "running the unit testing script", activity: ["▶ unit tests: the project's script"] })];
    const state = createJobsTreeState();
    expect(jobsTreeLines(jobs, state, 120, PLAIN).lines.join("\n")).not.toContain("running the unit testing script");
    state.cursor = 1;
    treeKey(state, jobsTreeRows(jobs, state), "toggle");
    expect(jobsTreeLines(jobs, state, 120, PLAIN).lines.join("\n")).toContain("▶ unit tests: the project's script");
  });

  it("keeps the cursor on its row when the job under it moves on - the next one takes the row", () => {
    const first = job("b", "running");
    const jobs = [first, job("e", "running"), job("c", "queued")];
    const state = createJobsTreeState();
    state.cursor = 1; // b
    jobsTreeLines(jobs, state, 120, PLAIN);
    first.status = "succeeded";
    first.finishedAt = 5;
    const rows = jobsTreeRows(jobs, state);
    expect(state.cursor).toBe(1);
    expect(rows[1]).toMatchObject({ kind: "job", job: { id: "e" } });
  });

  it("closes a job opened in one section when it moves to another", () => {
    const moving = job("c", "queued", { diff: diff("Users give kudos.") });
    const jobs = [moving];
    const state = createJobsTreeState();
    state.open.finished = true;
    state.cursor = 2; // [running], [queued], c
    treeKey(state, jobsTreeRows(jobs, state), "open");
    expect(state.openJobs.has("c")).toBe(true);
    moving.status = "running";
    const lines = jobsTreeLines(jobs, state, 120, PLAIN).lines.join("\n");
    // Running is a spinner, never a play mark beside the arrow that opens it.
    expect(lines).toMatch(/▸ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] app\.plain c/);
    expect(lines).not.toContain("▶ app.plain");
    expect(lines).not.toContain("+- Users give kudos.");
    expect(state.openJobs.has("c")).toBe(false);
  });

  it("clamps the cursor to the last row when rows go", () => {
    const jobs = [job("b", "running"), job("e", "running")];
    const state = createJobsTreeState();
    state.cursor = 99;
    jobsTreeLines(jobs, state, 120, PLAIN);
    expect(state.cursor).toBe(jobsTreeRows(jobs, state).length - 1);
  });

  it("goes from a closed job to its section with ←, opens or closes a whole section's jobs", () => {
    const jobs = [job("c", "queued"), job("f", "queued")];
    const state = createJobsTreeState();
    const rows = jobsTreeRows(jobs, state);
    state.cursor = 3; // [running], [queued], c, f
    treeKey(state, rows, "close");
    expect(state.cursor).toBe(1);
    treeKey(state, rows, "openAll");
    expect([...state.openJobs.keys()].sort()).toEqual(["c", "f"]);
    treeKey(state, rows, "closeAll");
    expect(state.openJobs.size).toBe(0);
  });

  it("scrolls only to keep the cursor in sight, and lets a long open job be read a page at a time", () => {
    const long = Array.from({ length: 60 }, (_, n) => `+- line ${n}`).join("\n");
    const jobs = [job("c", "queued", { diff: `--- a/app.plain\n+++ b/app.plain\n@@ -1 +1,60 @@\n${long}\n` }), job("f", "queued")];
    const state = createJobsTreeState();
    state.cursor = 2; // c
    treeKey(state, jobsTreeRows(jobs, state), "open");
    const { lines, rowStarts } = jobsTreeLines(jobs, state, 120, PLAIN);
    keepCursorInView(state, rowStarts, lines.length, 10);
    expect(state.top).toBe(0);
    // c's diff is under the row of its file, open as the file being rendered.
    const rows = jobsTreeRows(jobs, state);
    expect(rows[3]).toMatchObject({ kind: "file", file: "app.plain" });
    // A page down: in the file's lines now - the cursor on the file, its row still in sight.
    scrollTree(state, 9, rowStarts, lines.length, 10);
    expect(state.top).toBe(9);
    expect(state.cursor).toBe(3);
    // Drawn again, it stays where it was scrolled to: a line of the file is in sight.
    keepCursorInView(state, rowStarts, lines.length, 10);
    expect(state.top).toBe(9);
    // Down to f: the view follows it.
    state.cursor = 4;
    keepCursorInView(state, rowStarts, lines.length, 10);
    expect(state.top).toBe(rowStarts[4]! - 9);
  });

  describe("a job's files", () => {
    // A diff of hubspot.plain, with what it reads from two templates laid in.
    const spread = [
      "--- a/hubspot.plain",
      "+++ b/hubspot.plain",
      "@@ -1,4 +1,6 @@",
      "+- :Provider: is a CRM.",
      "+- :HubSpotClient: reads contacts.",
      "+- :ConformanceTest: runs live.",
      "+- :Mapping: maps a record.",
      "",
    ].join("\n");
    const where = {
      3: { file: "template/crm_common.plain", line: 4 },
      4: { file: "hubspot.plain", line: 9 },
      5: { file: "template/integration_testing.plain", line: 2 },
      6: { file: "template/crm_common.plain", line: 12 },
    };

    it("are rows of their own under the job opened - the file being rendered first and open, the rest by name and closed, each one once", () => {
      const jobs = [job("c", "queued", { summary: "hubspot.plain c", diff: spread, diffWhere: where })];
      const state = createJobsTreeState();
      state.cursor = 2;
      treeKey(state, jobsTreeRows(jobs, state), "open");
      expect(rowsOf(jobs, state)).toEqual(["[running 0]", "[queued 1]", "c", "c/hubspot.plain", "c/template/crm_common.plain", "c/template/integration_testing.plain", "[finished 0]"]);
      const shown = jobsTreeLines(jobs, state, 100, PLAIN).lines.join("\n");
      expect(shown).toContain("▾ hubspot.plain  +1");
      expect(shown).toContain("reads contacts.");
      // crm_common's two places in one row, closed: its lines not shown (its first is in the job's own line, as the change it leads with).
      expect(shown).toContain("▸ template/crm_common.plain  +2");
      expect(shown).not.toContain("maps a record.");
    });

    it("open and close one at a time, all of a job's at once from any of them, and step back to the job from one closed", () => {
      const jobs = [job("c", "queued", { summary: "hubspot.plain c", diff: spread, diffWhere: where })];
      const state = createJobsTreeState();
      state.cursor = 2;
      treeKey(state, jobsTreeRows(jobs, state), "open");
      state.cursor = 4; // crm_common
      treeKey(state, jobsTreeRows(jobs, state), "toggle");
      expect(jobsTreeLines(jobs, state, 100, PLAIN).lines.join("\n")).toContain("maps a record.");
      treeKey(state, jobsTreeRows(jobs, state), "closeAll");
      const closed = jobsTreeLines(jobs, state, 100, PLAIN).lines.join("\n");
      expect(closed).not.toContain("reads contacts.");
      expect(closed).not.toContain("maps a record.");
      treeKey(state, jobsTreeRows(jobs, state), "openAll");
      expect(jobsTreeLines(jobs, state, 100, PLAIN).lines.join("\n")).toContain("runs live.");
      treeKey(state, jobsTreeRows(jobs, state), "close");
      treeKey(state, jobsTreeRows(jobs, state), "close");
      expect(state.cursor).toBe(2);
    });
  });
  it("lists a finished pulse as its module, time and cost alone, marked in the colour of how it ended", () => {
    const style = { ...PLAIN, success: (t: string) => `<ok>${t}`, error: (t: string) => `<bad>${t}` };
    const usage = { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, cost: 1.5 };
    const jobs = [
      job("a", "succeeded", { module: "hubspot", startedAt: 0, finishedAt: 42_000, usage, diff: diff("HubSpotClient reads contacts.") }),
      job("b", "succeeded", { module: "hubspot", kind: "bind", startedAt: 0, finishedAt: 1000, details: { passed: false } }),
      job("c", "failed", { module: "crm", startedAt: 0, finishedAt: 2000 }),
    ];
    const state = createJobsTreeState();
    state.open.finished = true;
    const lines = jobsTreeLines(jobs, state, 200, style).lines.map((line) => line.trim());
    expect(lines).toContain("▸ <ok>✓ hubspot regenerate · 42s · $1.50");
    expect(lines).toContain("▸ <bad>✗ hubspot bind · 1s");
    expect(lines).toContain("▸ <bad>✗ crm regenerate · 2s");
    expect(lines.join("\n")).not.toContain("HubSpotClient");
  });

  it("opens a finished pulse onto its agents and what they spent - not its stages or its report", () => {
    const usage = { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.25 };
    const jobs = [
      job("a", "succeeded", {
        module: "hubspot",
        summary: "hubspot.plain HubSpotClient reading and mapping contacts",
        finishedAt: 1,
        usage,
        report: "Built fs 1 and its unit tests pass.",
        transcript: [
          { kind: "stage", text: "coding fs 1" },
          { kind: "stage", text: "running the unit testing script" },
          { kind: "stage", text: "running the unit testing script" },
          { kind: "text", text: "thinking aloud" },
        ],
        agents: [{ label: "coder", turns: 3, compactions: 0, usage }],
      }),
    ];
    const state = createJobsTreeState();
    state.open.finished = true;
    state.cursor = 3; // [running], [queued], [finished], a
    treeKey(state, jobsTreeRows(jobs, state), "open");
    const open = jobsTreeLines(jobs, state, 200, PLAIN).lines.join("\n");
    expect(open).not.toContain("HubSpotClient reading and mapping contacts");
    expect(open).not.toContain("coding fs 1");
    expect(open).not.toContain("running the unit testing script");
    expect(open).not.toContain("thinking aloud");
    // Its agents by what they did, not their labels: the pulse's line already says which module.
    expect(open).toContain("        3 turns · 1.0k tok · $0.25");
    expect(open).not.toContain("coder");
    expect(open).not.toContain("spent");
    expect(open).not.toContain("Built fs 1 and its unit tests pass.");
    expect(open).not.toContain("trace");
  });
  it("says what a pulse without a module is once - on its line, not again opened", () => {
    const jobs = [job("p", "queued", { summary: "hubspot.plain the work", note: "Being planned into pulses now." })];
    const state = createJobsTreeState();
    state.cursor = 2; // [running], [queued], p
    treeKey(state, jobsTreeRows(jobs, state), "open");
    const open = jobsTreeLines(jobs, state, 120, PLAIN).lines.join("\n");
    expect(open.match(/hubspot\.plain the work/g)).toHaveLength(1);
  });
});
