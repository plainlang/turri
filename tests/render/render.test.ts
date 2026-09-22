import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_FILE } from "../../src/render/state.ts";
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
    expect(prompt).toContain(
      '<already implemented>\n<functionality id="1" status="implemented">\n- Already built one.\n</functionality>\n\n' +
        '<functionality id="2" status="implemented">\n- Already built two.\n</functionality>\n</already implemented>',
    );
    // The target must not also appear as context.
    expect(prompt.split("- Build this one.")).toHaveLength(2);
  });

  it("withholds the test reqs, which belong to conformance", () => {
    const prompt = buildRenderPrompt({
      moduleName: "demo",
      frid: "3",
      specifications,
      linkedResources: [],
    });

    expect(prompt).not.toContain("<test reqs>");
    expect(prompt).not.toContain("- Tests use unittest.");
  });

  it("includes the remaining specification sections and the acceptance tests", () => {
    const prompt = buildRenderPrompt({
      moduleName: "demo",
      frid: "3",
      specifications,
      linkedResources: [],
    });

    expect(prompt).toContain("<definitions>");
    expect(prompt).toContain("<implementation reqs>");
    expect(prompt).toContain("<acceptance tests>\n- It should exit 0.\n</acceptance tests>");
    expect(prompt).toContain("Implement functionality 3 and its unit tests - only functionality 3.");
  });

  it("says which functionalities are already implemented and that only the new one is the task", () => {
    const prompt = buildRenderPrompt({ moduleName: "demo", frid: "3", specifications, linkedResources: [] });

    expect(prompt).toContain("Functionalities 1 and 2 are already implemented");
    expect(prompt).toContain("Your task is functionality 3, and only functionality 3.");
    expect(prompt).toContain("Do not implement them again");
  });

  it("says nothing is implemented yet for the first functionality", () => {
    const prompt = buildRenderPrompt({
      moduleName: "demo",
      frid: "1",
      specifications: { ...specifications, [FUNCTIONAL_REQUIREMENTS]: ["- The first."] },
      linkedResources: [],
    });

    expect(prompt).toContain("Nothing is implemented yet: functionality 1 is the first");
    expect(prompt).not.toContain("Do not implement");
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
    expect(result.buildDir.endsWith("plain_modules/simple/code")).toBe(true);
    expect(result.prompt).toContain('<functionality id="1">\n- Simple functionality\n</functionality>');
    expect(result.prompt).toContain("- Simple implementation requirement");
  });

  it("writes no state on a dry run - nothing was built", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plainwright-dryrun-"));
    try {
      await renderFunctionality({ plainFile: SIMPLE, frid: "1", dryRun: true, buildDir: dir });
      expect(existsSync(join(dir, STATE_FILE))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
