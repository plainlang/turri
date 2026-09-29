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
    const skill = loadSkill("skills/check-plain-env");
    expect(skill.steps.every((s) => s.gate?.continuous === undefined)).toBe(true);
  });

  it("is parsed alongside the phase gate", () => {
    const skill = loadSkill("skills/forge-plain");
    const step = skill.steps.find((s) => s.name === "product")!;
    expect(step.gate?.continuous).toEqual({
      rubric: "./references/rubric-product-live.md",
      judges: 1,
      model: undefined,
      judgeTools: ["read", "ls", "grep", "find"],
    });
    // The end-of-phase gate is untouched by it.
    expect(step.gate?.review.judges).toBe(2);
  });
});

describe("forge-plain's phases", () => {
  it("are intent, stack, testing and product - testing before the product phase, so its changes are conformance tested as they are built", () => {
    const skill = loadSkill("skills/forge-plain");
    expect(skill.steps.map((step) => step.name)).toEqual(["intent", "stack", "testing", "product"]);
    expect(skill.steps.find((step) => step.name === "product")!.gate).toBeDefined();
    expect(skill.steps.find((step) => step.name === "testing")!.gate).toBeUndefined();
  });
});

describe("spark-plain, forge-plain's quick twin", () => {
  it("asks only about intent, then sets up and writes the product on its own - unpaced, and ungated", () => {
    const skill = loadSkill("skills/spark-plain");
    expect(skill.steps.map((step) => step.name)).toEqual(["intent", "groundwork", "product"]);
    expect(skill.steps.every((step) => step.gate === undefined)).toBe(true);
    expect(skill.paced).toBe(false);
    expect(skill.allowedTools).toContain("write_spec_diff");
    // forge-plain's interview stays paced: one answer, one change.
    expect(loadSkill("skills/forge-plain").paced).toBe(true);
  });
});

describe("a skill's tools", () => {
  it("are the ones its frontmatter names, and none when it names none", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    expect(loadSkill("skills/add-implementation-requirement").allowedTools).toEqual(["read", "write", "edit", "bash", "ls", "grep", "find"]);
    const dir = mkdtempSync(join(tmpdir(), "plainwright-skill-"));
    writeFileSync(join(dir, "SKILL.md"), "---\nname: none\ndescription: nothing\n---\n\nDo nothing.\n");
    expect(loadSkill(dir).allowedTools).toEqual([]);
  });

  it("every skill here names its tools - the ones that only read and report can only read", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    for (const name of readdirSync("skills")) {
      expect(readFileSync(`skills/${name}/SKILL.md`, "utf8"), name).toMatch(/^allowed-tools: \[/m);
      const tools = loadSkill(`skills/${name}`).allowedTools;
      expect(tools, name).toContain("read");
      if (name.startsWith("analyze-")) expect(tools, name).not.toContain("write");
      else if (name !== "check-plain-env") expect(tools, name).toEqual(expect.arrayContaining(["write", "edit"]));
    }
  });
});

describe("temper-plain", () => {
  it("renders a rough spec until it is fully rendered, on its own - with the tools to watch, stop, check the goal and read what the builds decided", () => {
    const skill = loadSkill("skills/temper-plain");
    expect(skill.steps.map((step) => step.name)).toEqual(["intake", "temper", "report"]);
    expect(skill.allowedTools).toEqual(expect.arrayContaining(["write_spec_diff", "render_spec", "watch_jobs", "stop_job", "spec_status", "spec_findings"]));
    expect(skill.paced).toBe(false);
  });
});

describe("add-feature", () => {
  it("builds a feature as forge-plain builds a product: product questions, one spec diff per answer, paced", () => {
    const skill = loadSkill("skills/add-feature");
    expect(skill.steps.map((step) => step.name)).toEqual(["intent", "scope", "product", "review"]);
    expect(skill.allowedTools).toContain("write_spec_diff");
    expect(skill.paced).toBe(true);
  });
});

describe("the status line while a skill runs", () => {
  const skill = {
    name: "forge-plain",
    steps: ["intent", "stack", "product"].map((name) => ({
      name,
      instructions: "",
    })),
  } as unknown as Parameters<typeof skillStatus>[0];

  it("names the phase and where it sits among them", () => {
    expect(skillStatus(skill, "stack", 1)).toBe("forge-plain: stack (phase 2 of 3)");
  });

  it("says when a phase is being retried after its gate", () => {
    expect(skillStatus(skill, "product", 2)).toBe("forge-plain: product (phase 3 of 3), attempt 2");
  });
});
