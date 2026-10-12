import { describe, expect, it } from "vitest";
import { describeToolCall, describeToolResult, reportActivity, reportNow, reportStage } from "../../src/grow/activity.ts";
import { createJobRegistry } from "../../src/grow/jobs.ts";
import { jobPanelLines } from "../../src/grow/job-panel.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("what a background job is doing", () => {
  it("lands on the job it was reported from, even with two running at once", async () => {
    const jobs = createJobRegistry();
    const run = (name: string) => async () => {
      reportStage(`${name}: writing code`);
      await tick();
      reportActivity(`✎ write ${name}.py`);
      await tick();
      return { report: "done" };
    };
    const a = jobs.start({ kind: "render", summary: "a", run: run("a") });
    const b = jobs.start({ kind: "render", summary: "b", run: run("b") });
    await Promise.all([jobs.wait(a.id), jobs.wait(b.id)]);

    expect(a.stage).toBe("a: writing code");
    expect(a.activity).toEqual(["✎ write a.py"]);
    expect(b.activity).toEqual(["✎ write b.py"]);
  });

  it("keeps only the most recent activity", async () => {
    const jobs = createJobRegistry();
    const job = jobs.start({
      kind: "render",
      summary: "x",
      run: async () => {
        for (let i = 0; i < 20; i += 1) reportActivity(`line ${i}`);
        return { report: "" };
      },
    });
    await jobs.wait(job.id);
    expect(job.activity).toHaveLength(10);
    expect(job.activity.at(-1)).toBe("line 19");
  });

  it("tells the listener every time something changes", async () => {
    let changes = 0;
    const jobs = createJobRegistry({ onChange: () => (changes += 1) });
    const job = jobs.start({
      kind: "render",
      summary: "x",
      run: async () => {
        reportStage("one");
        reportActivity("two");
        return { report: "" };
      },
    });
    await jobs.wait(job.id);
    expect(changes).toBe(3); // started, stage, activity
  });

  it("is a no-op outside a job", () => {
    expect(() => reportActivity("nobody listening")).not.toThrow();
  });
});

describe("tool calls as one line", () => {
  it("names files written and commands run", () => {
    expect(describeToolCall("write", { path: "src/greeter.py" })).toBe("✎ write src/greeter.py");
    expect(describeToolCall("run_unit_tests", {})).toBe("▶ unit tests: the project's script");
    expect(describeToolCall("something_new", {})).toBe("• something_new");
    // turri's own tools have theirs.
    expect(describeToolCall("update_notes", {})).toBe("✐ update_notes");
    expect(describeToolCall("my_diff", {})).toBe("± my_diff");
    expect(describeToolCall("submit_work", {})).toBe("✓ submit_work");
    expect(describeToolCall("submit_review", {})).toBe("✓ submit_review");
    // Reading, searching and the web have their marks too: no line without one.
    expect(describeToolCall("grep", { pattern: "create_app" })).toBe("⌕ grep create_app");
    expect(describeToolCall("web_search", { query: "sqlite in-memory no such table" })).toBe("⇢ web_search sqlite in-memory no such table");
  });

  it("gives paths as they are inside plain_modules, wherever they appear", () => {
    const root = "/Users/someone/Work/shop/plain_modules";
    expect(describeToolCall("write", { path: `${root}/version/code/src/version.py` })).toBe("✎ write version/code/src/version.py");
    expect(describeToolCall("bash", { command: `cd ${root}/version/code && pytest -q` })).toBe("$ cd version/code && pytest -q");
    expect(describeToolCall("read", { path: `${root}/version/tests/test_version.py` })).toBe("○ read version/tests/test_version.py");
    expect(describeToolCall("edit", { path: "plain_modules/app/code/main.py" })).toBe("✎ edit app/code/main.py");
    // Anything else is left as it is.
    expect(describeToolCall("bash", { command: "ls /tmp/other && cat my_plain_modules/x" })).toBe("$ ls /tmp/other && cat my_plain_modules/x");
  });

  it("reports whether a test run passed", () => {
    expect(describeToolResult("run_unit_tests", { details: { exitCode: 0 } }, false)).toBe("  ✓ passing");
    expect(describeToolResult("run_unit_tests", { details: { exitCode: 1 } }, false)).toBe("  ✗ failing (exit 1)");
    expect(describeToolResult("write", {}, false)).toBeUndefined();
  });

  it("shows a tool by the name the person knows it by, not the one its agent calls", () => {
    expect(describeToolCall("write_spec_diff", { plain_file: "app.plain", diff: "" })).toBe("• mutate");
    expect(describeToolResult("write_spec_diff", {}, true)).toBe("  ✗ mutate failed");
  });
});

