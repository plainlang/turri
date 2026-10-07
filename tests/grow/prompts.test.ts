import { describe, expect, it } from "vitest";
import { buildConformancePrompt, buildRegressionFixPrompt, buildSpecDiffPrompt, type SpecDiffPromptInput } from "../../src/grow/prompt.ts";
import { resolveTemplateDirs } from "../../src/grow/paths.ts";
import {
  ACCEPTANCE_TESTS,
  DEFINITIONS,
  FUNCTIONAL_REQUIREMENTS,
  NON_FUNCTIONAL_REQUIREMENTS,
  TEST_REQUIREMENTS,
} from "../../src/plain/spec.ts";

const SIMPLE = "tests/data/simple.plain";

/** The coding agent's prompt for a change that adds functionality 2 of `demo`. */
function codingPrompt(overrides: Partial<SpecDiffPromptInput> = {}): string {
  return buildSpecDiffPrompt({
    moduleName: "demo",
    diff: "@@ -1 +1,3 @@\n - Mine one.\n+\n+- Mine two.",
    specifications: {
      [DEFINITIONS]: ["- :App: is a console application."],
      [NON_FUNCTIONAL_REQUIREMENTS]: ["- :Implementation: should be in Python."],
      [TEST_REQUIREMENTS]: ["- Tests use unittest."],
      [FUNCTIONAL_REQUIREMENTS]: ["- Mine one."],
    },
    required: [],
    linkedResources: [],
    empty: false,
    cases: { fresh: false, add: [{ frid: "2", text: "Mine two." }], patch: [], again: [], delete: [], mechanical: false },
    ...overrides,
  });
}

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

