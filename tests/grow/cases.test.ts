import { describe, expect, it } from "vitest";
import { codeCasesBlock, codeReviewCasesBlock, conformanceCasesBlock, conformanceReviewCasesBlock } from "../../src/grow/cases.ts";
import { buildConformancePrompt, buildSpecDiffPrompt } from "../../src/grow/prompt.ts";
import { unitReviewTask } from "../../src/grow/unit-review.ts";
import { testReviewTask } from "../../src/grow/conformance-agents.ts";
import type { JobCases } from "../../src/grow/drift.ts";

const none: JobCases = { fresh: false, add: [], patch: [], again: [], delete: [], mechanical: false };
const text = (lines: string[]) => lines.join("\n");

describe("what a job's agents are told, case by case, and nothing more", () => {
  const one = { frid: "1", text: "Users sign up." };
  /** Each case alone, and the words that are its own in each block: a job holding only it gets those, and no other case's. */
  const only: Array<{ name: string; cases: JobCases; code: string; review?: string; conformance?: string }> = [
    { name: "fresh", cases: { ...none, fresh: true }, code: "Nothing is built yet", conformance: "There are no conformance tests yet" },
    { name: "new", cases: { ...none, add: [one] }, code: "- New - build each", review: "- New:", conformance: "- New - write its conformance tests" },
    { name: "changed", cases: { ...none, patch: [one] }, code: "- Changed - its text, or a concept it uses", review: "- Changed:", conformance: "- Changed - its text, its acceptance tests" },
    { name: "grown again", cases: { ...none, again: [one] }, code: "- Grown again -", review: "- Grown again:" },
    { name: "taken out", cases: { ...none, delete: [one] }, code: "- Taken out - remove its code", review: "- Taken out:", conformance: "- Taken out - remove its conformance tests" },
    { name: "mechanical", cases: { ...none, mechanical: true }, code: "- No functional spec is touched", conformance: "- No functional spec is touched" },
  ];

  for (const { name, cases } of only) {
    it(`tells the agents of a job that is only ${name} what to do with it, and nothing of the other cases`, () => {
      const blocks = { code: text(codeCasesBlock(cases)), review: text(codeReviewCasesBlock(cases)), conformance: text(conformanceCasesBlock(cases)) };
      for (const other of only) {
        for (const block of ["code", "review", "conformance"] as const) {
          const words = other[block];
          if (words === undefined) continue;
          if (other.name === name) expect(blocks[block], `${name} ${block}`).toContain(words);
          else expect(blocks[block], `${name} ${block}: ${other.name}`).not.toContain(words);
        }
      }
    });
  }

  it("holds only a mechanical job's conformance tests to the mechanical review", () => {
    expect(conformanceReviewCasesBlock({ ...none, mechanical: true }).join("\n")).toContain("touches no functional spec");
    expect(conformanceReviewCasesBlock({ ...none, add: [one] })).toEqual([]);
  });
});

