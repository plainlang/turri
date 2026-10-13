import { describe, expect, it } from "vitest";
import { agentChanges, changeDiff, changeDiffInFiles } from "../../src/regenerate/change-view.ts";
import { diffView, locateDiffLines } from "../../src/regenerate/diff-view.ts";
import type { SpecChange } from "../../src/regenerate/spec-steps.ts";

const item = (markdown: string, extra: Record<string, unknown> = {}) => JSON.stringify({ markdown, ...extra });
const add = (section: string, position: number, markdown: string, extra?: Record<string, unknown>): SpecChange => ({
  id: `${section}-${position}`,
  section,
  kind: "add",
  after: item(markdown, extra),
  position,
});

const app = [
  "***definitions***",
  "",
  "- :User: is a person.",
  "- :Board: is a grid.",
  "",
  "***functional specs***",
  "",
  "- A :User: sees the :Board:.",
  "",
].join("\n");
const imported = ["***definitions***", "", "- :Engine: draws the :Board:.", "", "***implementation reqs***", "", "- Use the engine.", ""].join("\n");
const files = [
  { name: "app.plain", text: app },
  { name: "template/engine.plain", text: imported },
];
const locate = (diff: string) => locateDiffLines(diff, files);

describe("a job's change as its agent is given it", () => {
  it("shows each item in the file it is written in - an import's in the import's - under its section, with its line", () => {
    const changes = [
      add("definitions", 1, "- :Engine: draws the :Board:."),
      add("definitions", 2, "- :User: is a person."),
      add("implementation reqs", 1, "- Use the engine."),
      add("functional specs", 1, "- A :User: sees the :Board:."),
    ];
    const { diff, where } = changeDiffInFiles(changes, "app.plain", locate);
    const shown = diffView(diff, 80, undefined, where).map((line) => line.trimEnd());

    expect(shown).toContain("app.plain  +2");
    expect(shown).toContain("template/engine.plain  +2");
    expect(shown).toContain("3 + - :User: is a person.");
    expect(shown).toContain("8 + - A :User: sees the :Board:.");
    expect(shown).toContain("3 + - :Engine: draws the :Board:.");
    expect(shown).toContain("7 + - Use the engine.");
    // Only what the job takes: the definition no functional spec of it uses is not there.
    expect(shown.some((line) => line.includes(":Board: is a grid"))).toBe(false);
  });

  it("puts each file's items in the order the file has them, not the order the spec is read in", () => {
    const later = add("definitions", 1, "- :Board: is a grid.");
    const earlier = add("definitions", 2, "- :User: is a person.");
    const { diff } = changeDiffInFiles([later, earlier], "app.plain", locate);
    expect(diff.indexOf(":User: is a person")).toBeLessThan(diff.indexOf(":Board: is a grid"));
  });

  it("writes a changed item out and in, and its acceptance tests indented under it as a file has them", () => {
    const diff = changeDiff(
      [{ id: "f", section: "functional specs", kind: "change", before: item("- One."), after: item("- One, loudly.", { acceptance_tests: [{ markdown: "- It is loud." }] }), position: 1 }],
      "app.plain",
    );
    expect(diff).toContain(" ***functional specs***\n-- One.\n+- One, loudly.\n+\n+    ***acceptance tests***\n+\n+    - It is loud.");
  });

  it("leaves the test reqs out of a code job's change, and keeps them in a conformance job's", () => {
    const changes = [add("test reqs", 1, "- Use pytest."), add("functional specs", 1, "- One.")];
    expect(agentChanges(changes, "code").map((change) => change.section)).toEqual(["functional specs"]);
    expect(agentChanges(changes, "conformance")).toHaveLength(2);
  });
});
