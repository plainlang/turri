import { describe, expect, it } from "vitest";
import { buildSpecDiffPrompt, describeSpecChange, reviewedSpec } from "../../src/regenerate/prompt.ts";
import { unitReviewTask } from "../../src/regenerate/unit-review.ts";
import { changesBetween, serializeTree } from "../../src/regenerate/spec-steps.ts";

const tree = (definitions: string[], reqs: string[], specs: string[]) => ({
  definitions: definitions.map((markdown) => ({ markdown })),
  "implementation reqs": reqs.map((markdown) => ({ markdown })),
  "functional specs": specs.map((markdown) => ({ markdown })),
});

describe("a functional spec regenerated again, as the coding agent reads it", () => {
  it("is told apart from a change - to regenerate again, with its text as it is now", () => {
    const marked = tree([], [], ["- Log in with a token.", "- Show the feed."]) as Record<string, unknown>;
    const specs = (marked["functional specs"] as Array<{ markdown: string }>).map((entry, index) => (index === 1 ? { ...entry, regenerate_again: true } : entry));
    const text = describeSpecChange(changesBetween(serializeTree({ ...marked, "functional specs": specs } as never), serializeTree(marked as never)));
    expect(text).toContain('<functional specs change="1 to regenerate again">');
    expect(text).toContain("To regenerate again - built already, and regenerated again:\n  functionality 2:\n    - Show the feed.");
    expect(text).not.toContain("before:");
  });
});

describe("a spec change, as the coding agent reads it", () => {
  const before = tree(["- :Api: is the API, described in `api.md`.", "- :Token: is a token."], ["- :Implementation: builds photo URLs from `photo_url`."], ["- Log in with :Token:."]);
  const after = tree(
    ["- :Page: is a page.", "- :Api: is the API, defined by `api.yaml`.", "- :Token: is a token for 7 days.", "- :Feed: is the list on :Page:."],
    ["- :Implementation: builds photo URLs from the `photo_url` of :Page:."],
    ["- Log in with :Token:.", "- Show :Feed: at `/`.\n  - Newest first."],
  );
  const text = describeSpecChange(changesBetween(serializeTree(before), serializeTree(after)));

  it("is told section by section, each with what was added, changed and removed", () => {
    expect(text).toMatch(/^<definitions change="2 added, 2 changed">\n/);
    expect(text).toContain('<implementation reqs change="1 changed">');
    expect(text).toContain('<functional specs change="1 added">');
    // Each section in its tag, closed - the tags every agent reads a spec in, never the ***headings*** of the file.
    for (const tag of ["definitions", "implementation reqs", "functional specs"]) expect(text).toContain(`</${tag}>`);
    expect(text).not.toContain("***");
  });

  it("names a changed definition by its concept, with its text before and now - a reworded one is not a removal and an addition", () => {
    expect(text).toContain(":Api:\n    before:\n      - :Api: is the API, described in `api.md`.\n    now:\n      - :Api: is the API, defined by `api.yaml`.");
    expect(text).toContain(":Token:\n    before:");
    expect(text).not.toContain("Removed:");
  });

  it("tells a new functional spec by its number, whole", () => {
    expect(text).toContain("  functionality 2:\n  - Show :Feed: at `/`.\n    - Newest first.");
  });

  it("lists every definition the change adds as added, marking none as needing no code", () => {
    expect(text).toContain("Added:\n  - :Page: is a page.\n  - :Feed: is the list on :Page:.");
    expect(text).not.toMatch(/no code|vocabulary/);
  });

  it("goes into the prompt in place of the raw diff", () => {
    const prompt = buildSpecDiffPrompt({
      moduleName: "app",
      diff: "@@ -1 +1 @@\n-raw\n+diff",
      changes: changesBetween(serializeTree(before), serializeTree(after)),
      specifications: { definitions: [], "implementation reqs": [], "test reqs": [], "functional specs": [] } as never,
      required: [],
      linkedResources: [],
      empty: false,
    });
    expect(prompt).toContain('<spec change>\n<definitions change="2 added, 2 changed">');
    expect(prompt).not.toContain("+diff");
  });

  it("is what the unit test review is shown too, told that behaviour is what a functional spec, an acceptance test or a req states", () => {
    const spec = reviewedSpec({ moduleName: "app", specifications: { definitions: [], "implementation reqs": [], "test reqs": [], "functional specs": [] } as never, change: text });
    const prompt = unitReviewTask({ buildDir: "/code", what: "the spec change to module `app`", spec, forChange: true });
    expect(prompt).toContain(`<new in this work>\n<spec change>\n${text}\n</spec change>\n</new in this work>`);
    expect(prompt).toContain("Behaviour is what a functional spec, an acceptance test or an implementation req states.");
    expect(prompt).toContain("a page, a component or a record that only <definitions> name");
  });
});

describe("a functional spec with acceptance tests, in a spec change", () => {
  // As the parser gives them: each acceptance test an item of its own, its text in its markdown.
  const withTests = (specs: Array<{ markdown: string; tests: string[] }>) => ({
    "functional specs": specs.map(({ markdown, tests }) => ({ markdown, acceptance_tests: tests.map((test) => ({ markdown: test })) })),
  });
  const before = withTests([{ markdown: "- A :Cube: is intersected by a :Ray:.", tests: ["- ray(point(5,0.5,0), vector(-1,0,0)) should give T 4 and 6."] }]);
  const after = withTests([
    { markdown: "- A :Cube: is intersected by a :Ray:.", tests: ["- ray(point(5,0.5,0), vector(-1,0,0)) should give T 4 and 6.", "- ray(point(2,2,0), vector(0,0,-1)) should give no intersections."] },
    { markdown: "- A :Cube: has a normal on each face.", tests: ["- The normal at (1,0.5,-0.8) should be (1,0,0)\n  and at (-1,-0.2,0.9) should be (-1,0,0)."] },
  ]);
  const text = describeSpecChange(changesBetween(serializeTree(before as never), serializeTree(after as never)));

  it("shows each acceptance test's text, never the object it is parsed into", () => {
    expect(text).not.toContain("[object Object]");
    expect(text).toContain("      <acceptance tests>\n        - ray(point(5,0.5,0), vector(-1,0,0)) should give T 4 and 6.\n        - ray(point(2,2,0), vector(0,0,-1)) should give no intersections.");
  });

  it("keeps an acceptance test of several lines under its tag, each line indented", () => {
    expect(text).toContain("  <acceptance tests>\n    - The normal at (1,0.5,-0.8) should be (1,0,0)\n      and at (-1,-0.2,0.9) should be (-1,0,0).\n    </acceptance tests>");
  });
});
