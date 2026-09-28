import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectFindings, createTemperTools, noteStamp } from "../src/temper-tools.ts";
import { createJobRegistry } from "../src/render/jobs.ts";
import { createRenderQueue } from "../src/render/queue.ts";
import { recordNote, NOTES_FILE } from "../src/render/notes.ts";
import { writeBuiltTree } from "../src/render/state.ts";
import { plainFileParser } from "../src/plain/parser.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "plainwright-temper-")));
  mkdirSync(join(dir, "plain_modules", "app", "code"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const buildDir = () => join(dir, "plain_modules", "app", "code");
const spec = (fs: string[]) => `***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n${fs.join("\n\n")}\n`;
const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map((part) => part.text ?? "").join("");
const tool = (tools: ReturnType<typeof createTemperTools>, name: string) => tools.find((candidate) => candidate.name === name)!;

describe("what a tempering run reads back", () => {
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
    const queue = createRenderQueue({ registry, cwd: dir, queueMaster: false });
    const tools = createTemperTools({ queue, jobs: registry, cwd: dir, startedAt: new Date(Date.now() - 60_000) });
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

describe("rendering and waiting, from a skill", () => {
  it("queues a module that is not built yet functionality by functionality, and waits for every build to say how it ended", async () => {
    writeFileSync(join(dir, "app.plain"), spec(["- Say hello.", "- Say goodbye."]));
    const registry = createJobRegistry();
    const rendered: string[] = [];
    const queue = createRenderQueue({ registry, cwd: dir, queueMaster: false, run: async (request) => (rendered.push(request.frid), { report: `built ${request.frid}` }) });
    const tools = createTemperTools({ queue, jobs: registry, cwd: dir, startedAt: new Date(Date.now() - 1000) });
    const queued = text(await tool(tools, "render_spec").execute("id", { plain_file: "app.plain" }, undefined, undefined, {} as never));
    expect(queued).toContain("Queued 2 renders of app.plain: functionality 1");
    const waited = text(await tool(tools, "wait_for_jobs").execute("id", { minutes: 1 }, undefined, undefined, {} as never));
    expect(waited).toContain("Every build queued since this run started has finished");
    expect(waited).toMatch(/app\.plain fs 1 · succeeded after \S+ - built 1/);
    expect(rendered).toEqual(["1", "2"]);
  });

  it("queues a spec changed in place as one spec diff - and nothing when the code is built from it already", async () => {
    writeFileSync(join(dir, "app.plain"), spec(["- Say hello."]));
    writeBuiltTree(buildDir(), plainFileParser("app.plain", [dir])[1]);
    writeFileSync(join(buildDir(), "app.py"), "print('hello')\n");
    const registry = createJobRegistry();
    const queue = createRenderQueue({ registry, cwd: dir, queueMaster: false });
    const tools = createTemperTools({ queue, jobs: registry, cwd: dir });
    expect(text(await tool(tools, "render_spec").execute("id", { plain_file: "app.plain" }, undefined, undefined, {} as never))).toContain("nothing to render");
    writeFileSync(join(dir, "app.plain"), spec(["- Say hello, loudly."]));
    const changed = text(await tool(tools, "render_spec").execute("id", { plain_file: "app.plain" }, undefined, undefined, {} as never));
    expect(changed).toMatch(/as one spec diff: job \S+/);
    expect(registry.list()[0]!.diff).toContain("+- Say hello, loudly.");
    registry.stop(registry.list()[0]!.id);
  });
});
