import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_FILE } from "../../src/render/state.ts";
import { describe, expect, it } from "vitest";
import { buildConformancePrompt, buildRegressionFixPrompt, buildRenderPrompt } from "../../src/render/prompt.ts";
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

    expect(prompt).toContain('<functionality module="demo" id="3">\n- Build this one.\n</functionality>');
    expect(prompt).toContain(
      '<already implemented>\n<module name="demo" role="current">\n<functionality module="demo" id="1" status="implemented">\n- Already built one.\n</functionality>\n\n' +
        '<functionality module="demo" id="2" status="implemented">\n- Already built two.\n</functionality>\n</module>\n</already implemented>',
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

    expect(prompt).toContain("Nothing of `demo` is implemented yet: functionality 1 is its first.");
    expect(prompt).not.toContain("Do not implement");
  });

  it("lists the required modules' functional specs first, as already implemented", () => {
    const prompt = buildRenderPrompt({
      moduleName: "demo",
      frid: "2",
      specifications: { ...specifications, [FUNCTIONAL_REQUIREMENTS]: ["- Mine one.", "- Mine two."] },
      linkedResources: [],
      required: [
        { module: "c", frid: "1", spec: "- From c." },
        { module: "b", frid: "1", spec: "- From b." },
      ],
    });

    const c = prompt.indexOf('<functionality module="c" id="1" status="implemented">\n- From c.');
    const b = prompt.indexOf('<functionality module="b" id="1" status="implemented">\n- From b.');
    const mine = prompt.indexOf('<functionality module="demo" id="1" status="implemented">\n- Mine one.');
    expect(c).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(c);
    expect(mine).toBeGreaterThan(b);
    expect(prompt).toContain("It builds on `c` and `b`, whose 2 functional specs are implemented in this codebase too");
    expect(prompt).toContain("Functionality 1 and the functionalities of c and b exist. Do not implement them");
  });

  it("tells the first functionality of a requiring module what it builds on", () => {
    const prompt = buildRenderPrompt({
      moduleName: "demo",
      frid: "1",
      specifications: { ...specifications, [FUNCTIONAL_REQUIREMENTS]: ["- Mine one."] },
      linkedResources: [],
      required: [{ module: "b", frid: "1", spec: "- From b." }],
    });
    expect(prompt).toContain("Nothing of `demo` is implemented yet: functionality 1 is its first. It builds on `b`");
    expect(prompt).toContain("The functionalities of b exist. Do not implement them again");
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
    expect(result.prompt).toContain('<functionality module="simple" id="1">\n- Simple functionality\n</functionality>');
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

describe("what the other agents are told is already implemented", () => {
  const specifications = {
    [DEFINITIONS]: ["- :App: is a console application."],
    [NON_FUNCTIONAL_REQUIREMENTS]: ["- :Implementation: should be in Python."],
    [TEST_REQUIREMENTS]: ["- Tests use unittest."],
    [FUNCTIONAL_REQUIREMENTS]: ["- Mine one.", "- Mine two."],
    [ACCEPTANCE_TESTS]: ["- It should exit 0."],
  };
  const required = [
    { module: "c", frid: "1", spec: "- From c." },
    { module: "b", frid: "1", spec: "- From b." },
  ];

  function inOrder(prompt: string) {
    const c = prompt.indexOf('<functionality module="c" id="1" status="implemented">');
    const b = prompt.indexOf('<functionality module="b" id="1" status="implemented">');
    const mine = prompt.indexOf('<functionality module="demo" id="1" status="implemented">\n- Mine one.');
    return c > -1 && b > c && mine > b;
  }

  it("the conformance test writer: context to set up from, with only the target under test", () => {
    const prompt = buildConformancePrompt({
      moduleName: "demo", frid: "2", specifications, linkedResources: [], manifest: ["app.py"], required,
    });
    expect(inOrder(prompt)).toBe(true);
    expect(prompt).toContain('<functionality module="demo" id="2">\n- Mine two.\n</functionality>');
    expect(prompt).not.toContain('module="demo" id="2" status="implemented"');
    expect(prompt).toContain("Test functionality 2 only.");
  });

  it("the regression repairer: every functionality in the code, required modules included", () => {
    const prompt = buildRegressionFixPrompt({
      moduleName: "demo", frids: ["1", "2"], specifications, required, failure: "exit 1",
    });
    expect(inOrder(prompt)).toBe(true);
    expect(prompt).toContain('<functionality module="demo" id="2" status="implemented">\n- Mine two.');
  });
});

describe("how to read the specification", () => {
  it("leads every coding prompt: the sections, and the predefined concepts that are never in the definitions", async () => {
    const { buildRenderPrompt, specPrimer } = await import("../../src/render/prompt.ts");
    const prompt = buildRenderPrompt({
      moduleName: "app",
      frid: "1",
      specifications: { definitions: [], "implementation reqs": ["- :Implementation: uses FastAPI."], "test reqs": [], "functional specs": ["- Say hello."] },
      linkedResources: [],
    });
    expect(prompt.startsWith("<how to read the specification>")).toBe(true);
    expect(prompt).toContain(":Implementation: - the system that implements :plainFunctionality:.");
    expect(prompt).toContain("They carry the same authority as the");
    expect(prompt).toContain("defined in the definitions, or predefined");
    expect(prompt).toContain("mock or stub the system under test to hide a failure");
    // The coding agent is told the test reqs exist, and that they are not its.
    expect(specPrimer({ testReqs: false })).toContain("They are not given\n  to you");
    expect(specPrimer({ testReqs: true })).not.toContain("They are not given");
  });
});

describe("functionalities, by the module they belong to", () => {
  it("are grouped under their module, in the order the modules are built on each other, the current one marked", async () => {
    const { buildRenderPrompt, functionalitiesByModule } = await import("../../src/render/prompt.ts");
    const prompt = buildRenderPrompt({
      moduleName: "top",
      frid: "2",
      specifications: { definitions: [], "implementation reqs": [], "test reqs": [], "functional specs": ["- Top one.", "- Top two."] },
      linkedResources: [],
      required: [
        { module: "base", frid: "1", spec: "- Base one." },
        { module: "base", frid: "3", spec: "- Base three." },
      ],
    });
    // The first listed is base's 1, then base's 3, then top's 1 - each with its module, never a bare number.
    expect(prompt).toContain(
      '<already implemented>\n<module name="base">\n<functionality module="base" id="1" status="implemented">\n- Base one.\n</functionality>\n\n' +
        '<functionality module="base" id="3" status="implemented">\n- Base three.\n</functionality>\n</module>\n\n' +
        '<module name="top" role="current">\n<functionality module="top" id="1" status="implemented">\n- Top one.\n</functionality>\n</module>\n</already implemented>',
    );
    // The one to build, with its module too.
    expect(prompt).toContain('<functionality module="top" id="2">\n- Top two.\n</functionality>');
    expect(prompt).toContain("functionality 1 of `base` and functionality 1 of `app` are two");

    // Regenerating base in top's codebase: top is built on base, so it comes after, and base is the current one.
    expect(
      functionalitiesByModule(
        [
          { module: "base", frid: "1", spec: "- Base one." },
          { module: "top", frid: "1", spec: "- Top one." },
        ],
        "base",
      ),
    ).toMatch(/^<module name="base" role="current">[\s\S]*<module name="top">/);
  });
});

describe("the build's identity, and the code's build files", () => {
  it("never loses why something failed: every coding agent keeps the cause, the judge blames code that hides it, and the fixer makes it show first", async () => {
    const { buildRenderPrompt } = await import("../../src/render/prompt.ts");
    const { codeFixPrompt, judgePrompt } = await import("../../src/render/conformance-agents.ts");
    const specifications = { definitions: [], "implementation reqs": [], "test reqs": ["- pytest."], "functional specs": ["- Take an order."] };
    const run = { command: "c", exitCode: 1, output: '{"error": "failed"}', timeoutMs: 1 };
    const render = buildRenderPrompt({ moduleName: "app", frid: "1", specifications, linkedResources: [] });
    expect(render).toContain("Never lose why something failed");
    expect(render).toContain("Never make the code behave differently when a test runs it");
    const fix = codeFixPrompt({ buildDir: "/b", spec: { moduleName: "app", text: "- Take an order." }, run, reason: "r", first: true });
    expect(fix).toContain("Never lose why something failed");
    expect(fix).toContain("make it show first");
    const judge = judgePrompt({ buildDir: "/b", conformanceDir: "/t", spec: { moduleName: "app", text: "- Take an order." }, run, invocation: "i", scope: { functionalities: [] }, notes: "" });
    expect(judge).toContain("the code is what is wrong first: it hides the cause");
  });

  it("is kept by every agent that writes code, and handed whole to the conformance agent", async () => {
    const { buildRenderPrompt, buildConformancePrompt } = await import("../../src/render/prompt.ts");
    const { codeFixPrompt } = await import("../../src/render/conformance-agents.ts");
    const { buildManifests } = await import("../../src/render/conformance.ts");
    const specifications = { definitions: [], "implementation reqs": [], "test reqs": ["- pytest."], "functional specs": ["- Take an order."] };
    const render = buildRenderPrompt({ moduleName: "app", frid: "1", specifications, linkedResources: [] });
    expect(render).toContain("Keep the build's identity as it is: its name, coordinates, version, package and main class.");
    const fix = codeFixPrompt({ buildDir: "/b", spec: { moduleName: "app", text: "- Take an order." }, run: { command: "c", exitCode: 1, output: "x", timeoutMs: 1 }, reason: "r", first: true });
    expect(fix).toContain("Keep the build's identity as it is");

    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "plainwright-manifests-"));
    writeFileSync(join(dir, "pyproject.toml"), "[project]\nname = \"orders-app\"\nversion = \"1.0.0\"\n");
    writeFileSync(join(dir, "App.java"), "class App {}\n");
    const manifests = buildManifests(dir);
    rmSync(dir, { recursive: true, force: true });
    // Only the build files - never the code.
    expect(manifests.map((manifest) => manifest.path)).toEqual(["pyproject.toml"]);
    const conformance = buildConformancePrompt({ moduleName: "app", frid: "1", specifications, linkedResources: [], manifest: [], invocation: "java -jar app.jar", manifests });
    expect(conformance).toContain('<code build file path="pyproject.toml">\n[project]\nname = "orders-app"\nversion = "1.0.0"\n</code build file>');
    expect(conformance).toContain("never guess them, and never take them from a folder or module name");
    // A failure of the software itself is not the tests' to work around; and three runs a turn.
    expect(conformance).toContain("the tests are not what is wrong: do not work around it in them");
    expect(conformance).toContain("You can run the suite three times a turn with run_conformance_tests. The third ends your turn");
    // The coding agent can run the suite too, to reproduce the failure and check its fix.
    expect(fix).toContain("run_conformance_tests runs the project's conformance testing");
  });
});
