import { describe, expect, it } from "vitest";
import { createJobRegistry } from "../../src/grow/jobs.ts";
import { jobPanelLines, summarizeDiff } from "../../src/grow/job-panel.ts";

const diff = [
  "diff --git a/backend.plain b/backend.plain",
  "--- a/backend.plain",
  "+++ b/backend.plain",
  "@@ -3,6 +3,8 @@",
  " - :User: is a registered student account.",
  "+",
  "+- :Kudo: is a unit of appreciation a :User: gives to a :StudySession:.",
  " ",
  "-- Old rule.",
  "+- A repeated :Kudo: has no further effect.",
  "",
].join("\n");

function gate() {
  let release!: () => void;
  return { opened: new Promise<void>((resolve) => (release = resolve)), release: () => release() };
}

describe("showing a spec change", () => {
  it("sums it up in one line: the files, the lines, and what it is about", () => {
    expect(summarizeDiff(diff)).toBe("backend.plain +3 −1 · :Kudo: is a unit of appreciation a :User: gives to a :StudySession:.");
  });

  it("shows under a running job, in full with ctrl+o, and as a line under each queued one", async () => {
    const jobs = createJobRegistry();
    const { opened, release } = gate();
    jobs.start({ kind: "regrow", summary: "backend.plain render spec diff", diff, lanes: ["m"], run: async () => (await opened, { report: "" }) });
    jobs.start({ kind: "regrow", summary: "backend.plain render spec diff", diff, lanes: ["m"], run: async () => ({ report: "" }) });

    const compact = jobPanelLines(jobs.list());
    expect(compact).toContain("    backend.plain +3 −1 · :Kudo: is a unit of appreciation a :User: gives to a :StudySession:.");
    expect(compact.some((line) => line.includes("│"))).toBe(false);

    const expanded = jobPanelLines(jobs.list(), { expanded: true });
    // The sign in a column of its own, the row padded out for its band.
    expect(expanded.map((line) => line.trimEnd())).toContain("      │ + - :Kudo: is a unit of appreciation a :User: gives to a :StudySession:.");
    expect(expanded.filter((line) => line.includes("backend.plain +3 −1"))).toHaveLength(2);
    release();
  });
});

describe("colouring a spec change", () => {
  const style = { added: (t: string) => `<green>${t}</green>`, removed: (t: string) => `<red>${t}</red>` };

  it("colours the counts in the summary line", () => {
    expect(summarizeDiff(diff, style)).toBe(
      "backend.plain <green>+3</green> <red>−1</red> · :Kudo: is a unit of appreciation a :User: gives to a :StudySession:.",
    );
  });
});

describe("the job panel, opened", () => {
  it("wraps every line to the width, its continuations under its text - in a diff box, under the box's rule", async () => {
    const { wrapKeepingIndent } = await import("../../src/grow/job-panel.ts");
    const long = "    reviewing the code and its unit tests (review 1): does the code do what the spec says, and does each test fail when that breaks";
    const rows = wrapKeepingIndent(long, 40);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((row) => row.length <= 40)).toBe(true);
    expect(rows.slice(1).every((row) => row.startsWith("    ") && !row.startsWith("     "))).toBe(true);
    expect(rows.join(" ").replace(/\s+/g, " ")).toContain("when that breaks");
    const boxed = wrapKeepingIndent(`      │ ${"word ".repeat(20)}`, 40);
    expect(boxed.slice(1).every((row) => row.startsWith("      │ "))).toBe(true);
    expect(wrapKeepingIndent("short", 40)).toEqual(["short"]);
  });
});
