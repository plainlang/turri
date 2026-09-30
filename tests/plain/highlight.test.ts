import { describe, expect, it } from "vitest";
import { highlightLines, roleOf } from "../../src/plain/highlight.ts";

/** Each line as its pieces and what each is: `text|role`, nothing as `-`. */
const read = (lines: string[]) => highlightLines(lines).map((tokens) => tokens.map((token) => `${token.text}|${roleOf(token.scopes) ?? "-"}`));

describe("***plain, highlighted as plyn highlights it", () => {
  it("tells a section's header, a concept, a name in backticks, text in quotes, a link and a comment apart", () => {
    expect(read(["***functional specs***", '- :User: sets `HUBSPOT_TOKEN` to "on", as [the docs](docs/a.md) say.', "> not built"])).toEqual([
      ["***functional specs***|section"],
      ["-|bullet", " |-", ":User:|concept", " sets |-", "`HUBSPOT_TOKEN`|literal", " to |-", '"on"|literal', ", as |-", "[the docs](docs/a.md)|link", " say.|-"],
      ["> not built|comment"],
    ]);
  });

  it("carries the front matter from the line that opens it to the one that closes it - its keys and the modules it names", () => {
    expect(read(["---", "import:", "  - crm_common", "requires:", "  - base", "---", "import: is text again"])).toEqual([
      ["---|-"],
      ["import:|keyword"],
      ["  - |-", "crm_common|module"],
      ["requires:|keyword"],
      ["  - |-", "base|module"],
      ["---|-"],
      ["import: is text again|-"],
    ]);
  });

  it("leaves text with nothing in it as it is", () => {
    expect(read(["Plain words.", ""])).toEqual([["Plain words.|-"], []]);
  });
});
