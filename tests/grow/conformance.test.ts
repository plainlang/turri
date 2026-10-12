import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderConformanceTests } from "../../src/grow/conformance.ts";
import { runConformanceScript } from "../../src/grow/test-scripts.ts";

const SIMPLE = "tests/data/simple.plain";

/** Conformance needs test reqs, so the prompt tests use a spec that has them. */
const WITH_TEST_REQS = `***implementation reqs***

- Simple implementation requirement

***test reqs***

- Conformance tests run with "python -m unittest discover".

***functional specs***

- Simple functionality
`;

let project: string;
let buildDir: string;
let conformanceDir: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "turri-conformance-"));
  buildDir = join(project, "plain_modules", "app", "code");
  conformanceDir = join(project, "plain_modules", "app", "tests");
  mkdirSync(buildDir, { recursive: true });
  mkdirSync(conformanceDir, { recursive: true });
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("the harness's run of the conformance testing script", () => {
  const script = (body: string) => {
    const path = join(project, "test_scripts", "run_conformance_tests_sh.sh");
    mkdirSync(join(project, "test_scripts"), { recursive: true });
    writeFileSync(path, body);
    return { conformance: path };
  };
  const eachCheck = 'cd "$1" || exit 2\nfor check in $(cd "$2" && find . -name "*.sh" | sort); do sh "$2/$check" || exit 1; done\n';

  it("gives it the build and the whole suite, and reports success", async () => {
    writeFileSync(join(buildDir, "app.txt"), "hello");
    writeFileSync(join(conformanceDir, "check.sh"), "cat app.txt");

    const result = await runConformanceScript(buildDir, [conformanceDir], script(eachCheck));

    expect(result).toMatchObject({ command: "test_scripts/run_conformance_tests_sh.sh", exitCode: 0 });
    expect(result.output).toContain("hello");
  });

  it("reports the exit code and output of a failing run", async () => {
    const result = await runConformanceScript(buildDir, [conformanceDir], script("echo boom >&2; exit 3\n"));
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain("boom");
  });

  it("leaves the build and test directories untouched, and starts each run afresh, with testing-scripts-run-on: copy", async () => {
    writeFileSync(join(project, "config.yaml"), "testing-scripts-run-on: copy\n");
    writeFileSync(join(buildDir, "app.txt"), "hello");
    await runConformanceScript(buildDir, [conformanceDir], script('cd "$1" && echo first > state.txt\n'));
    expect(readdirSync(buildDir)).toEqual(["app.txt"]);
    expect(readdirSync(conformanceDir)).toEqual([]);
    expect((await runConformanceScript(buildDir, [conformanceDir], script('cd "$1" && cat state.txt\n'))).exitCode).not.toBe(0);
  });

  it("runs the project's prepare script on the build first, as codeplain does - the conformance tests once it passes", async () => {
    writeFileSync(join(buildDir, "app.txt"), "hello");
    const prepare = join(project, "test_scripts", "prepare_environment_sh.sh");
    const scripts = script('cat "/tmp/turri_prepared_$(basename "$1")" && echo "tests=$2"\n');
    writeFileSync(prepare, 'echo "preparing $1"; echo ready > "/tmp/turri_prepared_$(basename "$1")"\n');
    try {
      const result = await runConformanceScript(buildDir, [conformanceDir], { ...scripts, prepare });
      expect(result.exitCode, result.output).toBe(0);
      expect(result.output).toContain("test_scripts/prepare_environment_sh.sh prepared the build first, and passed.");
      // Both on the same build: what the prepare script made for it, the conformance testing script finds.
      expect(result.output).toContain("ready");
      expect(result.output).toContain(`tests=${conformanceDir}`);
    } finally {
      rmSync(`/tmp/turri_prepared_${basename(buildDir)}`, { force: true });
    }
  });

  it("does not run the conformance tests when the prepare script fails, and says it was the preparation", async () => {
    const prepare = join(project, "test_scripts", "prepare_environment_sh.sh");
    const scripts = script("echo conformance-ran\n");
    writeFileSync(prepare, "echo mvn failed >&2; exit 4\n");
    const result = await runConformanceScript(buildDir, [conformanceDir], { ...scripts, prepare });
    expect(result.exitCode).toBe(4);
    expect(result.command).toBe("test_scripts/prepare_environment_sh.sh");
    expect(result.output).toContain("exited 4, so the conformance tests were not run");
    expect(result.output).toContain("mvn failed");
    expect(result.output).not.toContain("conformance-ran");
  });

  it("runs the prepare script on the same fresh copy the conformance tests get, with testing-scripts-run-on: copy", async () => {
    writeFileSync(join(project, "config.yaml"), "testing-scripts-run-on: copy\n");
    const prepare = join(project, "test_scripts", "prepare_environment_sh.sh");
    const scripts = script('cat "$1/prepared.txt"\n');
    writeFileSync(prepare, 'echo prepared > "$1/prepared.txt"\n');
    const result = await runConformanceScript(buildDir, [conformanceDir], { ...scripts, prepare });
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain("prepared");
    expect(readdirSync(buildDir)).toEqual([]);
  });
});

