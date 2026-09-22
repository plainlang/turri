import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSkill, skillStatus } from "../../src/skill.ts";

let dir: string;

function skill(body: string, frontmatter = "") {
  const path = join(dir, "demo");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), `---\nname: demo\ndescription: A skill.\n${frontmatter}---\n\n${body}`);
  return loadSkill(path);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plainwright-steps-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("a skill without a Steps section", () => {
  it("is one step, named after the skill", () => {
    const s = skill("# Demo\n\nDo the thing carefully.\n");
    expect(s.steps.map((x) => x.name)).toEqual(["demo"]);
  });

  it("carries the whole body as its instructions", () => {
    const s = skill("# Demo\n\nDo the thing carefully.\n");
    expect(s.steps[0]!.instructions).toContain("Do the thing carefully.");
  });

  it("does not split on headings in its prose", () => {
    // The trap this replaced: a prose skill's explanatory subsections are not steps.
    const s = skill("# Demo\n\n## Workflow\n\n### 1. Read the file\n\ntext\n\n### 2. Edit it\n\ntext\n");
    expect(s.steps).toHaveLength(1);
    expect(s.steps[0]!.instructions).toContain("### 1. Read the file");
  });
});

describe("a skill with a Steps section", () => {
  const body = `# Demo

## Notes

### Not a step

prose

## Steps

### first

Do the first thing.

### second

Do the second thing.
`;

  it("takes its steps from that section only", () => {
    expect(skill(body).steps.map((x) => x.name)).toEqual(["first", "second"]);
  });

  it("keeps each step's own instructions", () => {
    expect(skill(body).steps[1]!.instructions).toBe("Do the second thing.");
  });
});

describe("gates", () => {
  it("attach to the named step", () => {
    const s = skill("## Steps\n\n### first\n\nDo it.\n", "metadata:\n  gates:\n    - after: first\n      review:\n        rubric: ./r.md\n");
    expect(s.steps[0]!.gate?.review.rubric).toBe("./r.md");
  });

  it("can gate the implicit single step by naming the skill", () => {
    const s = skill("Do it.\n", "metadata:\n  gates:\n    - after: demo\n      review:\n        rubric: ./r.md\n");
    expect(s.steps[0]!.gate).toBeDefined();
  });

  it("are rejected when they name a step that does not exist", () => {
    expect(() =>
      skill("Do it.\n", "metadata:\n  gates:\n    - after: nope\n      review:\n        rubric: ./r.md\n"),
    ).toThrow(/gate references unknown step 'nope'/);
  });
});

describe("an empty skill", () => {
  it("is rejected", () => {
    expect(() => skill("\n")).toThrow(/body is empty/);
  });
});

describe("continuous review", () => {
  it("is off unless the gate asks for it", () => {
    const skill = loadSkill("skills/plain-healthcheck");
    expect(skill.steps.every((s) => s.gate?.continuous === undefined)).toBe(true);
  });

  it("is parsed alongside the phase gate", () => {
    const skill = loadSkill("skills/forge-plain");
    const step = skill.steps.find((s) => s.name === "functional-specs")!;
    expect(step.gate?.continuous).toEqual({
      rubric: "./references/rubric-functional-specs-live.md",
      judges: 1,
      model: undefined,
      judgeTools: ["read", "ls", "grep", "find"],
    });
    // The end-of-phase gate is untouched by it.
    expect(step.gate?.review.judges).toBe(2);
  });
});

describe("the status line while a skill runs", () => {
  const skill = {
    name: "forge-plain",
    steps: ["intent", "stack", "definitions", "functional-specs", "testing", "handoff"].map((name) => ({
      name,
      instructions: "",
    })),
  } as unknown as Parameters<typeof skillStatus>[0];

  it("names the phase and where it sits among them", () => {
    expect(skillStatus(skill, "definitions", 1)).toBe("forge-plain: definitions (phase 3 of 6)");
  });

  it("says when a phase is being retried after its gate", () => {
    expect(skillStatus(skill, "functional-specs", 2)).toBe("forge-plain: functional-specs (phase 4 of 6), attempt 2");
  });
});
