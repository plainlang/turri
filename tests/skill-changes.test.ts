import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changedFiles, projectFiles } from "../src/extension.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plainwright-skill-changes-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("what a skill run changed", () => {
  it("is every project file added, changed or removed - not the built code, the dependencies or plainwright's own folders", () => {
    writeFileSync(join(root, "frontend.plain"), "***functional specs***\n\n- Show.\n");
    writeFileSync(join(root, "old.plain"), "***functional specs***\n\n- Old.\n");
    mkdirSync(join(root, "plain_modules", "frontend", "code"), { recursive: true });
    mkdirSync(join(root, ".plainwright"), { recursive: true });
    const before = projectFiles(root);

    writeFileSync(join(root, "frontend.plain"), "***implementation reqs***\n\n- Use the brand theme.\n\n***functional specs***\n\n- Show.\n");
    mkdirSync(join(root, "resources"));
    writeFileSync(join(root, "resources", "brand-theme.css"), ":root { --brand: #0a7; }\n");
    rmSync(join(root, "old.plain"));
    writeFileSync(join(root, "plain_modules", "frontend", "code", "app.ts"), "export {};\n");
    writeFileSync(join(root, ".plainwright", "log"), "x\n");

    expect(changedFiles(before, projectFiles(root))).toEqual(["frontend.plain", "old.plain (removed)", join("resources", "brand-theme.css")]);
  });

  it("is nothing when the skill wrote nothing - whatever it said", () => {
    writeFileSync(join(root, "frontend.plain"), "x\n");
    expect(changedFiles(projectFiles(root), projectFiles(root))).toEqual([]);
  });
});
