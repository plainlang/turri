import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What each spec diff rendered: a spec diff that lands records the spec it was given, as the real one does. */
const diffs: string[] = [];
vi.mock("../src/grow/regenerate.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/grow/regenerate.ts")>();
  return {
    ...actual,
    renderSpecDiff: async (options: { diff?: string; spec?: { tree: object; chain?: Array<{ buildDir: string }> } }) => {
      diffs.push(options.diff ?? "");
      const buildDir = options.spec!.chain!.at(-1)!.buildDir;
      writeFileSync(join(buildDir, "app.py"), "# built\n", { flag: "a" });
      (await import("../src/grow/records.ts")).writeCodeRecord(buildDir, options.spec!.tree as never);
      return { passed: true, stoppedAt: null };
    },
    describeSpecDiff: () => "rendered",
  };
});

const { collectFindings, createMatureTools, noteStamp } = await import("../src/mature-tools.ts");
const { driftTool, haltTool, regenerateTool } = await import("../src/loop-tools.ts");
const { createJobRegistry } = await import("../src/grow/jobs.ts");
const { createWorkLoop } = await import("../src/grow/loop.ts");
const { recordNote, NOTES_FILE } = await import("../src/grow/notes.ts");
const { writeCodeRecord } = await import("../src/grow/records.ts");
const { plainFileParser } = await import("../src/plain/parser.ts");

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "turri-mature-")));
  mkdirSync(join(dir, "plain_modules", "app", "code"), { recursive: true });
  diffs.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const buildDir = () => join(dir, "plain_modules", "app", "code");
const spec = (fs: string[]) => `***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n${fs.join("\n\n")}\n`;
const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map((part) => part.text ?? "").join("");
const tool = (tools: ReturnType<typeof createMatureTools>, name: string) => tools.find((candidate) => candidate.name === name)!;
/** A tool called as a skill calls it. */
const call = async (given: { execute: Function }, params: object) => text(await given.execute("id", params, undefined, undefined, {} as never));

describe("what a maturing run reads back", () => {
  it("is every assumption and pitfall recorded since it started, a failed job's diagnosis and a spec conflict - nothing from before", () => {
    const start = new Date(Date.now() - 60_000);
    const before = noteStamp(new Date(start.getTime() - 3_600_000));
    writeFileSync(
      join(buildDir(), NOTES_FILE),
      `# Working notes\n\n## Assumptions\n\n- [${before} · app 1] An old assumption, from before the run\n\n## Pitfalls\n\n(nothing yet)\n`,
    );
    recordNote(buildDir(), "assumptions", "Emails are compared case-insensitively", "app 2");
    recordNote(buildDir(), "pitfalls", "The spec does not say what a duplicate email returns - chose 409", "app 2");
    const registry = createJobRegistry();
    const failed = registry.start({ kind: "render", summary: "app.plain fs 3", run: async () => ({ report: "" }) });
    const job = registry.get(failed.id)!;
    job.diagnosis = "What happened: the spec gives no status for a missing user.\nTo fix - in the spec: say it is 404.";
    job.specConflict = {
      moduleName: "app",
      plainFile: join(dir, "app.plain"),
      specs: [
        { module: "app", frid: "2", plainFile: join(dir, "app.plain"), text: "- Users sign up with an email." },
        { module: "app", frid: "4", plainFile: join(dir, "app.plain"), text: "- Users sign up with a phone number only." },
      ],
      reasons: ["2 needs an email, 4 forbids one"],
    };

    const found = collectFindings({ project: dir, jobs: registry.list(), since: start });
    expect(found.map((finding) => finding.kind).sort()).toEqual(["assumption", "conflict", "diagnosis", "pitfall"]);
    expect(found.find((finding) => finding.kind === "assumption")).toMatchObject({ where: "app (app 2)", text: "Emails are compared case-insensitively" });
    expect(found.find((finding) => finding.kind === "conflict")!.text).toContain("app 4: - Users sign up with a phone number only.");
    expect(found.some((finding) => finding.text.includes("old assumption"))).toBe(false);
  });

  it("hands each finding out once, numbered - and all of them again when asked", async () => {
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false });
    const tools = createMatureTools({ jobs: registry, cwd: dir, startedAt: new Date(Date.now() - 60_000) });
    recordNote(buildDir(), "assumptions", "Titles are trimmed before they are stored", "app 1");
    const first = text(await tool(tools, "spec_findings").execute("id", {}, undefined, undefined, {} as never));
    expect(first).toContain("f1 · assumption · app (app 1)");
    expect(text(await tool(tools, "spec_findings").execute("id", {}, undefined, undefined, {} as never))).toContain("No new findings");
    recordNote(buildDir(), "assumptions", "An empty title is refused with 400", "app 2");
    const next = text(await tool(tools, "spec_findings").execute("id", {}, undefined, undefined, {} as never));
    expect(next).toContain("f2 · assumption");
    expect(next).not.toContain("Titles are trimmed");
    expect(text(await tool(tools, "spec_findings").execute("id", { all: true }, undefined, undefined, {} as never))).toContain("Titles are trimmed");
  });
});

