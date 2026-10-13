import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  dir = mkdtempSync(join(tmpdir(), "turri-steps-"));
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

describe("what each step does", () => {
  it("comes from metadata.phases, a line a step by its name", () => {
    const s = skill("## Steps\n\n### first\n\nDo it.\n\n### second\n\nThen this.\n", "metadata:\n  phases:\n    first: \"reads the spec\"\n");
    expect(s.steps.map((step) => step.about)).toEqual(["reads the spec", undefined]);
  });

  it("is rejected when it describes a step that does not exist", () => {
    expect(() => skill("## Steps\n\n### first\n\nDo it.\n", "metadata:\n  phases:\n    nope: \"does nothing\"\n")).toThrow(
      /'metadata.phases' describes unknown step 'nope'/,
    );
  });

  it("is said for every phase of every skill that has phases", () => {
    for (const name of readdirSync(join(process.cwd(), "genome", "skills"))) {
      const loaded = loadSkill(join(process.cwd(), "genome", "skills", name));
      if (loaded.steps.length < 2) continue;
      for (const step of loaded.steps) expect(step.about, `${name}: ${step.name}`).toBeTruthy();
    }
  });
});

describe("an empty skill", () => {
  it("is rejected", () => {
    expect(() => skill("\n")).toThrow(/body is empty/);
  });
});

describe("continuous review", () => {
  it("is off unless the gate asks for it", () => {
    const skill = loadSkill("genome/skills/check-plain-env");
    expect(skill.steps.every((s) => s.gate?.continuous === undefined)).toBe(true);
  });

  it("is parsed alongside the phase gate", () => {
    const s = skill(
      "## Steps\n\n### product\n\nDo it.\n",
      "metadata:\n  gates:\n    - after: product\n      continuous:\n        rubric: ./live.md\n        judges: 1\n        judge_tools: [read, ls, grep, find]\n      review:\n        rubric: ./r.md\n        judges: 2\n",
    );
    const step = s.steps.find((x) => x.name === "product")!;
    expect(step.gate?.continuous).toEqual({
      rubric: "./live.md",
      judges: 1,
      model: undefined,
      judgeTools: ["read", "ls", "grep", "find"],
    });
    // The end-of-phase gate is untouched by it.
    expect(step.gate?.review.judges).toBe(2);
  });
});

describe("brood's phases", () => {
  it("are intent, stack, testing and product - testing before the product phase, so its changes are conformance tested as they are built", () => {
    const skill = loadSkill("genome/skills/brood");
    expect(skill.steps.map((step) => step.name)).toEqual(["intent", "stack", "testing", "product"]);
  });

  it("are ungated - each ends on the person's confirmation, with no review", () => {
    expect(loadSkill("genome/skills/brood").steps.every((step) => step.gate === undefined)).toBe(true);
  });
});

describe("brood's questioning level", () => {
  it("caps the stack and product phases, not intent or testing", () => {
    expect(loadSkill("genome/skills/brood").questioning).toEqual(["stack", "product"]);
    // Whatever the level, each product answer is a spec change before the next question.
    expect(loadSkill("genome/skills/brood").diffPerAnswer).toEqual(["product"]);
    expect(loadSkill("genome/skills/spawn").questioning).toEqual([]);
  });
});

describe("spawn, brood's quick twin", () => {
  it("asks only about intent, then sets up and writes the product on its own - unpaced, and ungated", () => {
    const skill = loadSkill("genome/skills/spawn");
    expect(skill.steps.map((step) => step.name)).toEqual(["intent", "groundwork", "product"]);
    expect(skill.steps.every((step) => step.gate === undefined)).toBe(true);
    expect(skill.paced).toBe(false);
    expect(skill.allowedTools).toContain("write_spec_diff");
    // brood's interview stays paced: one answer, one change.
    expect(loadSkill("genome/skills/brood").paced).toBe(true);
  });
});

describe("a skill's tools", () => {
  it("are the ones its frontmatter names, and none when it names none", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    expect(loadSkill("genome/skills/add-implementation-requirement").allowedTools).toEqual(["read", "write", "edit", "bash", "ls", "grep", "find"]);
    const dir = mkdtempSync(join(tmpdir(), "turri-skill-"));
    writeFileSync(join(dir, "SKILL.md"), "---\nname: none\ndescription: nothing\n---\n\nDo nothing.\n");
    expect(loadSkill(dir).allowedTools).toEqual([]);
  });

  it("every skill here names its tools - the ones that only read and report can only read", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    for (const name of readdirSync("genome/skills")) {
      expect(readFileSync(`genome/skills/${name}/SKILL.md`, "utf8"), name).toMatch(/^allowed-tools: \[/m);
      const tools = loadSkill(`genome/skills/${name}`).allowedTools;
      expect(tools, name).toContain("read");
      if (name.startsWith("analyze-")) expect(tools, name).not.toContain("write");
      else if (name !== "check-plain-env") expect(tools, name).toEqual(expect.arrayContaining(["write", "edit"]));
    }
  });
});

describe("mature", () => {
  it("grows a rough spec until it is fully grown, on its own - with the conversation's regenerate, drift and halt, and its own tools to watch the pulses and read what they decided", () => {
    const skill = loadSkill("genome/skills/mature");
    expect(skill.steps.map((step) => step.name)).toEqual(["intake", "regenerate", "report"]);
    expect(skill.allowedTools).toEqual(expect.arrayContaining(["write_spec_diff", "regenerate", "drift", "halt", "watch_jobs", "spec_findings"]));
    expect(skill.paced).toBe(false);
  });
});

describe("bud", () => {
  it("builds a feature as brood builds a product: product questions, one spec diff per answer, paced", () => {
    const skill = loadSkill("genome/skills/bud");
    expect(skill.steps.map((step) => step.name)).toEqual(["intent", "scope", "product", "review"]);
    expect(skill.allowedTools).toContain("write_spec_diff");
    expect(skill.paced).toBe(true);
  });
});

describe("the status line while a skill runs", () => {
  const skill = {
    name: "brood",
    steps: ["intent", "stack", "product"].map((name) => ({
      name,
      instructions: "",
    })),
  } as unknown as Parameters<typeof skillStatus>[0];

  it("names the phase and where it sits among them", () => {
    expect(skillStatus(skill, "stack", 1)).toBe("brood: stack (phase 2 of 3)");
  });

  it("says when a phase is being retried after its gate", () => {
    expect(skillStatus(skill, "product", 2)).toBe("brood: product (phase 3 of 3), attempt 2");
  });
});
