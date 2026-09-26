import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildConformancePrompt } from "../../src/render/prompt.ts";
import { acceptanceLabel, conformanceLabel, misplacedConformanceTests, misplacedTestsPrompt, missingTestLabels } from "../../src/render/test-kinds.ts";

let tests: string;
beforeEach(() => {
  tests = mkdtempSync(join(tmpdir(), "plainwright-test-kinds-"));
});
afterEach(() => rmSync(tests, { recursive: true, force: true }));

const acceptance = ["- Registering twice with one email is refused.", "- A new user can log in."];

describe("telling conformance tests from acceptance tests", () => {
  it("finds both kinds, labelled", () => {
    writeFileSync(join(tests, "test_conformance_register.py"), "# conformance tests of functionality 2\n");
    mkdirSync(join(tests, "acceptance"));
    writeFileSync(
      join(tests, "acceptance", "test_acceptance_register.py"),
      "# Acceptance test 1 of functionality 2: Registering twice...\ndef test_a(): ...\n" +
        "# acceptance test 2 of functionality 2:\n#   A new user can log in.\ndef test_b(): ...\n",
    );
    expect(missingTestLabels(tests, "2", acceptance)).toEqual([]);
  });

  it("says which acceptance test has no test of its own, and when the conformance tests are unlabelled", () => {
    writeFileSync(join(tests, "test_register.py"), "# acceptance test 1 of functionality 2\n");
    expect(missingTestLabels(tests, "2", acceptance)).toEqual([
      'No test file is labelled "conformance tests of functionality 2".',
      'No test is labelled "acceptance test 2 of functionality 2": A new user can log in.',
    ]);
  });

  it("does not take functionality 2.1's labels for functionality 2's", () => {
    writeFileSync(
      join(tests, "test_x.py"),
      "# conformance tests of functionality 2.1\n# acceptance test 1 of functionality 2.1\n# acceptance test 12 of functionality 2\n",
    );
    expect(missingTestLabels(tests, "2", acceptance.slice(0, 1))).toHaveLength(2);
  });

  it("asks for conformance tests only, when the spec gives no acceptance tests", () => {
    writeFileSync(join(tests, "test_x.py"), "# conformance tests of functionality 1\n");
    expect(missingTestLabels(tests, "1", [])).toEqual([]);
  });
});

describe("the conformance prompt", () => {
  const input = (acceptanceTests: string[]) => ({
    moduleName: "users",
    frid: "2",
    specifications: {
      "definitions": [],
      "implementation reqs": [],
      "test reqs": ["- pytest"],
      "functional specs": ["- A user can log in.", "- A user can register."],
      acceptance_tests: acceptanceTests,
    } as never,
    linkedResources: [],
    manifest: ["app.py"],
  });

  it("numbers the acceptance tests as they are labelled, and keeps them apart from the conformance tests", () => {
    const prompt = buildConformancePrompt(input(acceptance));
    expect(prompt).toContain(
      "<acceptance tests>\nacceptance test 1 of functionality 2: Registering twice with one email is refused.\n\n" +
        "acceptance test 2 of functionality 2: A new user can log in.\n</acceptance tests>",
    );
    expect(prompt).toContain("written as if no acceptance tests had been given");
    expect(prompt).toContain("implement each of the 2 acceptance tests above as its own test");
    expect(prompt).toContain("Never fold one into a conformance test");
    expect(prompt).not.toContain("Cover each one");
  });

  it("asks only for conformance tests when there are no acceptance tests", () => {
    const prompt = buildConformancePrompt(input([]));
    expect(prompt).toContain('"conformance tests of functionality 2"');
    expect(prompt).not.toContain("acceptance test 1");
  });
});

describe("conformance tests in the code folder", () => {
  /** A file in the code folder under test. */
  const write = (file: string, content: string) => {
    mkdirSync(join(tests, file, ".."), { recursive: true });
    writeFileSync(join(tests, file), content);
  };

  it("are found by their label, or as test files named or foldered for conformance or acceptance", () => {
    write("src/app.py", "print('hi')\n");
    write("tests/test_app.py", "def test_unit(): pass\n");
    write("conformance_tests/test_conformance.py", "def test_x(): pass\n");
    write("tests/test_login.py", `# ${conformanceLabel("1")}\ndef test_login(): pass\n`);
    write("tests/test_accept_1.py", `# ${acceptanceLabel("2", 1)}: it works\n`);
    write("tests/test_change.py", "# conformance tests of the spec\n");
    expect(misplacedConformanceTests(tests).sort()).toEqual(["conformance_tests/test_conformance.py", "tests/test_accept_1.py", "tests/test_change.py", "tests/test_login.py"]);
  });

  it("are none in a code folder with only code and its unit tests - the working notes may name a label", () => {
    write("src/app.py", "print('hi')\n");
    write("tests/test_app.py", "def test_unit(): pass\n");
    write(".plainwright-notes.md", `- ${conformanceLabel("1")} are in the tests folder\n`);
    expect(misplacedConformanceTests(tests)).toEqual([]);
  });

  it("are sent back to be removed by the code agent, and moved by the conformance agent", () => {
    expect(misplacedTestsPrompt(["tests/test_login.py"], "/p/code")).toContain("are not yours to write");
    expect(misplacedTestsPrompt(["tests/test_login.py"], "/p/code", "/p/tests")).toContain("live in your working directory, /p/tests");
  });
});

