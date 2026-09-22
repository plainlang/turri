import { describe, expect, it } from "vitest";
import {
  isAcceptanceTestHeading,
  plainFileParser,
  processAcceptanceTests,
  processSingleAcceptanceTestRequirement,
  type ParsedPlainSource,
} from "../../src/plain/parser.ts";
import { parseMarkdown, type AnyNode } from "../../src/plain/markdown.ts";
import { ACCEPTANCE_TESTS, FUNCTIONAL_REQUIREMENTS } from "../../src/plain/spec.ts";
import { PlainSyntaxError } from "../../src/plain/errors.ts";

/**
 * Port of tests/test_plainfile.py.
 *
 * The Python tests drive these functions with MagicMock tokens and patch the inner
 * helper to count calls. ESM modules cannot be patched that way from outside, so each
 * test here builds a real AST from markdown and asserts the same observable outcome:
 * what ends up on `acceptance_tests`, what is left in `children`, and what raises.
 */

/** The single list item parsed from a markdown list. */
function listItem(markdown: string): AnyNode {
  const document = parseMarkdown(markdown);
  const list = (document.children ?? [])[0]!;
  return (list.children ?? [])[0]!;
}

const FUNCTIONALITY_WITH_ACCEPTANCE_TESTS = `- Implement the entry point for the app

    ***acceptance tests***

    - The App shouldn't show logging output.
`;

describe("process_acceptance_tests", () => {
  it("returns early when the functional specs key is missing", () => {
    const plainSource: ParsedPlainSource = {};
    expect(() => processAcceptanceTests(plainSource)).not.toThrow();
    expect(plainSource).toEqual({});
  });

  it("returns early when the functional specs section is null", () => {
    const plainSource: ParsedPlainSource = { [FUNCTIONAL_REQUIREMENTS]: null };
    expect(() => processAcceptanceTests(plainSource)).not.toThrow();
    expect(plainSource[FUNCTIONAL_REQUIREMENTS]).toBeNull();
  });

  it("processes every functionality that has children", () => {
    const withChildren1 = listItem(FUNCTIONALITY_WITH_ACCEPTANCE_TESTS);
    const withoutChildren: AnyNode = { type: "listItem" };
    const withChildren2 = listItem(FUNCTIONALITY_WITH_ACCEPTANCE_TESTS);

    const plainSource: ParsedPlainSource = {
      [FUNCTIONAL_REQUIREMENTS]: { children: [withChildren1, withoutChildren, withChildren2] },
    };

    processAcceptanceTests(plainSource);

    expect(withChildren1[ACCEPTANCE_TESTS]).toHaveLength(1);
    expect(withChildren2[ACCEPTANCE_TESTS]).toHaveLength(1);
    expect(withoutChildren[ACCEPTANCE_TESTS]).toBeUndefined();
  });
});

describe("process_single_acceptance_test_requirement", () => {
  it("leaves a functionality alone when no acceptance tests are present", () => {
    const functionalRequirement = listItem("- Just a functionality\n\n    And a second paragraph.\n");
    const originalChildren = [...(functionalRequirement.children ?? [])];

    processSingleAcceptanceTestRequirement(functionalRequirement);

    expect(functionalRequirement[ACCEPTANCE_TESTS]).toBeUndefined();
    expect(functionalRequirement.children).toEqual(originalChildren);
  });

  it("handles a functionality with no children", () => {
    const functionalRequirement: AnyNode = { type: "listItem", children: [] };

    processSingleAcceptanceTestRequirement(functionalRequirement);

    expect(functionalRequirement[ACCEPTANCE_TESTS]).toBeUndefined();
    expect(functionalRequirement.children).toEqual([]);
  });

  it("keeps both tokens when the heading is not followed by a list", () => {
    const functionalRequirement = listItem(
      "- A functionality\n\n    ***acceptance tests***\n\n    Not a list, just a paragraph.\n",
    );
    const originalChildren = [...(functionalRequirement.children ?? [])];

    processSingleAcceptanceTestRequirement(functionalRequirement);

    expect(functionalRequirement[ACCEPTANCE_TESTS]).toBeUndefined();
    expect(functionalRequirement.children).toHaveLength(originalChildren.length);
    expect(functionalRequirement.children).toEqual(originalChildren);
  });

  it("extracts valid acceptance tests", () => {
    const functionalRequirement = listItem(FUNCTIONALITY_WITH_ACCEPTANCE_TESTS);
    const content = functionalRequirement.children![0]!;
    const list = functionalRequirement.children![2]!;

    const [isHeading, problem] = isAcceptanceTestHeading(functionalRequirement.children![1]!);
    expect(isHeading).toBe(true);
    expect(problem).toBeNull();

    processSingleAcceptanceTestRequirement(functionalRequirement);

    expect(functionalRequirement[ACCEPTANCE_TESTS]).toHaveLength(1);
    expect(functionalRequirement[ACCEPTANCE_TESTS]![0]).toBe((list.children ?? [])[0]);

    // Only the functionality's own content is left behind.
    expect(functionalRequirement.children).toHaveLength(1);
    expect(functionalRequirement.children![0]).toBe(content);
  });

  it("rejects an invalid acceptance test heading", () => {
    const functionalRequirement = listItem(
      "- A functionality\n\n    ***Acceptance test***\n\n    - Some test.\n",
    );

    const [isHeading, problem] = isAcceptanceTestHeading(functionalRequirement.children![1]!);
    expect(isHeading).toBe(false);
    expect(problem).not.toBeNull();

    expect(() => processSingleAcceptanceTestRequirement(functionalRequirement)).toThrow(PlainSyntaxError);
  });

  it("rejects a duplicate acceptance tests heading", () => {
    const functionalRequirement = listItem(
      `- Implement the entry point for the app

    ***acceptance tests***

    - First acceptance test

    ***acceptance tests***

    - Second acceptance test
`,
    );

    const secondHeading = functionalRequirement.children![3]!;
    const line = secondHeading.position!.start.line;

    expect(() => processSingleAcceptanceTestRequirement(functionalRequirement)).toThrow(
      `Plain syntax error: Syntax error at line ${line}: Duplicate 'acceptance tests' heading found within ` +
        "the same functionality. Only one block of acceptance tests is allowed per functionality.",
    );
  });
});

describe("plain_file_parser", () => {
  it("rejects an invalid plain file extension", () => {
    expect(() => plainFileParser("test.txt", [])).toThrow(PlainSyntaxError);
  });
});
