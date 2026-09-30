import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codebaseMap, diffFiles, digestFiles } from "../../src/render/codebase.ts";
import { buildSpecDiffPrompt } from "../../src/render/prompt.ts";

let dir: string;
let build: string;

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
    expect(codebaseMap(build)).toBeNull();
  });

  it("lists the files", () => {
    write("app/main.py", "x");
    write("app/routes.py", "x");
    expect(codebaseMap(build)).toBe("Files (2):\n  app/main.py\n  app/routes.py");
  });

  it("goes into the coding agent's prompt, with the instruction to start from it", () => {
    const prompt = buildSpecDiffPrompt({
      moduleName: "app", diff: "+- Two.", linkedResources: [], codebase: "Files (1):\n  app/main.py", required: [], empty: false,
      specifications: { definitions: [], "implementation reqs": [], "test reqs": [], "functional specs": ["- One."] },
    });
    expect(prompt).toContain("<codebase>\nFiles (1):\n  app/main.py\n</codebase>");
    expect(prompt).toContain("Start from it");
  });
});
