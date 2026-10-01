import { describe, expect, it } from "vitest";
import { diffFiles, diffView, locateDiffLines, NOT_FOUND, type DiffPaint } from "../../src/render/diff-view.ts";
import { plainPaint } from "../../src/render/plain-palette.ts";

/**
 * Colours and fills as a terminal gets them - escape codes, which take no width - each its own code, so
 * `read` can say what the panels did to each piece.
 */
const CODES: Record<string, string> = { section: "31", concept: "32", literal: "33", bullet: "34", keyword: "35", module: "36", comment: "37", link: "90" };
const paint: DiffPaint = {
  syntax: (role, text) => `\x1b[${CODES[role]}m${text}\x1b[39m`,
  added: (text) => `\x1b[92m${text}\x1b[39m`,
  removed: (text) => `\x1b[91m${text}\x1b[39m`,
  addedBand: (text) => `\x1b[42m${text}\x1b[49m`,
  removedBand: (text) => `\x1b[41m${text}\x1b[49m`,
  muted: (text) => `\x1b[2m${text}\x1b[22m`,
};
const NAMES: Record<string, string> = {
  "31": "<section>", "32": "<concept>", "33": "<literal>", "34": "<bullet>", "35": "<keyword>", "36": "<module>", "37": "<comment>", "90": "<link>",
  "92": "<g>", "91": "<r>", "39": "</>", "42": "[+fill ", "41": "[-fill ", "49": "]", "2": "~", "22": "",
};
const read = (row: string) => row.replace(/\x1b\[(\d+)m/g, (_, code: string) => NAMES[code] ?? "");
const visible = (row: string) => row.replace(/\x1b\[[0-9;]*m/g, "");

const diff = [
  "diff --git a/app.plain b/app.plain",
  "--- a/app.plain",
  "+++ b/app.plain",
  "@@ -1,3 +1,3 @@",
  " ***functional specs***",
  "-- A :User: signs in.",
  "+- A :User: signs in with `email`.",
  "@@ -9 +9 @@",
  " - The end.",
  "",
].join("\n");

describe("a spec diff in the panels", () => {
  it("names the file once with what it adds and takes out, highlights each line's ***plain, and fills an added line green and a removed one red, the text on top", () => {
    const rows = diffView(diff, 40, paint).map(read);
    expect(rows[0]).toBe("~app.plain  <g>+1</> <r>−1</>");
    expect(rows[1]).toBe("  <section>***functional specs***</>");
    expect(rows[2]).toBe(`[-fill <r>-</> <bullet>-</> A <concept>:User:</> signs in.${" ".repeat(40 - "- - A :User: signs in.".length)}]`);
    expect(rows[3]).toBe(`[+fill <g>+</> <bullet>-</> A <concept>:User:</> signs in with <literal>\`email\`</>.${" ".repeat(40 - "+ - A :User: signs in with `email`.".length)}]`);
    // Lines hidden between two hunks, marked as GitHub marks them - with the section the next block is in.
    expect(rows[4]).toBe("~↕~ · <section>***functional specs***</>");
    expect(rows[5]).toBe("  <bullet>-</> The end.");
    expect(rows).toHaveLength(6);
  });

  it("wraps a long line under its text, the fill on every row of it, each the whole width", () => {
    const rows = diffView("+- A :User: gives kudos to a study session that another user shared with the group.\n", 30, paint).slice(1);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(read(row)).toMatch(/^\[\+fill .*\]$/);
      expect(visible(row)).toHaveLength(30);
    }
    expect(read(rows[1]!).startsWith("[+fill   ")).toBe(true);
  });

  it("carries front matter an added line opens to the added lines after it, and not to the lines before the change", () => {
    const rows = diffView(["@@ -1 +1,3 @@", "+---", "+import:", "+---", " import: stays text", ""].join("\n"), 30, { ...paint, addedBand: (text) => text.trimEnd() }).map(read);
    expect(rows).toContain("<g>+</> <keyword>import:</>");
    expect(rows).toContain("  import: stays text");
  });
});

describe("line numbers in a spec diff", () => {
  // The diff is of the spec as read - what app.plain imports laid into it - so its own numbers are not the file's.
  const app = ["---", "import:", "  - common", "---", "", "***functional specs***", "", "- A :User: signs in.", ""].join("\n");
  const common = ["***definitions***", "", "- :User: is a person.", ""].join("\n");
  const spec = [
    "--- a/app.plain",
    "+++ b/app.plain",
    "@@ -1,5 +1,6 @@",
    " ***definitions***",
    " ",
    "-- :User: is someone.",
    "+- :User: is a person.",
    " ",
    " ***functional specs***",
    "+- A :User: signs in.",
    "",
  ].join("\n");
  const files = [
    { name: "app.plain", text: app },
    { name: "template/common.plain", text: common },
  ];

  it("places each added and unchanged line where it is written - its file, and its line there - and a removed line nowhere", () => {
    const where = locateDiffLines(spec, files);
    const lines = spec.split("\n");
    const at = (text: string) => where[lines.indexOf(text)];
    // Each with the section it is in, in its file.
    expect(at(" ***definitions***")).toEqual({ file: "template/common.plain", line: 1, section: "***definitions***" });
    expect(at("+- :User: is a person.")).toEqual({ file: "template/common.plain", line: 3, section: "***definitions***" });
    expect(at(" ***functional specs***")).toEqual({ file: "app.plain", line: 6, section: "***functional specs***" });
    expect(at("+- A :User: signs in.")).toEqual({ file: "app.plain", line: 8, section: "***functional specs***" });
    expect(at("-- :User: is someone.")).toBeUndefined();
  });

  it("shows each file's lines together, the file being rendered first - each line's number in a gutter, none on a removed one, and how many lines are hidden between", () => {
    const rows = diffView(spec, 40, paint, locateDiffLines(spec, files)).map((row) => read(row).replace(/\s+\]$/, "]"));
    expect(rows).toEqual([
      // app.plain first: the diff is of it, what it imports laid in.
      "~app.plain  <g>+1</>",
      "~  ↑ 5 lines",
      "~6   <section>***functional specs***</>",
      "~  ↕ 1 line~ · <section>***functional specs***</>",
      "[+fill ~8 <g>+</> <bullet>-</> A <concept>:User:</> signs in.]",
      "~template/common.plain  <g>+1</> <r>−1</>",
      "~1   <section>***definitions***</>",
      "~2   ",
      "[-fill   <r>-</> <bullet>-</> <concept>:User:</> is someone.]",
      "[+fill ~3 <g>+</> <bullet>-</> <concept>:User:</> is a person.]",
      "~4   ",
    ]);
  });

  it("puts a file's lines together wherever the diff has them, the rest of the files by name - and leaves out a file the diff does not change", () => {
    const b = { name: "b.plain", text: "- One of b.\n- Two of b.\n" };
    const a = { name: "a.plain", text: "- One of a.\n" };
    const main = { name: "main.plain", text: "- Main.\n- Main two.\n" };
    const mixed = ["--- a/main.plain", "+++ b/main.plain", "@@ -1,5 +1,5 @@", "+- One of b.", " - One of a.", "+- Main.", "+- Two of b.", " - Main two.", ""].join("\n");
    const shown = diffView(mixed, 40, paint, locateDiffLines(mixed, [main, a, b])).map((row) => read(row).replace(/\s+\]$/, "]"));
    // main first, as it is the file rendered; then b - its two lines together; a is only context, and not shown.
    expect(shown.filter((row) => row.startsWith("~") && row.includes(".plain"))).toEqual(["~main.plain  <g>+1</>", "~b.plain  <g>+2</>"]);
    expect(shown.join("\n")).not.toContain("a.plain");
    expect(shown.indexOf("[+fill ~2 <g>+</> <bullet>-</> Two of b.]") - shown.indexOf("[+fill ~1 <g>+</> <bullet>-</> One of b.]")).toBe(1);
  });
});

