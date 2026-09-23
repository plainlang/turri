import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { plainFileParser } from "../../src/plain/parser.ts";
import { codebaseMap, diffFiles, digestFiles } from "../../src/render/codebase.ts";
import { buildRenderPrompt } from "../../src/render/prompt.ts";
import { resolveTemplateDirs } from "../../src/render/render.ts";
import { readState, recordFunctionality, specStateFor } from "../../src/render/state.ts";

let dir: string;
let build: string;

function tree() {
  writeFileSync(join(dir, "app.plain"), "***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n- One.\n\n- Two.\n\n- Three.\n");
  return plainFileParser("app.plain", resolveTemplateDirs(join(dir, "app.plain")))[1];
}

function write(file: string, content: string) {
  mkdirSync(join(build, file, ".."), { recursive: true });
  writeFileSync(join(build, file), content);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plainwright-codebase-"));
  build = join(dir, "build");
  mkdirSync(build);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("what a render did to the files", () => {
  it("is told by content: added, changed and removed", () => {
    write("a.py", "a");
    write("b.py", "b");
    const before = digestFiles(build);
    write("b.py", "b, changed");
    write("c.py", "c");
    rmSync(join(build, "a.py"));
    expect(diffFiles(before, digestFiles(build))).toEqual({ added: ["c.py"], changed: ["b.py"], removed: ["a.py"] });
  });

  it("leaves out installed dependencies and caches", () => {
    write("app.py", "x");
    write(".venv/lib/site.py", "x");
    write(".pytest_cache/v", "x");
    expect([...digestFiles(build).keys()]).toEqual(["app.py"]);
  });
});

describe("the codebase map", () => {
  it("is absent when there is no code yet", () => {
    expect(codebaseMap(tree(), build, "1")).toBeNull();
  });

  it("lists the files, where each earlier functionality lives, and the test command", () => {
    const t = tree();
    write("app/main.py", "x");
    write("app/routes.py", "x");
    recordFunctionality(build, "app", {
      frid: "1", ...specStateFor(t, "1"), unitTests: "passed",
      files: { added: ["app/main.py"], changed: [], removed: [] }, testCommand: "pytest -q",
    });
    recordFunctionality(build, "app", {
      frid: "2", ...specStateFor(t, "2"), unitTests: "passed",
      files: { added: ["app/routes.py"], changed: ["app/main.py"], removed: [] }, testCommand: "python -m pytest",
    });

    const map = codebaseMap(t, build, "3")!;
    expect(map).toContain("Files (2):\n  app/main.py\n  app/routes.py");
    expect(map).toContain("  app 1: added app/main.py");
    expect(map).toContain("  app 2: added app/routes.py; changed app/main.py");
    expect(map).toContain("The unit tests last passed with: python -m pytest");
  });

  it("covers only the functionalities before the one being built", () => {
    const t = tree();
    write("app/main.py", "x");
    recordFunctionality(build, "app", { frid: "2", ...specStateFor(t, "2"), unitTests: "passed", files: { added: ["x"], changed: [], removed: [] } });
    expect(codebaseMap(t, build, "2")).not.toContain("app 2:");
  });

  it("leaves the section out when nothing was recorded, and says which were not otherwise", () => {
    const t = tree();
    write("app/main.py", "x");
    recordFunctionality(build, "app", { frid: "1", ...specStateFor(t, "1"), unitTests: "passed" });
    expect(codebaseMap(t, build, "2")).not.toContain("What each implemented functionality");

    recordFunctionality(build, "app", {
      frid: "2", ...specStateFor(t, "2"), unitTests: "passed", files: { added: ["app/main.py"], changed: [], removed: [] },
    });
    const map = codebaseMap(t, build, "3")!;
    expect(map).toContain("  app 2: added app/main.py\n  not recorded for app 1");
  });

  it("goes into the render prompt, with the instruction to start from it", () => {
    const prompt = buildRenderPrompt({
      moduleName: "app", frid: "2", linkedResources: [], codebase: "Files (1):\n  app/main.py",
      specifications: { definitions: [], "implementation reqs": [], "test reqs": [], "functional specs": ["- One.", "- Two."] },
    });
    expect(prompt).toContain("<codebase>\nFiles (1):\n  app/main.py\n</codebase>");
    expect(prompt).toContain("Start from it");
  });
});

describe("the build record", () => {
  it("keeps what the render touched when a later write about the same build does not say", () => {
    const t = tree();
    const files = { added: ["app/main.py"], changed: [], removed: [] };
    recordFunctionality(build, "app", { frid: "1", ...specStateFor(t, "1"), unitTests: "passed", files, testCommand: "pytest" });
    recordFunctionality(build, "app", { frid: "1", ...specStateFor(t, "1"), unitTests: "passed", conformance: "passed" });
    const entry = readState(build)!.functionalities["1"]!;
    expect(entry.files).toEqual(files);
    expect(entry.testCommand).toBe("pytest");
    expect(entry.conformance).toBe("passed");
  });
});
