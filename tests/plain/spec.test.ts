import { describe, expect, it } from "vitest";
import { plainFileParser } from "../../src/plain/parser.ts";
import {
  ACCEPTANCE_TESTS,
  DEFINITIONS,
  FUNCTIONAL_REQUIREMENTS,
  NON_FUNCTIONAL_REQUIREMENTS,
  TEST_REQUIREMENTS,
  collectLinkedResources,
  getFirstFrid,
  getFrids,
  getFridsBefore,
  getNextFrid,
  getPreviousFrid,
  getRenderRange,
  getRenderRangeFrom,
  getSpecificationsForFrid,
  hasAcceptanceTests,
  iterateFunctionalSpecs,
  type MarshalledPlainSource,
} from "../../src/plain/spec.ts";
import { InvalidFridArgument } from "../../src/plain/errors.ts";

const dataPath = (subfolder: string) => `tests/${subfolder}`;
const parseSimple = () => plainFileParser("simple.plain", [dataPath("data/")])[1];

/** Port of tests/test_plainspec.py. */
describe("plain spec", () => {
  it("rejects a non-object plain source tree", () => {
    expect(() => collectLinkedResources([] as unknown as MarshalledPlainSource, [], null, true)).toThrow(
      "plain_source_tree must be a dictionary.",
    );
  });

  it("detects acceptance tests", () => {
    const plainSource: MarshalledPlainSource = {
      [FUNCTIONAL_REQUIREMENTS]: [
        { markdown: "- First functionality." },
        {
          markdown: "- Second functionality.",
          [ACCEPTANCE_TESTS]: [{ markdown: "- Test the second functionality." }],
        },
      ],
    };
    expect(hasAcceptanceTests(plainSource)).toBe(true);
  });

  it("reports no acceptance tests when none are defined", () => {
    const plainSource: MarshalledPlainSource = {
      [FUNCTIONAL_REQUIREMENTS]: [
        { markdown: "- First functionality." },
        { markdown: "- Second functionality." },
      ],
    };
    expect(hasAcceptanceTests(plainSource)).toBe(false);
  });

  it("reports no acceptance tests when the list is empty", () => {
    const plainSource: MarshalledPlainSource = {
      [FUNCTIONAL_REQUIREMENTS]: [{ markdown: "- First functionality.", [ACCEPTANCE_TESTS]: [] }],
    };
    expect(hasAcceptanceTests(plainSource)).toBe(false);
  });

  it("reports no acceptance tests when there are no functional specs", () => {
    expect(hasAcceptanceTests({})).toBe(false);
  });

  it("yields the frids of a simple module", () => {
    expect([...getFrids(parseSimple())]).toEqual(["1"]);
  });

  it("returns the first frid", () => {
    expect(getFirstFrid(parseSimple())).toBe("1");
  });

  it("raises for the next frid of a missing functionality", () => {
    expect(() => getNextFrid(parseSimple(), "2")).toThrow("Functionality 2 does not exist.");
  });

  it("returns null for the next frid of the last functionality", () => {
    expect(getNextFrid(parseSimple(), "1")).toBeNull();
  });

  it("raises for the previous frid of a missing functionality", () => {
    expect(() => getPreviousFrid(parseSimple(), "2")).toThrow("Functionality 2 does not exist.");
  });

  it("returns null for the previous frid of the first functionality", () => {
    expect(getPreviousFrid(parseSimple(), "1")).toBeNull();
  });

  it("builds the specifications for a frid", () => {
    const plainSource = parseSimple();

    expect(() => getSpecificationsForFrid(plainSource, "a")).toThrow("Functionality a does not exist.");

    const frid = getFirstFrid(plainSource)!;
    const [specifications] = getSpecificationsForFrid(plainSource, frid);

    expect(specifications).toEqual({
      definitions: [],
      "implementation reqs": ["- Simple implementation requirement"],
      "test reqs": [],
      "functional specs": ["- Simple functionality"],
    });
  });
});

/**
 * The functional-spec iterator.
 *
 * `get_frids` numbers functionalities 1, 2, 3 in order, and `get_specifications_for_frid`
 * builds the context each one is rendered with: the definitions and reqs, every
 * functionality up to and including this one, and only this one's acceptance tests.
 */