describe("growing and waiting, from a skill - with the conversation's own regenerate, drift and halt", () => {
  it("grows a module that is not grown yet as it is planned - a pulse a functional spec here - and waits for every pulse to say how it ended", async () => {
    writeFileSync(join(dir, "app.plain"), spec(["- Say hello.", "- Say goodbye."]));
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false });
    const tools = createMatureTools({ jobs: registry, cwd: dir, startedAt: new Date(Date.now() - 1000) });
    const queued = await call(regenerateTool({ cwd: dir, jobs: registry, loop: () => loop }), { plain_file: "app.plain" });
    expect(queued).toMatch(/running: pulse \w+ - Say hello\./);
    expect(queued).toContain("1. Say goodbye. - adds fs 2");
    await loop.drain();
    const waited = text(await tool(tools, "watch_jobs").execute("id", { minutes: 1 }, undefined, undefined, {} as never));
    expect(waited).toContain("Every build queued since this run started has finished");
    expect(waited).toMatch(/app\.plain Say hello\. · succeeded after/);
    expect(diffs).toHaveLength(2);
    expect(diffs[0]).toContain("+- Say hello.");
    expect(diffs[1]).toContain("+- Say goodbye.");
  });

  it("grows a spec changed in place - and nothing when the code is grown from it already", async () => {
    writeFileSync(join(dir, "app.plain"), spec(["- Say hello."]));
    writeCodeRecord(buildDir(), plainFileParser("app.plain", [dir])[1]);
    writeFileSync(join(buildDir(), "app.py"), "print('hello')\n");
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false });
    const regenerate = regenerateTool({ cwd: dir, jobs: registry, loop: () => loop });
    expect(await call(regenerate, { plain_file: "app.plain" })).toContain("built from the spec as it is");
    writeFileSync(join(dir, "app.plain"), spec(["- Say hello, loudly."]));
    const changed = await call(regenerate, { plain_file: "app.plain" });
    expect(changed).toContain("running: pulse");
    expect(registry.list()[0]!.diff).toContain("+- Say hello, loudly.");
    registry.stop(registry.list()[0]!.id);
  });
});