describe("the panel", () => {
  it("lists what finished on top, a line a module, each pulse with its mark, number and kind alone - a rule under it - and is gone when nothing runs", async () => {
    const jobs = createJobRegistry();
    const first = jobs.start({ kind: "regenerate", summary: "x", module: "backend", pulse: 1, title: "Registration", run: async () => ({ report: "", details: { passed: true } }) });
    await jobs.wait(first.id);
    const second = jobs.start({ kind: "bind", summary: "y", module: "backend", pulse: 2, title: "fs 1", run: async () => ({ report: "", details: { passed: false } }) });
    await jobs.wait(second.id);
    const other = jobs.start({ kind: "regenerate", summary: "w", module: "web", pulse: 1, title: "home page", run: async () => ({ report: "", details: { passed: true } }) });
    await jobs.wait(other.id);
    // Nothing running: no panel at all.
    expect(jobPanelLines(jobs.list())).toEqual([]);
    jobs.start({ kind: "regenerate", summary: "z", module: "backend", pulse: 3, title: "Log in with :User:", run: () => new Promise(() => {}) });
    const marks = { success: (t: string) => `<ok>${t}`, error: (t: string) => `<bad>${t}`, warning: (t: string) => `<stop>${t}` };
    const lines = jobPanelLines(jobs.list(), { marks, width: 80 });
    // What a pulse grows is said all lowercase.
    expect(lines[0]).toBe("  backend  <ok>✓ 1 regenerate · <bad>✗ 2 bind");
    expect(lines[1]).toBe("  web      <ok>✓ 1 regenerate");
    expect(lines[2]).toBe(`  ${"─".repeat(76)}`);
    // What runs is below the rule, by the input: its module, its kind and number, what it grows.
    expect(lines[3]).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] backend · regenerate pulse 3 · log in with :user: · \d+s$/);
    // ctrl+o expands the agents' trace, not what finished: the side panel lists each.
    expect(jobPanelLines(jobs.list(), { expanded: true, marks, width: 80 }).slice(0, 2)).toEqual(lines.slice(0, 2));
  });

  it("fits a module's line to the width with its newest pulses, the rest counted as earlier", async () => {
    const jobs = createJobRegistry();
    for (const [index, title] of ["description", "health check", "registration", "log in", "search"].entries()) {
      const job = jobs.start({ kind: "regenerate", summary: title, module: "cognio", pulse: index + 1, title, run: async () => ({ report: "", details: { passed: true } }) });
      await jobs.wait(job.id);
    }
    jobs.start({ kind: "regenerate", summary: "z", module: "cognio", pulse: 6, title: "profiles", run: () => new Promise(() => {}) });
    const line = jobPanelLines(jobs.list(), { width: 75 })[0]!;
    expect(line).toBe("  cognio  … 2 earlier · ✓ 3 regenerate · ✓ 4 regenerate · ✓ 5 regenerate");
    expect(line.length).toBeLessThanOrEqual(75);
    expect(jobPanelLines(jobs.list())[0]).toBe("  cognio  ✓ 1 regenerate · ✓ 2 regenerate · ✓ 3 regenerate · ✓ 4 regenerate · ✓ 5 regenerate");
  });

  it("shows running jobs by module, time and cost, with their activity and not their stage - and what finished, above them", async () => {
    const jobs = createJobRegistry();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    jobs.start({
      kind: "render",
      summary: "app.plain functionality 3",
      module: "app",
      run: async () => {
        reportStage("app 3: writing code and unit tests");
        reportActivity("✎ write app.py");
        await gate;
        return { report: "" };
      },
    });
    const finished = jobs.start({ kind: "render", summary: "done already", run: async () => ({ report: "" }) });
    await jobs.wait(finished.id);

    const lines = jobPanelLines(jobs.list());
    expect(lines[2]).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] app render · \d+s$/);
    expect(lines.join("\n")).not.toContain("app 3: writing code and unit tests");
    expect(lines).toContain("      ✎ write app.py");
    // What finished is above it, with its mark - a job of no module under its kind.
    expect(lines[0]).toBe("  render  ✓ done already");

    release();
  });

  it("shows what the model is doing right now, and for how long", async () => {
    const jobs = createJobRegistry();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const job = jobs.start({
      kind: "render",
      summary: "app 1",
      run: async () => {
        reportNow("thinking");
        await gate;
        return { report: "" };
      },
    });
    await tick();
    const since = job.now!.since;
    expect(jobPanelLines(jobs.list(), { now: since + 12_400, hints: false }).at(-1)).toBe("      … thinking · 12s");

    release();
    await jobs.wait(job.id);
  });

  it("keeps the clock when only the words change", async () => {
    const jobs = createJobRegistry();
    const job = jobs.start({
      kind: "render",
      summary: "x",
      run: async () => {
        reportNow("preparing a tool call");
        const first = job.now!.since;
        await tick();
        reportNow("writing write call · 4.2k chars", { keepSince: true });
        expect(job.now!.since).toBe(first);
        reportNow(undefined);
        return { report: "" };
      },
    });
    await jobs.wait(job.id);
    expect(job.now).toBeUndefined();
  });

  it("shows the last two actions while compact, and all of them expanded", async () => {
    const jobs = createJobRegistry();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const job = jobs.start({
      kind: "render",
      summary: "x",
      run: async () => {
        for (const n of [1, 2, 3, 4]) reportActivity(`step ${n}`);
        await gate;
        return { report: "" };
      },
    });
    await tick();
    const compact = jobPanelLines(jobs.list());
    expect(compact).not.toContain("      step 2");
    expect(compact).toContain("      step 4");
    expect(jobPanelLines(jobs.list(), { expanded: true })).toContain("      step 1");
    release();
    await jobs.wait(job.id);
  });

  it("is empty when nothing is running", () => {
    expect(jobPanelLines([])).toEqual([]);
  });
});
