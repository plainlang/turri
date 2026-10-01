import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateProject } from "../../src/grow/migrate.ts";
import { recordHistory } from "../../src/grow/lineage.ts";
import { readRecord } from "../../src/grow/records.ts";

let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "turri-migrate-"));
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

const git = (moduleDir: string, ...args: string[]) =>
  spawnSync("git", ["--git-dir", join(moduleDir, ".plaingit"), "--work-tree", moduleDir, ...args], { encoding: "utf8" }).stdout;

describe("a project built before turri had its name", () => {
  it("is brought over to the names turri uses now - its records and notes committed on their own, its scratch moved - and nothing else touched", () => {
    const module = join(project, "plain_modules", "app");
    for (const part of ["code", "tests"]) mkdirSync(join(module, part), { recursive: true });
    writeFileSync(join(module, "code", ".plainwright.json"), JSON.stringify({ "functional specs": [{ markdown: "- Say hello." }] }));
    writeFileSync(join(module, "tests", ".plainwright.json"), "{}\n");
    writeFileSync(join(module, "code", ".plainwright-notes.md"), "# Working notes\n");
    writeFileSync(join(module, "code", "app.py"), "print('hello')\n");
    recordHistory(join(module, "code"), "built before the rename");
    // Left by an interrupted job: never committed by the migration.
    writeFileSync(join(module, "code", "half.py"), "# half-written\n");
    mkdirSync(join(project, ".plainwright", "jobs"), { recursive: true });
    writeFileSync(join(project, ".plainwright", "jobs", "old.log"), "a job\n");
    // A log written under the new name before the migration ran: the two are merged.
    mkdirSync(join(project, ".turri", "debug"), { recursive: true });
    mkdirSync(join(project, "plain_modules", ".plainwright", "cache"), { recursive: true });

    migrateProject(project);

    expect(existsSync(join(module, "code", ".turri.json"))).toBe(true);
    expect(existsSync(join(module, "code", ".plainwright.json"))).toBe(false);
    expect(existsSync(join(module, "tests", ".turri.json"))).toBe(true);
    expect(readFileSync(join(module, "code", ".turri-notes.md"), "utf8")).toBe("# Working notes\n");
    expect(JSON.stringify(readRecord(join(module, "code")))).toContain("Say hello.");
    // Committed: the renames alone.
    expect(git(module, "log", "-1", "--format=%s")).toMatch(/^turri's files under the names they have now/);
    expect(git(module, "show", "--name-only", "--no-renames", "--format=", "HEAD").trim().split("\n").sort()).toEqual(
      ["code/.plainwright-notes.md", "code/.plainwright.json", "code/.turri-notes.md", "code/.turri.json", "tests/.plainwright.json", "tests/.turri.json"].sort(),
    );
    expect(git(module, "status", "--porcelain")).toContain("half.py");
    // The scratch folders, moved - into the one already there, too.
    expect(readFileSync(join(project, ".turri", "jobs", "old.log"), "utf8")).toBe("a job\n");
    expect(existsSync(join(project, ".turri", "debug"))).toBe(true);
    expect(existsSync(join(project, ".plainwright"))).toBe(false);
    expect(existsSync(join(project, "plain_modules", ".turri", "cache"))).toBe(true);
  });

  it("has its record read under the old name until it is brought over", () => {
    const code = join(project, "plain_modules", "app", "code");
    mkdirSync(code, { recursive: true });
    writeFileSync(join(code, ".plainwright.json"), JSON.stringify({ "functional specs": [{ markdown: "- Say hello." }] }));
    expect(JSON.stringify(readRecord(code, { onDisk: true }))).toContain("Say hello.");
  });
});
