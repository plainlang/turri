import { describe, expect, it } from "vitest";
import type { Job } from "../../src/render/jobs.ts";
import { createJobsTreeState, jobsTreeLines, jobsTreeRows, keepCursorInView, scrollTree, treeKey } from "../../src/render/jobs-tree.ts";

const PLAIN = { heading: (t: string) => t, muted: (t: string) => t, accent: (t: string) => t, error: (t: string) => t, added: (t: string) => t, removed: (t: string) => t };

let sequence = 0;
function job(id: string, status: Job["status"], extra: Partial<Job> = {}): Job {
  sequence += 1;
  return {
    id,
    kind: "render_spec_diff",
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
const rowsOf = (jobs: Job[], state = createJobsTreeState()) => jobsTreeRows(jobs, state).map((row) => (row.kind === "section" ? `[${row.section} ${row.count}]` : row.job.id));

describe("the jobs tree", () => {
  it("lists running, queued and finished, running and queued open and finished closed - finished newest first", () => {
    const jobs = [job("a", "succeeded", { finishedAt: 1 }), job("b", "running"), job("c", "queued"), job("d", "failed", { finishedAt: 2 })];
    expect(rowsOf(jobs)).toEqual(["[running 1]", "b", "[queued 1]", "c", "[finished 2]"]);
    const state = createJobsTreeState();
    state.open.finished = true;
    expect(rowsOf(jobs, state)).toEqual(["[running 1]", "b", "[queued 1]", "c", "[finished 2]", "d", "a"]);
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

  it("shows a job in a line - what it changes - and all of its diff once opened", () => {
    const jobs = [job("c", "queued", { diff: diff("Users give kudos."), waitingOn: ["b"] })];
    const state = createJobsTreeState();
    const closed = jobsTreeLines(jobs, state, 120, PLAIN).lines.join("\n");
    expect(closed).toMatch(/▸ · app\.plain c · .*app\.plain/);
    expect(closed).not.toContain("+- Users give kudos.");
    state.cursor = 2; // [running], [queued], c
    treeKey(state, jobsTreeRows(jobs, state), "open");
    const open = jobsTreeLines(jobs, state, 120, PLAIN).lines.join("\n");
    expect(open).toContain("▾ · app.plain c");
    expect(open).toContain("+- Users give kudos.");
    expect(open).toContain("waits for job b");
  });

  it("shows a running job's stage under it, and - opened - what it is doing", () => {
    const jobs = [job("b", "running", { stage: "running the unit testing script", activity: ["▶ unit tests: the project's script"] })];
    const state = createJobsTreeState();
    expect(jobsTreeLines(jobs, state, 120, PLAIN).lines).toContain("        running the unit testing script");
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
    expect(lines).toContain("▸ ▶ app.plain c");
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

  it("goes from a closed job to its section with ←, opens or closes a whole section's jobs, and names a job's trace", () => {
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
    state.cursor = 2;
    expect(treeKey(state, rows, "trace")).toEqual({ kind: "trace", jobId: "c" });
    state.cursor = 1;
    expect(treeKey(state, rows, "trace")).toEqual({ kind: "none" });
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
    // A page down: still in c's diff, the cursor stays on c.
    scrollTree(state, 9, rowStarts, lines.length, 10);
    expect(state.top).toBe(9);
    expect(state.cursor).toBe(2);
    // Drawn again, it stays where it was scrolled to: a line of c is in sight.
    keepCursorInView(state, rowStarts, lines.length, 10);
    expect(state.top).toBe(9);
    // Down to f: the view follows it.
    state.cursor = 3;
    keepCursorInView(state, rowStarts, lines.length, 10);
    expect(state.top).toBe(rowStarts[3]! - 9);
  });
});