describe("the coding agent's prompt", () => {
  it("withholds the test reqs, which belong to conformance", () => {
    const prompt = codingPrompt();
    expect(prompt).not.toContain("<test reqs>\n");
    expect(prompt).not.toContain("- Tests use unittest.");
  });

  it("lists the required modules' functional specs first, as already implemented, and the module's own after them", () => {
    const prompt = codingPrompt({
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
  });

  it("omits sections that are empty", () => {
    const prompt = codingPrompt({ specifications: { [DEFINITIONS]: [], [NON_FUNCTIONAL_REQUIREMENTS]: ["- A req."], [TEST_REQUIREMENTS]: [], [FUNCTIONAL_REQUIREMENTS]: [] } });
    // The primer names every section's tag; an empty section's own tag is not there.
    expect(prompt).not.toContain("<definitions>\n");
    expect(prompt).not.toContain("<test reqs>\n");
    expect(prompt).not.toContain("<already implemented>\n");
    expect(prompt).not.toContain("<acceptance tests>\n");
  });

  it("embeds linked resource contents, each with the one place in the codebase a copy of it goes", () => {
    const prompt = codingPrompt({ linkedResources: [{ text: "schema.yaml", target: "a/schema.yaml", content: "kind: Example" }] });
    expect(prompt).toContain('<resource name="schema.yaml" path="a/schema.yaml" code-copy="a/schema.yaml">\nkind: Example\n</resource>');
  });

  it("marks a linked resource that is code as code, with no place for a copy of it - it lives elsewhere, and is built on", () => {
    const prompt = codingPrompt({ linkedResources: [{ text: "ingest.py", target: "../src/services/ingest.py", content: "def discover_integrations(): ..." }] });
    expect(prompt).toContain('<resource name="ingest.py" path="../src/services/ingest.py" kind="code">');
    expect(prompt).not.toContain('code-copy="src/services/ingest.py"');
    expect(prompt).toContain("never copy it, nor recreate it or what it belongs to");
  });

  it("says a linked resource is not in the workspace, and that the code keeps at most one copy, where code-copy says", () => {
    const prompt = codingPrompt({ linkedResources: [{ text: "version.json", target: "../resources/version/version.json", content: "{}" }] });
    expect(prompt).toContain('code-copy="resources/version/version.json"');
    expect(prompt).toContain("A linked resource is not in your workspace.");
    expect(prompt).toContain("exactly one copy");
    // An image is looked at, never copied.
    const image = codingPrompt({ linkedResources: [{ text: "mockup.png", target: "mockup.png", content: "[an image]", image: { mimeType: "image/png", data: "" } as never }] });
    expect(image).toContain('<resource name="mockup.png" path="mockup.png" type="image/png">');
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
    expect(prompt).toContain("Test functionality 2 of module `demo` only.");
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
    const { specPrimer } = await import("../../src/grow/prompt.ts");
    const prompt = codingPrompt();
    expect(prompt.startsWith("<how to read the specification>")).toBe(true);
    expect(prompt).toContain(":Implementation: - the system that implements :plainFunctionality:.");
    expect(prompt).toContain("They carry the same authority as the");
    // What a concept is, the primer says once: the rules after it do not say it again.
    expect(prompt).toContain("Predefined concepts - used in every specification without being defined in it:");
    expect(prompt).not.toContain("defined in <definitions>, or predefined");
    // Every section is named by its tag, one name each: never by its ***heading*** as well.
    for (const tag of ["<definitions>", "<implementation reqs>", "<test reqs>", "<functional specs>", "<acceptance tests>", "<linked resources>", "<spec change>"]) {
      expect(specPrimer({ testReqs: false })).toContain(`- ${tag}: `);
    }
    expect(specPrimer({ testReqs: false })).not.toMatch(/\*\*\*(definitions|implementation reqs|test reqs|functional specs|acceptance tests)\*\*\*/);
    expect(prompt).toContain("mock or stub the system under test to hide a failure");
    // The coding agent is told the test reqs exist, and that they are not its.
    expect(specPrimer({ testReqs: false })).toContain("They are not given to you");
    expect(specPrimer({ testReqs: true })).not.toContain("They are not given");
  });
});

describe("the spec, by the module each part belongs to", () => {
  it("groups every section under the module each item is of - a module below by its name, the current one marked", async () => {
    const { sectionModules } = await import("../../src/grow/prompt.ts");
    const tree = {
      [DEFINITIONS]: [{ markdown: "- :User: is a person.", module: "base" }, { markdown: "- :Comment: is a text." }],
      [NON_FUNCTIONAL_REQUIREMENTS]: [{ markdown: "- :Implementation: is Python.", module: "base" }],
    } as never;
    const prompt = codingPrompt({
      moduleName: "app",
      specifications: { [DEFINITIONS]: ["- :User: is a person.", "- :Comment: is a text."], [NON_FUNCTIONAL_REQUIREMENTS]: ["- :Implementation: is Python."], [TEST_REQUIREMENTS]: [], [FUNCTIONAL_REQUIREMENTS]: [] },
      modules: sectionModules(tree, "app"),
    });
    expect(prompt).toContain('<definitions>\n<module name="base">\n- :User: is a person.\n</module>\n\n<module name="app" role="current">\n- :Comment: is a text.\n</module>\n</definitions>');
    expect(prompt).toContain('<implementation reqs>\n<module name="base">\n- :Implementation: is Python.\n</module>\n</implementation reqs>');
  });

  it("says modules are how the spec is written, not how the code is laid out - one codebase, organised as the implementation reqs say", async () => {
    const { specPrimer } = await import("../../src/grow/prompt.ts");
    const primer = specPrimer({ testReqs: false });
    expect(primer).toContain("Modules are how the");
    expect(primer).toContain("You work only in the codebase of the current module");
    expect(primer).toContain("Organise and write the code as the <implementation reqs> say");
  });
});

describe("functionalities, by the module they belong to", () => {
  it("are grouped under their module, in the order the modules are built on each other, the current one marked", async () => {
    const prompt = codingPrompt({
      moduleName: "top",
      specifications: { [DEFINITIONS]: [], [NON_FUNCTIONAL_REQUIREMENTS]: [], [TEST_REQUIREMENTS]: [], [FUNCTIONAL_REQUIREMENTS]: ["- Top one."] },
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

    // Regenerating base in top's codebase: top is built on base, so it comes after, and base is the current one.
    const { functionalitiesByModule } = await import("../../src/grow/prompt.ts");
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
  it("sends every failure back with how to fix it: understand, find the root cause, reproduce, fix, check the whole suite, note it", async () => {
    const { scriptFailure } = await import("../../src/grow/test-scripts.ts");
    const { codeFixerTask, testsFixPrompt } = await import("../../src/grow/conformance-agents.ts");
    const run = { command: "run_unittests.sh", exitCode: 1, output: "FAILED test_app.py::test_x - AssertionError", timeoutMs: 1 };
    const prompts = [
      scriptFailure(run, "unit testing"),
      scriptFailure(run, "conformance testing"),
      testsFixPrompt({ run, reason: "The test expects 400; the spec says nothing of it." }),
      codeFixerTask({ buildDir: "/b", spec: { moduleName: "app", text: "- Take an order." } }),
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain("1. Understand the failure.");
      expect(prompt).toContain("2. Find where it comes from.");
      expect(prompt).toContain("3. Reproduce it:");
      expect(prompt).toContain("4. Fix the cause, in the");
      expect(prompt).toContain("5. Check the fix:");
      expect(prompt).toContain("6. Leave in your notes what the cause was");
    }
    expect(prompts[0]).toContain("run just that test with bash - one file, one case");
    expect(prompts[0]).toContain("then the whole suite with run_unit_tests");
    expect(prompts[2]).toContain("4. Fix the cause, in the tests");
    expect(prompts[3]).toContain("4. Fix the cause, in the code");
  });

  it("never loses why something failed: every coding agent keeps the cause, the judge blames code that hides it, and the fixer makes it show first", async () => {
    const { codeFixerTask, judgePrompt } = await import("../../src/grow/conformance-agents.ts");
    const specifications = { definitions: [], "implementation reqs": [], "test reqs": ["- pytest."], "functional specs": ["- Take an order."] };
    const run = { command: "c", exitCode: 1, output: '{"error": "failed"}', timeoutMs: 1 };
    const render = codingPrompt();
    expect(render).toContain("Never lose why something failed");
    expect(render).toContain("Never make the code behave differently when a test runs it");
    const fix = codeFixerTask({ buildDir: "/b", spec: { moduleName: "app", text: "- Take an order." } });
    expect(fix).toContain("Never lose why something failed");
    expect(fix).toContain("make it show first");
    const judge = judgePrompt({ buildDir: "/b", conformanceDir: "/t", spec: { moduleName: "app", text: "- Take an order." }, run, invocation: "i", scope: { functionalities: [] }, notes: "" });
    expect(judge).toContain("the code is what is wrong first: it hides the cause");
  });

  it("is kept by every agent that writes code, and handed whole to the conformance agent", async () => {
    const { buildConformancePrompt } = await import("../../src/grow/prompt.ts");
    const { codeFixerTask } = await import("../../src/grow/conformance-agents.ts");
    const { buildManifests } = await import("../../src/grow/conformance.ts");
    const specifications = { definitions: [], "implementation reqs": [], "test reqs": ["- pytest."], "functional specs": ["- Take an order."] };
    const render = codingPrompt();
    expect(render).toContain("Keep the build's identity as it is: its name, coordinates, version, package and main class.");
    const fix = codeFixerTask({ buildDir: "/b", spec: { moduleName: "app", text: "- Take an order." } });
    expect(fix).toContain("Keep the build's identity as it is");

    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "turri-manifests-"));
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
