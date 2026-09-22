import { describe, expect, it } from "vitest";
import { buildRenderPrompt } from "../../src/render/prompt.ts";
import { listFrids, renderFunctionality, resolveTemplateDirs } from "../../src/render/render.ts";
import {
  ACCEPTANCE_TESTS,
  DEFINITIONS,
  FUNCTIONAL_REQUIREMENTS,
  NON_FUNCTIONAL_REQUIREMENTS,
  TEST_REQUIREMENTS,
} from "../../src/plain/spec.ts";

const SIMPLE = "tests/data/simple.plain";

describe("template directory resolution", () => {
  it("puts the plain file's own directory first", () => {
    const dirs = resolveTemplateDirs(SIMPLE);
    expect(dirs[0]).toMatch(/tests\/data$/);
  });

  it("picks up a sibling template directory when there is one", () => {
    const dirs = resolveTemplateDirs("tests/data/templates/code_variables.plain", [
      "tests/data/plainfileparser",
    ]);
    expect(dirs.some((dir) => dir.endsWith("tests/data/plainfileparser"))).toBe(true);
  });
});

describe("listFrids", () => {
  it("returns the module name and its functionality ids", () => {
    const { moduleName, frids } = listFrids(SIMPLE);
    expect(moduleName).toBe("simple");
    expect(frids).toEqual(["1"]);
  });
});

describe("buildRenderPrompt", () => {
  const specifications = {
    [DEFINITIONS]: ["- :App: is a console application."],
    [NON_FUNCTIONAL_REQUIREMENTS]: ["- :Implementation: should be in Python."],
    [TEST_REQUIREMENTS]: ["- Tests use unittest."],
    [FUNCTIONAL_REQUIREMENTS]: ["- Already built one.", "- Already built two.", "- Build this one."],
    [ACCEPTANCE_TESTS]: ["- It should exit 0."],
  };

  it("separates the target functionality from the ones already built", () => {
    const prompt = buildRenderPrompt({
      moduleName: "demo",
      frid: "3",
      specifications,
      linkedResources: [],
    });

    expect(prompt).toContain('<functionality id="3">\n- Build this one.\n</functionality>');
    expect(prompt).toContain("<already implemented>\n- Already built one.\n\n- Already built two.\n</already implemented>");
    // The target must not also appear as context.
    expect(prompt.split("- Build this one.")).toHaveLength(2);
  });

  it("includes every specification section and the acceptance tests", () => {
    const prompt = buildRenderPrompt({
      moduleName: "demo",
      frid: "3",
      specifications,
      linkedResources: [],
    });

    expect(prompt).toContain("<definitions>");
    expect(prompt).toContain("<implementation reqs>");
    expect(prompt).toContain("<test reqs>");
    expect(prompt).toContain("<acceptance tests>\n- It should exit 0.\n</acceptance tests>");
    expect(prompt).toContain("Implement functionality 3 and its unit tests.");
  });

  it("omits sections that are empty", () => {
    const prompt = buildRenderPrompt({
      moduleName: "demo",
      frid: "1",
      specifications: {
        [DEFINITIONS]: [],
        [NON_FUNCTIONAL_REQUIREMENTS]: ["- A req."],
        [TEST_REQUIREMENTS]: [],
        [FUNCTIONAL_REQUIREMENTS]: ["- The only one."],
      },
      linkedResources: [],
    });

    expect(prompt).not.toContain("<definitions>");
    expect(prompt).not.toContain("<test reqs>");
    expect(prompt).not.toContain("<already implemented>");
    expect(prompt).not.toContain("<acceptance tests>");
  });

  it("embeds linked resource contents", () => {
    const prompt = buildRenderPrompt({
      moduleName: "demo",
      frid: "1",
      specifications: {
        [DEFINITIONS]: [],
        [NON_FUNCTIONAL_REQUIREMENTS]: [],
        [TEST_REQUIREMENTS]: [],
        [FUNCTIONAL_REQUIREMENTS]: ["- Use the schema."],
      },
      linkedResources: [{ text: "schema.yaml", target: "a/schema.yaml", content: "kind: Example" }],
    });

    expect(prompt).toContain('<resource name="schema.yaml" path="a/schema.yaml">\nkind: Example\n</resource>');
  });
});

describe("renderFunctionality", () => {
  it("builds the prompt without starting an agent on a dry run", async () => {
    const result = await renderFunctionality({ plainFile: SIMPLE, frid: "1", dryRun: true });

    expect(result.moduleName).toBe("simple");
    expect(result.frid).toBe("1");
    expect(result.response).toBe("");
    expect(result.buildDir.endsWith("build/simple")).toBe(true);
    expect(result.prompt).toContain('<functionality id="1">\n- Simple functionality\n</functionality>');
    expect(result.prompt).toContain("- Simple implementation requirement");
  });

  it("defaults to the first functionality", async () => {
    const result = await renderFunctionality({ plainFile: SIMPLE, dryRun: true });
    expect(result.frid).toBe("1");
  });

  it("rejects an unknown functionality id and lists the real ones", async () => {
    await expect(renderFunctionality({ plainFile: SIMPLE, frid: "7", dryRun: true })).rejects.toThrow(
      "Functionality 7 does not exist. Available: 1.",
    );
  });

  it("rejects a file that is not a .plain file", async () => {
    await expect(renderFunctionality({ plainFile: "README.md", dryRun: true })).rejects.toThrow(
      "Expected a .plain file",
    );
  });
});
