import { rgbColor } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { BREATH_MS, breath, breathes, breathing, keyPressed, resetKeysForTests } from "../../src/grow/job-panel.ts";

afterEach(() => resetKeysForTests());

const theme = { colors: { text: rgbColor(255, 255, 255), dim: rgbColor(0, 0, 0) }, getColorMode: () => "truecolor" };

describe("the keys under the job panel", () => {
  it("breathe from fully there to a little faint and back, once a breath", () => {
    expect(breath(0)).toBe(0);
    expect(breath(BREATH_MS / 2)).toBeCloseTo(0.6);
    expect(breath(BREATH_MS / 4)).toBeCloseTo(0.3);
    expect(breath(BREATH_MS)).toBeCloseTo(0);
  });

  it("are painted in the text's colour mixed toward the dim one - fully there at the start of a breath, fainter halfway", () => {
    const start = breathing(theme, 0)("trace", "ctrl+o to expand the trace");
    const half = breathing(theme, BREATH_MS / 2)("trace", "ctrl+o to expand the trace");
    expect(start).toBe("\x1b[38;2;255;255;255mctrl+o to expand the trace\x1b[39m");
    expect(half).not.toBe(start);
    expect(half).toContain("ctrl+o to expand the trace");
  });

  it("each stop breathing once pressed, the other breathing on", () => {
    keyPressed("trace");
    expect(breathes("trace")).toBe(false);
    expect(breathes("peek")).toBe(true);
    const paint = breathing(theme, BREATH_MS / 2);
    expect(paint("trace", "ctrl+o to expand the trace")).toBe("ctrl+o to expand the trace");
    expect(paint("peek", "ctrl+h to peek at regen")).toMatch(/^\x1b\[38;2;/);
    keyPressed("peek");
    expect(breathing(theme, BREATH_MS / 2)("peek", "ctrl+h to peek at regen")).toBe("ctrl+h to peek at regen");
  });

  it("are left plain where the theme has no colours to mix", () => {
    expect(breathing({}, BREATH_MS / 2)("peek", "ctrl+h to peek at regen")).toBe("ctrl+h to peek at regen");
  });
});