describe("renderConformanceTests", () => {
  it("refuses to run before the functionality has been rendered", async () => {
    await expect(
      renderConformanceTests({ plainFile: SIMPLE, frid: "1", buildDir, dryRun: true }),
    ).rejects.toThrow("Nothing to test");
  });

  it("points at the command that builds the code when the build is missing", async () => {
    await expect(
      renderConformanceTests({ plainFile: SIMPLE, frid: "1", buildDir, dryRun: true }),
    ).rejects.toThrow(`turri regenerate ${SIMPLE}`);
  });

  it("rejects an unknown functionality id", async () => {
    writeFileSync(join(buildDir, "app.py"), "print('x')");
    await expect(
      renderConformanceTests({ plainFile: SIMPLE, frid: "7", buildDir, dryRun: true }),
    ).rejects.toThrow("Functionality 7 does not exist. Available: 1.");
  });

  it("rejects a file that is not a .plain file", async () => {
    await expect(renderConformanceTests({ plainFile: "README.md", dryRun: true })).rejects.toThrow(
      "Expected a .plain file",
    );
  });

  describe("the prompt", () => {
    let prompt: string;

    beforeEach(async () => {
      mkdirSync(join(buildDir, "pkg"), { recursive: true });
      writeFileSync(join(buildDir, "app.py"), "SECRET_INTERNAL_HELPER = 1");
      writeFileSync(join(buildDir, "pkg", "helper.py"), "x = 2");

      const specFile = join(buildDir, "..", "withreqs.plain");
      writeFileSync(specFile, WITH_TEST_REQS);
      const result = await renderConformanceTests({
        plainFile: specFile,
        frid: "1",
        buildDir,
        conformanceDir,
        dryRun: true,
      });
      prompt = result.prompt;
    });

    it("frames the task as black box", () => {
      expect(prompt).toContain("Conformance tests are black box");
      // The agent may read the code to learn how to call it, but every assertion still
      // comes from the specification - a test written from the code cannot catch the code.
      expect(prompt).toContain("Every assertion comes");
      expect(prompt).toContain("the test follows the");
    });

    it("lists the built files by name only, never their contents", () => {
      expect(prompt).toContain("<files in the build>\napp.py\npkg/helper.py\n</files in the build>");
      expect(prompt).not.toContain("SECRET_INTERNAL_HELPER");
    });

    it("carries the functionality and the specification sections", () => {
      expect(prompt).toContain('<functionality module="withreqs" id="1">\n- Simple functionality\n</functionality>');
      expect(prompt).toContain("<test reqs>");
      expect(prompt).toContain("- Simple implementation requirement");
      expect(prompt).toContain("Write conformance tests for functionality 1 of module `withreqs`.");
    });
  });
});

describe("the functionalities a spec change touches", () => {
  it("are those whose functional spec or acceptance tests have a line the diff adds or removes", async () => {
    const { touchedFunctionalities } = await import("../../src/grow/conformance.ts");
    const { plainFileParser } = await import("../../src/plain/parser.ts");
    const dir = mkdtempSync(join(tmpdir(), "turri-touched-"));
    writeFileSync(
      join(dir, "app.plain"),
      "***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n" +
        "- The app prints hello.\n\n  ***acceptance tests***\n\n  - Running the app prints hello and exits 0.\n\n" +
        "- The app prints its version with --version.\n\n  ***acceptance tests***\n\n  - Running it with --version prints 1.2 and exits 0.\n\n" +
        "- The app prints help with --help.\n",
    );
    const [, tree] = plainFileParser("app.plain", [dir]);
    const frids = ["1", "2", "3"];
    const specDiff = "--- a/app.plain\n+++ b/app.plain\n@@ -1 +1 @@\n-- The app prints hi.\n+- The app prints hello.\n";
    expect(touchedFunctionalities(tree, frids, specDiff)).toEqual([{ frid: "1", acceptanceTests: [expect.stringContaining("prints hello and exits 0")] }]);
    const testDiff = "@@ -1 +1 @@\n-  - Running it with --version prints 1.1 and exits 0.\n+  - Running it with --version prints 1.2 and exits 0.\n";
    expect(touchedFunctionalities(tree, frids, testDiff).map((item) => item.frid)).toEqual(["2"]);
    expect(touchedFunctionalities(tree, frids, "@@ -1 +1 @@\n-- Python 3.11.\n+- Python.\n")).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("why conformance tests did not land", () => {
  it("says the tests were never labelled, not that they failed, when labelling is what stopped them", async () => {
    const { notLandedWhy } = await import("../../src/grow/conformance.ts");
    expect(notLandedWhy("for the spec change")).toBe("the conformance tests for the spec change do not pass");
    const why = notLandedWhy("for the spec change", ["conformance tests of functionality 2"]);
    expect(why).toContain("were not written and labelled after 3 requests");
    expect(why).toContain("conformance tests of functionality 2");
    expect(why).not.toContain("do not pass");
  });
});
