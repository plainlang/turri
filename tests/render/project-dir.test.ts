import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { plainFileParser } from "../../src/plain/parser.ts";
import { projectDirOf } from "../../src/render/paths.ts";
import { renderFunctionality, resolveTemplateDirs } from "../../src/render/render.ts";
import { writeTestScripts } from "../test-scripts.ts";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "plainwright-project-dir-")));
  const cwd = process.cwd();
  process.chdir(root);
  onTestFinished(() => process.chdir(cwd));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const spec = "***implementation reqs***\n\n- Python, as [the notes](resources/notes.md) say.\n\n***functional specs***\n\n- It prints hello.\n";

describe("a spec kept in a folder of its own, named from the one above", () => {
  beforeEach(() => {
    mkdirSync(join(root, "plain", "resources"), { recursive: true });
    writeFileSync(join(root, "plain", "resources", "notes.md"), "notes\n");
    writeFileSync(join(root, "plain", "hubspot.plain"), spec);
    writeFileSync(join(root, "plain", "config.yaml"), "conformance-tests: false\n");
    writeTestScripts(join(root, "plain"));
  });

  it("belongs to the project of its folder - the one with config.yaml or plain_modules", () => {
    expect(projectDirOf("plain/hubspot.plain")).toBe(join(root, "plain"));
  });

  it("parses, its links found beside it rather than where plainwright was started", () => {
    const [name] = plainFileParser("hubspot.plain", resolveTemplateDirs("plain/hubspot.plain"));
    expect(name).toBe("hubspot");
  });

  it("is built in that project's plain_modules", async () => {
    const result = await renderFunctionality({ plainFile: "plain/hubspot.plain", frid: "1", dryRun: true });
    expect(result.buildDir).toBe(join(root, "plain", "plain_modules", "hubspot", "code"));
    // Its own testing scripts, and nothing about plain/ in the prompt is missing.
    expect(result.prompt).toContain("test_scripts/run_unittests_python.sh");
  });
});

describe("a spec at the root of its project", () => {
  it("is built where it always was", () => {
    writeFileSync(join(root, "app.plain"), spec.replace(", as [the notes](resources/notes.md) say", ""));
    mkdirSync(join(root, "plain_modules"));
    expect(projectDirOf("app.plain")).toBe(root);
    // No marker anywhere: its own folder.
    mkdirSync(join(root, "specs"));
    rmSync(join(root, "plain_modules"), { recursive: true });
    expect(projectDirOf("specs/x.plain")).toBe(join(root, "specs"));
  });
});

describe("where a skill run keeps its state", () => {
  it("is .plainwright/runs/<skill>, which the project's history ignores", async () => {
    const { skillRunDir } = await import("../../src/render/paths.ts");
    const { existsSync, readFileSync } = await import("node:fs");
    expect(skillRunDir(root, "forge-plain")).toBe(join(root, ".plainwright", "runs", "forge-plain"));
    expect(readFileSync(join(root, ".plainwright", ".gitignore"), "utf8")).toBe("*\n");
    expect(existsSync(join(root, ".forge"))).toBe(false);
  });

  it("takes over a run left in .forge/run, so it can still be resumed, and removes .forge", async () => {
    const { skillRunDir } = await import("../../src/render/paths.ts");
    const { existsSync, readFileSync } = await import("node:fs");
    mkdirSync(join(root, ".forge", "run", "forge-plain"), { recursive: true });
    writeFileSync(join(root, ".forge", "run", "forge-plain", "manifest.json"), '{"status":"running"}');
    const dir = skillRunDir(root, "forge-plain");
    expect(readFileSync(join(dir, "manifest.json"), "utf8")).toBe('{"status":"running"}');
    expect(existsSync(join(root, ".forge"))).toBe(false);
  });
});