describe("functional spec iterator", () => {
  const tree: MarshalledPlainSource = {
    [DEFINITIONS]: [{ markdown: "- :Root: is a concept." }],
    [NON_FUNCTIONAL_REQUIREMENTS]: [{ markdown: "- Root implementation req." }],
    [TEST_REQUIREMENTS]: [{ markdown: "- Root test req." }],
    [FUNCTIONAL_REQUIREMENTS]: [
      { markdown: "- Functionality one." },
      {
        markdown: "- Functionality two.",
        [ACCEPTANCE_TESTS]: [{ markdown: "- Check functionality two." }],
      },
      { markdown: "- Functionality three." },
      { markdown: "- Functionality four." },
    ],
  };

  it("numbers the functionalities in order", () => {
    expect([...getFrids(tree)]).toEqual(["1", "2", "3", "4"]);
  });

  it("walks frids forwards and backwards", () => {
    expect(getNextFrid(tree, "2")).toBe("3");
    expect(getPreviousFrid(tree, "3")).toBe("2");
    expect(getNextFrid(tree, "4")).toBeNull();
    expect(getFridsBefore(tree, "3")).toEqual(["1", "2"]);
  });

  it("includes only the functionalities up to the requested one", () => {
    const [specifications] = getSpecificationsForFrid(tree, "1");
    expect(specifications[FUNCTIONAL_REQUIREMENTS]).toEqual(["- Functionality one."]);
    expect(specifications[ACCEPTANCE_TESTS]).toBeUndefined();
  });

  it("includes the requested functionality's acceptance tests only", () => {
    const [specifications] = getSpecificationsForFrid(tree, "2");
    expect(specifications[FUNCTIONAL_REQUIREMENTS]).toEqual(["- Functionality one.", "- Functionality two."]);
    expect(specifications[ACCEPTANCE_TESTS]).toEqual(["- Check functionality two."]);
  });

  it("includes the module's definitions and reqs with every functionality", () => {
    const [specifications] = getSpecificationsForFrid(tree, "3");
    expect(specifications[DEFINITIONS]).toEqual(["- :Root: is a concept."]);
    expect(specifications[NON_FUNCTIONAL_REQUIREMENTS]).toEqual(["- Root implementation req."]);
    expect(specifications[TEST_REQUIREMENTS]).toEqual(["- Root test req."]);
  });

  it("iterates every functionality with its own context", () => {
    const iterated = [...iterateFunctionalSpecs(tree)];

    expect(iterated.map((entry) => entry.frid)).toEqual(["1", "2", "3", "4"]);
    expect(iterated.map((entry) => entry.specifications[FUNCTIONAL_REQUIREMENTS].length)).toEqual([1, 2, 3, 4]);

    for (const entry of iterated) {
      const [expected] = getSpecificationsForFrid(tree, entry.frid);
      expect(entry.specifications).toEqual(expected);
    }
  });

  it("substitutes code variables into the rendered context", () => {
    const withVariables: MarshalledPlainSource = {
      [FUNCTIONAL_REQUIREMENTS]: [
        {
          markdown: "- Implement {{ variable_name }}.",
          code_variables: [{ name: "variable_name", value: "nice" }],
        },
      ],
    };

    const [replaced, codeVariables] = getSpecificationsForFrid(withVariables, "1");
    expect(replaced[FUNCTIONAL_REQUIREMENTS]).toEqual(["- Implement nice."]);
    expect(codeVariables).toEqual({ variable_name: "nice" });

    const [kept] = getSpecificationsForFrid(withVariables, "1", false);
    expect(kept[FUNCTIONAL_REQUIREMENTS]).toEqual(["- Implement {{ variable_name }}."]);
  });

  it("computes render ranges over the frid sequence", () => {
    expect(getRenderRange("2,3", tree)).toEqual(["2", "3"]);
    expect(getRenderRange("3", tree)).toEqual(["3"]);
    expect(getRenderRangeFrom("3", tree)).toEqual(["3", "4"]);
    expect(() => getRenderRange("9", tree)).toThrow(InvalidFridArgument);
    expect(() => getRenderRange("3,1", tree)).toThrow(InvalidFridArgument);
  });
});

/** Linked resources are collected per functionality, which the iterator relies on. */
describe("collect_linked_resources", () => {
  it("collects resources up to the requested frid", () => {
    const [, plainSource] = plainFileParser("task_manager_with_reference_links.plain", [
      dataPath("data/plainfile"),
    ]);

    const all: Array<{ text: string; target: string; sections: string[] }> = [];
    collectLinkedResources(plainSource, all, null, true);
    expect(all.map((resource) => resource.text)).toEqual([
      "add_new_task_modal_specification.yaml",
      "task_list_ui_specification.yaml",
    ]);

    const upToSecond: Array<{ text: string; target: string; sections: string[] }> = [];
    collectLinkedResources(plainSource, upToSecond, null, true, "2");
    expect(upToSecond.map((resource) => resource.text)).toEqual(["task_list_ui_specification.yaml"]);
  });

  it("rejects an unknown frid", () => {
    const [, plainSource] = plainFileParser("simple.plain", [dataPath("data/")]);
    expect(() => collectLinkedResources(plainSource, [], null, true, "9")).toThrow(
      "frid 9 does not exist.",
    );
  });
});