describe("watching the builds, for a run that goes on until the spec is built", () => {
  it("tells a build that struggles - sent back again and again, setbacks, a conflict, a retry, far too long - from one that goes well", async () => {
    const { struggling, LONG_BUILD_MS } = await import("../src/mature-tools.ts");
    const job = (stage: string | undefined, stages: string[], startedAt = Date.now()) =>
      ({ status: "running", stage, startedAt, transcript: stages.map((text) => ({ kind: "stage", text })) }) as never;
    expect(struggling(job("app 2: running the unit testing script (attempt 1)", ["app 2: turri is writing the code"]))).toBeUndefined();
    expect(struggling(job("app 2: unit tests not passing - fixing (round 5 of 20)", []))?.why).toContain("sent back 5 times of at most 20");
    expect(struggling(job(undefined, Array.from({ length: 5 }, (_, i) => `app 2: unit tests not passing - fixing (round ${i + 1} of 20)`)))?.why).toContain("5 setbacks");
    expect(struggling(job(undefined, ["a spec conflict between functionalities app 2 and app 4 is recorded (1 of 3)"]))?.key).toBe("conflict");
    expect(struggling(job(undefined, ["the job failed - trying it once more (1 of 1)"]))?.key).toBe("retry");
    expect(struggling(job(undefined, [], Date.now() - LONG_BUILD_MS - 1000))?.why).toContain("running for");
  });

  it("comes back as soon as a build struggles - with what it went through - and says each struggle once", async () => {
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false });
    const tools = createMatureTools({ jobs: registry, cwd: dir, startedAt: new Date(Date.now() - 1000) });
    let release!: () => void;
    const started = registry.start({
      kind: "render",
      summary: "app.plain fs 2",
      run: async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return { report: "built" };
      },
    });
    const job = registry.get(started.id)!;
    job.stage = "app 2: unit tests not passing - fixing (round 6 of 20)";
    job.transcript.push({ kind: "stage", text: "app 2: unit tests not passing - fixing (round 6 of 20)" });
    job.tail = "AssertionError: expected 400, got 422 - the spec does not say which";

    const first = text(await tool(tools, "watch_jobs").execute("id", { minutes: 1 }, undefined, undefined, {} as never));
    expect(first).toContain("1 build is struggling:");
    expect(first).toContain("sent back 6 times of at most 20");
    expect(first).toContain("expected 400, got 422");

    // Said once: watching again waits for the build to end instead.
    setTimeout(() => release(), 50);
    const next = text(await tool(tools, "watch_jobs").execute("id", { minutes: 1 }, undefined, undefined, {} as never));
    expect(next).toContain("Every build queued since this run started has finished");
  });

  it("halts a struggling pulse, keeping why - so it grows again from the clarified spec", async () => {
    const registry = createJobRegistry();
    const started = registry.start({ kind: "regenerate", summary: "app.plain fs 2", run: async () => (await new Promise((resolve) => setTimeout(resolve, 30)), { report: "" }) });
    const said = await call(haltTool({ jobs: registry }), { job_id: started.id, reason: "the spec now says a duplicate email is refused with 409" });
    expect(said).toContain(`app.plain fs 2 (${started.id})`);
    await registry.wait(started.id).catch(() => undefined);
    expect(registry.get(started.id)!.status).toBe("stopped");
    expect(registry.get(started.id)!.note).toContain("a duplicate email is refused with 409");
  });

  it("knows the goal from drift: fully grown - the code grown from the spec as it stands, and nothing growing", async () => {
    writeFileSync(join(dir, "app.plain"), spec(["- Say hello.", "- Say goodbye."]));
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false });
    const drift = driftTool({ cwd: dir, loop: () => loop });
    expect(await call(drift, { plain_file: "app.plain" })).not.toContain("Fully grown");
    const tree = plainFileParser("app.plain", [dir])[1];
    const specs = tree["functional specs"] as unknown[];
    writeCodeRecord(buildDir(), { ...tree, "functional specs": specs.slice(0, 1) } as never);
    writeFileSync(join(buildDir(), "app.py"), "print('hi')\n");
    const half = await call(drift, { plain_file: "app.plain" });
    expect(half).toContain("adds fs 2");
    expect(half).not.toContain("Fully grown");
    writeCodeRecord(buildDir(), tree);
    expect(await call(drift, { plain_file: "app.plain" })).toContain("Fully grown: every codebase is grown from the spec as it is");
  });
});
