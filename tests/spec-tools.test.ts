import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { plainFileParser } from "../src/plain/parser.ts";
import { createJobRegistry } from "../src/render/jobs.ts";
import { createRenderQueue, type RenderRequest } from "../src/render/queue.ts";
import { resolveTemplateDirs } from "../src/render/render.ts";
import { recordFunctionality, specStateFor } from "../src/render/state.ts";
import { createFunctionalSpecTools } from "../src/spec-tools.ts";

const START = [
  "***definitions***",
  "",
  "- :User: is a person.",
  "",
  "***implementation reqs***",
  "",
  "- Python.",
  "",
  "***functional specs***",
  "",
  "- Health check.",
  "",
].join("\n");

let dir: string;
let file: string;
let build: string;
let requests: RenderRequest[];

function setup() {
  const registry = createJobRegistry();
  const queue = createRenderQueue({
    registry,
    cwd: dir,
    buildDir: build,
    run: async (request) => {
      requests.push(request);
      return { report: "" };
    },
  });
  const { tools, pace } = createFunctionalSpecTools({ queue, cwd: dir });
  const byName = (name: string) => tools.find((tool) => tool.name === name)!;
  const call = (name: string, params: unknown) =>
    byName(name).execute("id", params as never, undefined, undefined, {} as never);
  return { queue, registry, pace, call };
}

function built(frid: string) {
  const [moduleName, tree] = plainFileParser(basename(file), resolveTemplateDirs(file));
  recordFunctionality(build, moduleName, { frid, ...specStateFor(tree, frid), unitTests: "passed" });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plainwright-spec-tools-"));
  file = join(dir, "app.plain");
  build = join(dir, "plain_modules", "app", "code");
  writeFileSync(file, START);
  requests = [];
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("write_functional_spec", () => {
  it("writes the spec and queues its build in the same call", async () => {
    const { call, queue } = setup();
    const result = await call("write_functional_spec", { plain_file: "app.plain", spec: "- A :User: can register." });

    expect(readFileSync(file, "utf8")).toContain("- Health check.\n\n- A :User: can register.\n");
    expect(result.details.frid).toBe("2");
    await queue.drain();
    expect(requests.map((r) => r.frid)).toEqual(["2"]);
  });

  it("needs an answer before the next new spec, but not before an edit", async () => {
    const { call, pace } = setup();
    await call("write_functional_spec", { plain_file: "app.plain", spec: "- Two." });

    await expect(call("write_functional_spec", { plain_file: "app.plain", spec: "- Three." })).rejects.toThrow(
      /No question has been answered/,
    );
    await expect(
      call("write_functional_spec", { plain_file: "app.plain", spec: "- Two, fixed.", replaces: "2" }),
    ).resolves.toBeDefined();

    pace.answered();
    const third = await call("write_functional_spec", { plain_file: "app.plain", spec: "- Three." });
    expect(third.details.frid).toBe("3");
  });

  it("rebuilds what an edit made out of date", async () => {
    const { call, queue } = setup();
    built("1");
    await call("write_functional_spec", { plain_file: "app.plain", spec: "- Health check, now JSON.", replaces: "1" });
    await queue.drain();
    expect(requests).toEqual([expect.objectContaining({ frid: "1", regenerate: true })]);
  });

  it("rebuilds only the spec that changed, not the ones built after it", async () => {
    const { call, queue, pace } = setup();
    for (const spec of ["- Two.", "- Three.", "- Four."]) {
      pace.answered();
      await call("write_functional_spec", { plain_file: "app.plain", spec });
    }
    await queue.drain();
    for (const frid of ["1", "2", "3", "4"]) built(frid);
    requests = [];

    await call("write_functional_spec", { plain_file: "app.plain", spec: "- Two, changed.", replaces: "2" });
    await queue.drain();
    expect(requests).toEqual([expect.objectContaining({ frid: "2", regenerate: true })]);
  });

  it("does not queue the same functionality twice", async () => {
    const { call, queue } = setup();
    await call("write_functional_spec", { plain_file: "app.plain", spec: "- Two." });
    await call("write_functional_spec", { plain_file: "app.plain", spec: "- Two, fixed.", replaces: "2" });
    await queue.drain();
    expect(requests.map((r) => r.frid)).toEqual(["2"]);
  });

  it("writes nothing and queues nothing when the spec is not one spec", async () => {
    const { call } = setup();
    await expect(call("write_functional_spec", { plain_file: "app.plain", spec: "- One.\n- Two." })).rejects.toThrow(
      /Nothing was written/,
    );
    expect(readFileSync(file, "utf8")).toBe(START);
    expect(requests).toEqual([]);
  });

  it("puts the file back when the spec would stop it parsing", async () => {
    const { call } = setup();
    await expect(
      call("write_functional_spec", { plain_file: "app.plain", spec: "- Uses :Undefined: here." }),
    ).rejects.toThrow(/no longer parses/);
    expect(readFileSync(file, "utf8")).toBe(START);
  });
});

describe("the file tools beside it", () => {
  it("refuse to change the functional specs", async () => {
    const { call } = setup();
    await expect(
      call("edit", { path: "app.plain", edits: [{ oldText: "- Health check.", newText: "- Health." }] }),
    ).rejects.toThrow(/only write_functional_spec may do/);
    await expect(call("write", { path: "app.plain", content: `${START}- Sneaky.\n` })).rejects.toThrow(
      /only write_functional_spec/,
    );
    expect(readFileSync(file, "utf8")).toBe(START);
  });

  it("still edit the rest of a .plain file, and any other file", async () => {
    const { call } = setup();
    await call("edit", { path: "app.plain", edits: [{ oldText: ":User: is a person.", newText: ":User: is a student." }] });
    expect(readFileSync(file, "utf8")).toContain(":User: is a student.");
    await call("write", { path: "notes.md", content: "- Anything.\n" });
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("- Anything.\n");
  });
});
