import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { skillProgressLine, type SkillProgress } from "../src/skill-progress.ts";
import { loadSkill } from "../src/skill.ts";
import { join } from "node:path";

const brood = (current: number, attempt = 1): SkillProgress => ({
  skill: "brood",
  phases: ["intent", "stack", "testing", "product"],
  current,
  attempt,
  frame: "⠋",
});

describe("a skill's progress, above the input", () => {
  it("names every phase in order - done ticked, the one it is in marked, the rest to come - and says where it is", () => {
    expect(skillProgressLine(brood(1), 70).trim()).toBe("brood  ✓ intent ━━ ⠋ stack ── ○ testing ── ○ product   phase 2 of 4");
    expect(skillProgressLine(brood(-1), 90).trim()).toMatch(/^brood {2}○ intent ─+ ○ stack ─+ ○ testing ─+ ○ product {3}starting$/);
    expect(skillProgressLine(brood(3, 2), 120)).toMatch(/✓ testing ━+ ⠋ product {3}phase 4 of 4, attempt 2$/);
  });

  it("is centred, across 80% of the width - the joins stretched to fill it - and more only where where it is would not fit", () => {
    for (const width of [100, 120, 161]) {
      const line = skillProgressLine(brood(1), width);
      const drawn = line.trimStart();
      expect(visibleWidth(drawn), `${width}`).toBe(Math.floor(width * 0.8));
      const left = visibleWidth(line) - visibleWidth(drawn);
      expect(left, `${width}`).toBe(Math.floor((width - visibleWidth(drawn)) / 2));
      expect(drawn).toMatch(/^brood .*phase 2 of 4$/);
    }
    // At 70, 80% leaves no room for where it is: it takes what that needs, centred still.
    expect(skillProgressLine(brood(1), 70)).toBe(" brood  ✓ intent ━━ ⠋ stack ── ○ testing ── ○ product   phase 2 of 4");
  });

  it("keeps the phases when the line is narrow, and leaves out where it is first", () => {
    expect(skillProgressLine(brood(1), 55)).toBe("brood  ✓ intent ━━ ⠋ stack ── ○ testing ── ○ product");
    expect(visibleWidth(skillProgressLine(brood(1), 30))).toBeLessThanOrEqual(30);
  });

  it("reads its phases from the skill itself - brood's four, spawn's three", () => {
    const phases = (name: string) => loadSkill(join(process.cwd(), "genome", "skills", name)).steps.map((step) => step.name);
    expect(phases("brood")).toEqual(["intent", "stack", "testing", "product"]);
    expect(phases("spawn")).toEqual(["intent", "groundwork", "product"]);
  });
});
