import { describe, expect, it } from "vitest";
import {
  marshallPlainSource,
  parsePlainSource,
  processAcceptanceTests,
} from "../../src/plain/parser.ts";
import {
  ACCEPTANCE_TESTS,
  FUNCTIONAL_REQUIREMENTS,
  NON_FUNCTIONAL_REQUIREMENTS,
  getSpecificationItems,
} from "../../src/plain/spec.ts";

/**
 * Regressions from running this parser against real specs.
 *
 * Every expected value here was taken from the Python implementation, not written by
 * hand: mdast and mistletoe disagree about inline decoding and list geometry in ways
 * that only real documents expose.
 */
function marshal(source: string) {
  const result = parsePlainSource(source, {}, [], [], []);
  processAcceptanceTests(result.plainSource);
  return marshallPlainSource(result.plainSource);
}

const first = (source: string, heading = NON_FUNCTIONAL_REQUIREMENTS) =>
  getSpecificationItems(marshal(source), heading)![0]!;

describe("markdown rendering fidelity", () => {
  it("keeps backslash escapes that mdast decodes", () => {
    const item = first(
      `***implementation reqs***\n- Convert to json strings (e.g., "{\\"key1\\":\\"value1\\"}").\n`,
    );
    expect(item.markdown).toBe('- Convert to json strings (e.g., "{\\"key1\\":\\"value1\\"}").');
  });

  it("keeps the emphasis delimiter the source used", () => {
    const item = first("***implementation reqs***\n- Path is <:Node: name>_<index>.csv and _stressed_ text.\n");
    expect(item.markdown).toBe("- Path is <:Node: name>_<index>.csv and _stressed_ text.");
  });

  it("indents nested lists by the item's prepend, not the column gap", () => {
    const marshalled = marshal(`***implementation reqs***
- Req.

***functional specs***
- Implement :Controller:
    - Initialize it.

    ***acceptance tests***
    - Use the listing.
        - The ctx should contain fileCount.
            - Deeper still.
`);

    const functionality = getSpecificationItems(marshalled, FUNCTIONAL_REQUIREMENTS)![0]!;
    expect(functionality.markdown).toBe("- Implement :Controller:\n    - Initialize it.");

    // The acceptance test is rendered detached from its functionality, but mistletoe
    // measures indentation against the coordinates it was parsed in, so the nested
    // levels keep 6 and 10 spaces rather than 4 and 8.
    expect(functionality[ACCEPTANCE_TESTS]![0]!.markdown).toBe(
      "- Use the listing.\n      - The ctx should contain fileCount.\n          - Deeper still.",
    );
  });

  it("does not double-indent lazy paragraph continuation lines", () => {
    const item = first(`***implementation reqs***
- Outer item.
    - Inner paragraph line.
        -NotABullet continues the paragraph.
            - Looks like a bullet but is lazy.
`);

    expect(item.markdown).toBe(
      "- Outer item.\n    - Inner paragraph line.\n      -NotABullet continues the paragraph.\n      - Looks like a bullet but is lazy.",
    );
  });
});