describe("what a job's agents are told, by its cases", () => {
  it("tells the coding agent, for each case, what to do with its functional specs - a section for each case the job holds", () => {
    const mixed = text(codeCasesBlock({ ...none, add: [{ frid: "3", text: "Users log out." }], patch: [{ frid: "1", text: "Users sign up." }], delete: [{ frid: "2", text: "Users rate." }] }));
    expect(mixed).toContain("New - build each, and write its unit tests: fs 3 (Users log out.)");
    expect(mixed).toContain("Changed - its text, or a concept it uses: fs 1 (Users sign up.)");
    expect(mixed).toContain("Do not build it again from scratch.");
    expect(mixed).toContain("Taken out - remove its code, and the unit tests only it had");
    expect(mixed).not.toContain("No functional spec is touched");
  });

  it("tells the coding agent to grow again what is built - its implementation replaced, not a second one beside it - and its reviewer to hold it to that", () => {
    const again = text(codeCasesBlock({ ...none, again: [{ frid: "2", text: "Users sign in." }] }));
    expect(again).toContain("Grown again - its code and unit tests are built, and are to be grown again: fs 2 (Users sign in.)");
    expect(again).toContain("no second implementation beside the old one");
    expect(again).not.toContain("New - build each");
    const review = text(codeReviewCasesBlock({ ...none, again: [{ frid: "2", text: "Users sign in." }] }));
    expect(review).toContain("Grown again: fs 2 (Users sign in.) - its implementation replaced, not patched beside the old one");
  });

  it("sets a fresh project up first, with its unit tests where the unit testing script runs them - no word of conformance", () => {
    const fresh = text(codeCasesBlock({ ...none, fresh: true, add: [{ frid: "1", text: "Say hello." }] }));
    expect(fresh).toContain("Nothing is built yet: set the project up first");
    expect(fresh).toContain("unit testing script");
    expect(fresh).not.toMatch(/conformance|testing scripts/);
  });

  it("writes no new tests in a mechanical job, and lets an existing one change only mechanically - never what it asserts", () => {
    const mechanical = text(codeCasesBlock({ ...none, mechanical: true }));
    expect(mechanical).toContain("Write no new tests.");
    expect(mechanical).toContain("never what it asserts");
    const prompt = buildSpecDiffPrompt({
      moduleName: "app",
      diff: "",
      specifications: { definitions: [], "implementation reqs": ["- :Implementation: is Python 3.13."], "test reqs": [], "functional specs": [] },
      required: [],
      linkedResources: [],
      empty: false,
      cases: { ...none, mechanical: true },
    });
    expect(prompt).toContain("Write no new tests.");
    // Nothing tells it otherwise.
    expect(prompt).not.toContain("then unit tests covering it");
  });

  it("holds a mechanical job's code to its reqs and its tests only to none removed or weakened - and the rest part by part", () => {
    const task = unitReviewTask({ buildDir: "/b", what: "the change", spec: "<spec>", forChange: true, cases: { ...none, mechanical: true } });
    expect(task).toContain("Raise no missing test");
    expect(task).not.toContain("Check that every behaviour the specification states for this work is tested");
    const parts = text(codeReviewCasesBlock({ ...none, add: [{ frid: "2", text: "Two." }], patch: [{ frid: "1", text: "One." }] }));
    expect(parts).toContain("New: fs 2 (Two.)");
    expect(parts).toContain("Changed: fs 1 (One.) - the code and its tests changed to match it now");
  });

  it("tells the conformance agent the same, for its tests - a fresh tests folder, new, changed and taken out, and mechanical", () => {
    const all = text(conformanceCasesBlock({ ...none, fresh: true, add: [{ frid: "1", text: "One." }], patch: [{ frid: "2", text: "Two." }], delete: [{ frid: "3", text: "Three." }] }));
    expect(all).toContain("There are no conformance tests yet: set the tests folder up first");
    expect(all).toContain("New - write its conformance tests: fs 1 (One.)");
    expect(all).toContain("rewrite them to what it says now");
    expect(all).toContain("Taken out - remove its conformance tests: fs 3 (Three.)");
    const mechanical = text(conformanceCasesBlock({ ...none, mechanical: true }));
    expect(mechanical).toContain("the change is to the test reqs, or to definitions or implementation reqs alone");
    expect(mechanical).toContain("Write no new tests.");
    expect(conformanceReviewCasesBlock({ ...none, add: [{ frid: "1", text: "One." }] })).toEqual([]);
  });

  it("puts the conformance cases in the conformance agent's prompt and a mechanical job's in its reviewer's", () => {
    const prompt = buildConformancePrompt({
      moduleName: "app",
      frid: "1",
      specifications: { definitions: [], "implementation reqs": [], "test reqs": ["- pytest."], "functional specs": ["- One."] },
      linkedResources: [],
      manifest: ["app.py"],
      diff: "+- One.",
      cases: { ...none, add: [{ frid: "1", text: "One." }] },
    } as never);
    expect(prompt).toContain("New - write its conformance tests: fs 1 (One.)");
    const review = testReviewTask({ buildDir: "/b", conformanceDir: "/t", spec: { moduleName: "app", text: "<spec>" } as never, functionalities: [], forChange: true, invocation: "run it", cases: { ...none, mechanical: true } });
    expect(review).toContain("Raise no missing test");
    expect(review).toContain("And, of every test the run changed:");
  });
});
