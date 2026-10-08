import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { skillAboutLine, skillProgressLine, type SkillProgress } from "../src/skill-progress.ts";
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
    expect(skillProgressLine(brood(1), 70)).toMatch(/^brood {3,}✓ intent ━+ ⠋ stack ─+ ○ testing ─+ ○ product {3,}phase 2 of 4$/);
    expect(skillProgressLine(brood(-1), 90)).toMatch(/^brood {3,}○ intent ─+ ○ stack ─+ ○ testing ─+ ○ product {3,}starting$/);
    expect(skillProgressLine(brood(3, 2), 120)).toMatch(/✓ testing ━+ ⠋ product {3,}phase 4 of 4, attempt 2$/);
  });

  it("puts the skill at the left edge and where it is at the right, its phases centred between them across 60% of the width", () => {
    for (const width of [100, 120, 161]) {
      const line = skillProgressLine(brood(1), width);
      expect(visibleWidth(line), `${width}`).toBe(width);
      expect(line).toMatch(/^brood .*phase 2 of 4$/);
      const bar = line.slice(line.indexOf("✓"), line.indexOf("○ product") + "○ product".length);
      expect(visibleWidth(bar), `${width}`).toBe(Math.floor(width * 0.6));
      expect(line.indexOf("✓"), `${width}`).toBe(Math.floor((width - visibleWidth(bar)) / 2));
    }
    // Where its share would run into either end, the phases take less, still clear of both and centred.
    const line = skillProgressLine(brood(1), 70);
    expect(visibleWidth(line)).toBe(70);
    expect(line.indexOf("✓")).toBeGreaterThanOrEqual("brood".length + 3);
  });

  it("keeps the phases when the line is narrow, and leaves out where it is first", () => {
    expect(skillProgressLine(brood(1), 55)).toBe("brood  ✓ intent ━━ ⠋ stack ── ○ testing ── ○ product");
    expect(visibleWidth(skillProgressLine(brood(1), 30))).toBeLessThanOrEqual(30);
  });

  it("says under it what the phase it is in does, centred under the phases - nothing before the first starts", () => {
    const about = "the language, frameworks, storage and architecture";
    const line = skillAboutLine({ ...brood(1), about }, 120)!;
    expect(line.trim()).toBe(`stack - ${about}`);
    expect(visibleWidth(line) - visibleWidth(line.trimStart())).toBe(Math.floor((120 - visibleWidth(line.trim())) / 2));
    expect(skillAboutLine({ ...brood(-1), about }, 120)).toBeUndefined();
    expect(skillAboutLine(brood(1), 120)).toBeUndefined();
    // Too long for the width, it is cut short, and on a narrow screen starts at the left.
    const narrow = skillAboutLine({ ...brood(1), about }, 40)!;
    expect(visibleWidth(narrow)).toBeLessThanOrEqual(40);
    expect(narrow.startsWith("stack - ")).toBe(true);
    expect(narrow).toContain("…");
  });

  it("reads its phases from the skill itself - brood's four, spawn's three", () => {
    const phases = (name: string) => loadSkill(join(process.cwd(), "genome", "skills", name)).steps.map((step) => step.name);
    expect(phases("brood")).toEqual(["intent", "stack", "testing", "product"]);
    expect(phases("spawn")).toEqual(["intent", "groundwork", "product"]);
  });
});
