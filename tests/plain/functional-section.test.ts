import { describe, expect, it } from "vitest";
import {
  countFunctionalSpecs,
  functionalSpecsText,
  FunctionalSpecError,
  withFunctionalSpec,
} from "../../src/plain/functional-section.ts";

const file = [
  "***definitions***",
  "",
  "- :User: is a person.",
  "",
  "***functional specs***",
  "",
  "- Health check at `GET /api/health`.",
  "  - Returns `200`.",
  "",
  "- A :User: can register.",
  "",
  "  ***acceptance tests***",
  "",
  "  - Registering twice returns `409`.",
  "",
].join("\n");

describe("the functional specs section", () => {
  it("appends a spec at the end and numbers it", () => {
    const { text, frid } = withFunctionalSpec(file, "- A :User: can log in.\n  - Returns a token.");
    expect(frid).toBe("3");
    expect(text.endsWith("  - Registering twice returns `409`.\n\n- A :User: can log in.\n  - Returns a token.\n")).toBe(true);
    expect(countFunctionalSpecs(text)).toBe(3);
  });

  it("keeps nested acceptance tests with the spec they belong to", () => {
    expect(countFunctionalSpecs(file)).toBe(2);
    const { text } = withFunctionalSpec(file, "- Health check at `GET /health`.", "1");
    expect(text).toContain("- Health check at `GET /health`.\n\n- A :User: can register.");
    expect(text).toContain("***acceptance tests***");
  });

  it("keeps a spec's acceptance tests when the spec is replaced", () => {
    const { text } = withFunctionalSpec(file, "- A :User: can sign up.", "2");
    expect(text).toContain("- A :User: can sign up.\n\n  ***acceptance tests***\n\n  - Registering twice returns `409`.");
  });

  it("appends before a section that follows", () => {
    const followed = `${file}***test reqs***\n\n- Use pytest.\n`;
    const { text } = withFunctionalSpec(followed, "- A :User: can log in.");
    expect(text).toContain("- A :User: can log in.\n\n***test reqs***");
  });

  it("creates the section when there is none", () => {
    const { text, frid } = withFunctionalSpec("***definitions***\n\n- :User: is a person.\n", "- Hello.");
    expect(frid).toBe("1");
    expect(text).toBe("***definitions***\n\n- :User: is a person.\n\n***functional specs***\n\n- Hello.\n");
  });

  it("refuses more than one spec in a call", () => {
    expect(() => withFunctionalSpec(file, "- One.\n- Two.")).toThrow(/2 functional specs/);
  });

  it("refuses text that is not a list item, or not indented under it", () => {
    expect(() => withFunctionalSpec(file, "A user can log in.")).toThrow(FunctionalSpecError);
    expect(() => withFunctionalSpec(file, "- One.\nnot indented")).toThrow(/not indented/);
  });

  it("refuses to replace a functionality that does not exist", () => {
    expect(() => withFunctionalSpec(file, "- X.", "5")).toThrow(/no functionality 5/);
  });

  it("does not count adding acceptance tests as changing the specs", () => {
    const withTest = file.replace(
      "  - Registering twice returns `409`.\n",
      "  - Registering twice returns `409`.\n  - A missing email returns `422`.\n",
    );
    expect(functionalSpecsText(withTest)).toBe(functionalSpecsText(file));

    const firstGetsTests = file.replace(
      "  - Returns `200`.\n",
      "  - Returns `200`.\n\n  ***acceptance tests***\n\n  - The body is `ok`.\n",
    );
    expect(functionalSpecsText(firstGetsTests)).toBe(functionalSpecsText(file));
    expect(functionalSpecsText(firstGetsTests.replace("Returns `200`", "Returns `204`"))).not.toBe(
      functionalSpecsText(file),
    );
  });

  it("tells whether an edit touched the section", () => {
    const definitionsOnly = file.replace(":User: is a person.", ":User: is a student.");
    expect(functionalSpecsText(definitionsOnly)).toBe(functionalSpecsText(file));
    expect(functionalSpecsText(file.replace("register", "sign up"))).not.toBe(functionalSpecsText(file));
  });
});