describe("placing a spec diff's lines in their files", () => {
  // The module's own definition with a link comes after a context line of a template it imports - as the spec reads.
  const common = { name: "template/crm_common.plain", text: "***definitions***\n\n- :Provider: is a CRM.\n" };
  const own = { name: "hubspot.plain", text: "***definitions***\n\n- :HubSpotMapping: is described in [resources/mapping.md](resources/mapping.md).\n" };
  const spec = ["--- a/hubspot.plain", "+++ b/hubspot.plain", "@@ -1,3 +1,5 @@", " - :Provider: is a CRM.", " ", "+- :HubSpotMapping: is described in `[resource]resources/mapping.md`.", ""].join("\n");

  it("finds a line with a link in the file it is written in - the link as the parser renders it - never in the template beside it", () => {
    const where = locateDiffLines(spec, [own, common]);
    expect(where[5]).toEqual({ file: "hubspot.plain", line: 3, section: "***definitions***" });
    const files = diffFiles(spec, 60, undefined, where);
    expect(files.map((file) => [file.file, file.added])).toEqual([["hubspot.plain", 1]]);
  });

  it("shows a linked resource whose content changed as a file of its own, under its name - not with the lines found in no file", async () => {
    const { resourceDiff } = await import("../../src/render/spec-steps.ts");
    const item = (digest: string) => JSON.stringify({ markdown: "- :HubSpotMapping: is described in `[resource]resources/mapping.md`.", linked_resources: [{ digest, target: "resources/mapping.md", text: "resources/mapping.md" }] });
    const resource = resourceDiff([{ id: "1", section: "definitions", kind: "change", before: item("a1"), after: item("b2"), position: 1 }], "hubspot.plain");
    expect(resource).toContain("+resources/mapping.md, linked by :HubSpotMapping: in hubspot.plain: its content changed, sha256 b2");
    const both = `${spec}${resource}`;
    const files = diffFiles(both, 60, undefined, locateDiffLines(both, [own, common]));
    expect(files.map((file) => [file.file, file.added])).toEqual([["hubspot.plain", 1], ["resources/mapping.md", 1]]);
  });

  it("puts a line found in no file with the lines found in no file - last, named as such - not with the file of the line before it", () => {
    const lost = ["--- a/hubspot.plain", "+++ b/hubspot.plain", "@@ -1,2 +1,3 @@", " - :Provider: is a CRM.", "+- Written nowhere as it reads.", ""].join("\n");
    const files = diffFiles(lost, 60, undefined, locateDiffLines(lost, [own, common]));
    expect(files.map((file) => file.file)).toEqual([NOT_FOUND]);
  });

  it("puts a blank line the file does not have there with the line beside it, never with the lines found in no file", () => {
    const trailing = ["--- a/hubspot.plain", "+++ b/hubspot.plain", "@@ -1,2 +1,4 @@", " ***definitions***", " ", "+- :HubSpotMapping: is described in `[resource]resources/mapping.md`.", "+", ""].join("\n");
    // The file ends on the new line: the blank after it is the spec's, as read.
    const files = diffFiles(trailing, 60, undefined, locateDiffLines(trailing, [{ name: "hubspot.plain", text: own.text.trimEnd() }, common]));
    expect(files.map((file) => [file.file, file.added])).toEqual([["hubspot.plain", 2]]);
  });

  it("never lists a blank line under the lines found in no file - not even among lines placed nowhere", () => {
    const lonely = ["--- a/hubspot.plain", "+++ b/hubspot.plain", "@@ -1,2 +1,5 @@", "+", "+- Written nowhere as it reads.", "+", ""].join("\n");
    const files = diffFiles(lonely, 60, undefined, locateDiffLines(lonely, [own, common]));
    // The one line placed nowhere, alone; the blanks go with the file being rendered - which, with nothing but them, is not shown.
    expect(files.map((file) => [file.file, file.added])).toEqual([[NOT_FOUND, 1]]);
  });

  it("leaves out a file whose only change is a blank line", () => {
    const spaced = ["--- a/hubspot.plain", "+++ b/hubspot.plain", "@@ -1,2 +1,4 @@", " - :Provider: is a CRM.", "+", " ", "+- :HubSpotMapping: is described in `[resource]resources/mapping.md`.", ""].join("\n");
    const files = diffFiles(spaced, 60, undefined, locateDiffLines(spaced, [own, common]));
    // The blank after crm_common's line goes with it - and crm_common, with nothing else changed, is not shown.
    expect(files.map((file) => file.file)).toEqual(["hubspot.plain"]);
  });

  it("puts a removed line in the file of the line that replaces it", () => {
    const replaced = ["--- a/hubspot.plain", "+++ b/hubspot.plain", "@@ -1,3 +1,3 @@", " - :Provider: is a CRM.", " ", "-- :HubSpotMapping: was undescribed.", "+- :HubSpotMapping: is described in `[resource]resources/mapping.md`.", ""].join("\n");
    const files = diffFiles(replaced, 60, undefined, locateDiffLines(replaced, [own, common]));
    expect(files.map((file) => [file.file, file.added, file.removed])).toEqual([["hubspot.plain", 1, 1]]);
  });
});

