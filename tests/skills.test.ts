import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureInScratch } from "../src/regenerate/paths.ts";
import { catalogueLine, discoverSkills, leftOutNote } from "../src/skills.ts";

let root: string;
let harness: string;
let project: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "turri-skills-"));
  harness = join(root, "turri");
  project = join(root, "project");
  mkdirSync(project);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function skill(dir: string, name: string, description = `${name}, described.`, body = "# Do it\n\nDo the thing.\n") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\nallowed-tools: [read]\n---\n\n${body}`);
}

describe("the skills turri can run", () => {
  it("are its own, then the project's from .turri/skills and .agents/skills, each said whose it is", () => {
    skill(join(harness, "genome", "skills", "brood"), "brood");
    skill(join(project, ".turri", "skills", "release-notes"), "release-notes");
    skill(join(project, ".agents", "skills", "changelog"), "changelog");

    const found = discoverSkills(harness, project);
    expect(found.skills.map((s) => s.name)).toEqual(["brood", "release-notes", "changelog"]);
    expect(found.skills.map((s) => s.origin)).toEqual(["turri", { project: join(".turri", "skills", "release-notes") }, { project: join(".agents", "skills", "changelog") }]);
    expect(found.skills[2]!.dir).toBe(join(project, ".agents", "skills", "changelog"));
    expect(found.skills.map(catalogueLine)).toEqual([
      "- brood: brood, described.",
      `- release-notes (this project's, ${join(".turri", "skills", "release-notes")}): release-notes, described.`,
      `- changelog (this project's, ${join(".agents", "skills", "changelog")}): changelog, described.`,
    ]);
  });

  it("are run in the gated format: a project's skill keeps its steps and its gates", () => {
    const dir = join(project, ".turri", "skills", "intake");
    skill(
      dir,
      "intake",
      "Asks, then writes.",
      "# Intake\n\n## Steps\n\n### ask\n\nAsk.\n\n### write\n\nWrite.\n",
    );
    const raw = readFileSync(join(dir, "SKILL.md"), "utf8").replace("allowed-tools: [read]\n", "allowed-tools: [read]\nmetadata:\n  gates:\n    - after: write\n      review:\n        rubric: ./rubric.md\n");
    writeFileSync(join(dir, "SKILL.md"), raw);

    const [intake] = discoverSkills(harness, project).skills;
    expect(intake!.steps.map((step) => step.name)).toEqual(["ask", "write"]);
    expect(intake!.steps[1]!.gate?.review.rubric).toBe("./rubric.md");
  });

  it("leave out a project's skill whose name is taken - turri's own first, then .turri/skills - and say so", () => {
    skill(join(harness, "genome", "skills", "brood"), "brood");
    skill(join(project, ".turri", "skills", "brood"), "brood", "A brood of our own.");
    skill(join(project, ".turri", "skills", "notes"), "notes");
    skill(join(project, ".agents", "skills", "notes"), "notes", "Other notes.");

    const found = discoverSkills(harness, project);
    expect(found.skills.map((s) => `${s.name}: ${s.description}`)).toEqual(["brood: brood, described.", "notes: notes, described."]);
    expect(found.shadowed).toEqual([
      `${join(".turri", "skills", "brood")} (brood is turri's own)`,
      `${join(".agents", "skills", "notes")} (notes is ${join(".turri", "skills", "notes")})`,
    ]);
    expect(leftOutNote(found)).toContain("Left out, their names taken:");
  });

  it("report a project's skill that does not parse by its folder, and keep the rest", () => {
    mkdirSync(join(project, ".agents", "skills", "broken"), { recursive: true });
    writeFileSync(join(project, ".agents", "skills", "broken", "SKILL.md"), "---\nname: broken\n---\n\nNo description.\n");
    skill(join(project, ".agents", "skills", "fine"), "fine");

    const found = discoverSkills(harness, project);
    expect(found.skills.map((s) => s.name)).toEqual(["fine"]);
    expect(found.pending).toEqual([join(".agents", "skills", "broken")]);
    expect(leftOutNote(found)).toBe(`\n\nFailed to load and therefore not runnable: ${join(".agents", "skills", "broken")}.`);
  });

  it("are turri's own alone when there is no project, or it has no skill folders", () => {
    skill(join(harness, "genome", "skills", "brood"), "brood");
    expect(discoverSkills(harness, undefined).skills.map((s) => s.name)).toEqual(["brood"]);
    expect(discoverSkills(harness, project).skills.map((s) => s.name)).toEqual(["brood"]);
  });
});

describe("the scratch folder", () => {
  it("ignores everything in it but the project's skills", () => {
    execFileSync("git", ["init", "-q"], { cwd: project });
    const scratch = join(project, ".turri");
    ensureInScratch(scratch, join(scratch, "runs", "brood"));
    writeFileSync(join(scratch, "runs", "brood", "run.json"), "{}");
    skill(join(scratch, "skills", "notes"), "notes");
    mkdirSync(join(scratch, "skills", "notes", "references"));
    writeFileSync(join(scratch, "skills", "notes", "references", "rubric.md"), "rubric");

    const status = execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: project, encoding: "utf8" });
    expect(status.split("\n").filter((line) => line !== "").sort()).toEqual([
      "?? .turri/skills/notes/SKILL.md",
      "?? .turri/skills/notes/references/rubric.md",
    ]);
  });

  it("brings up to date a .gitignore written before skills were kept in it, and leaves one of the person's own", () => {
    const scratch = join(project, ".turri");
    mkdirSync(scratch);
    writeFileSync(join(scratch, ".gitignore"), "*\n");
    ensureInScratch(scratch, join(scratch, "runs"));
    expect(readFileSync(join(scratch, ".gitignore"), "utf8")).toBe("*\n!skills/\n!skills/**\n");

    writeFileSync(join(scratch, ".gitignore"), "*\n!notes.md\n");
    ensureInScratch(scratch, join(scratch, "runs"));
    expect(readFileSync(join(scratch, ".gitignore"), "utf8")).toBe("*\n!notes.md\n");
  });
});