describe("the colours a spec diff is painted in", () => {
  const fills = (row: string) => [...row.matchAll(/\x1b\[48;2;(\d+);(\d+);(\d+)m/g)].map((match) => match.slice(1).join(","));

  it("keeps the fill behind the whole row, whatever the colours inside it reset", () => {
    const dark = plainPaint({ appearance: "dark", getColorMode: () => "truecolor" });
    const row = dark.addedBand(`${dark.syntax("concept", ":User:")} and \x1b[0mafter a reset`);
    // Set at the start, and again after the reset, so the text after it is on the fill too.
    expect(fills(row)).toEqual(["31,77,46", "31,77,46"]);
    expect(row.endsWith("\x1b[49m")).toBe(true);
  });

  it("is a palette for a dark surface and one for a light, and the nearest of 256 colours where the terminal has no more", () => {
    const dark = plainPaint({ appearance: "dark", getColorMode: () => "truecolor" });
    const light = plainPaint({ appearance: "light", getColorMode: () => "truecolor" });
    expect(dark.syntax("concept", "x")).not.toBe(light.syntax("concept", "x"));
    expect(plainPaint({ appearance: "dark", getColorMode: () => "256color" }).syntax("concept", "x")).toMatch(/^\x1b\[38;5;\d+m/);
  });
});
