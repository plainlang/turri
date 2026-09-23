import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderConformanceTests, runInSandbox } from "../../src/render/conformance.ts";

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
  project = mkdtempSync(join(tmpdir(), "forge-conformance-"));
  buildDir = join(project, "plain_modules", "app", "code");
  conformanceDir = join(project, "plain_modules", "app", "tests");
  mkdirSync(buildDir, { recursive: true });
  mkdirSync(conformanceDir, { recursive: true });
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("runInSandbox", () => {
  it("merges the build and the tests, and reports success", async () => {
    writeFileSync(join(buildDir, "app.txt"), "hello");
    writeFileSync(join(conformanceDir, "check.sh"), "cat app.txt");

    const result = await runInSandbox(buildDir, conformanceDir, "sh check.sh");

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("hello");
  });

  it("reports the exit code and output of a failing command", async () => {
    writeFileSync(join(buildDir, "app.txt"), "hello");

    const result = await runInSandbox(buildDir, conformanceDir, "echo boom >&2; exit 3");

    expect(result.exitCode).toBe(3);
    expect(result.output).toContain("boom");
  });

  it("leaves the build and test directories untouched", async () => {
    writeFileSync(join(buildDir, "app.txt"), "hello");

    await runInSandbox(buildDir, conformanceDir, "echo scratch > scratch.txt");

    expect(readdirSync(buildDir)).toEqual(["app.txt"]);
    expect(readdirSync(conformanceDir)).toEqual([]);
  });

  it("gives each run a fresh sandbox", async () => {
    writeFileSync(join(buildDir, "app.txt"), "hello");

    await runInSandbox(buildDir, conformanceDir, "echo first > state.txt");
    const second = await runInSandbox(buildDir, conformanceDir, "cat state.txt");

    expect(second.exitCode).not.toBe(0);
  });
});

describe("renderConformanceTests", () => {
  it("refuses to run before the functionality has been rendered", async () => {
    await expect(
      renderConformanceTests({ plainFile: SIMPLE, frid: "1", buildDir, dryRun: true }),
    ).rejects.toThrow("Nothing to test");
  });

  it("points at the render command when the build is missing", async () => {
    await expect(
      renderConformanceTests({ plainFile: SIMPLE, frid: "1", buildDir, dryRun: true }),
    ).rejects.toThrow(`npm run render -- ${SIMPLE} 1`);
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
      expect(prompt).toContain('<functionality id="1">\n- Simple functionality\n</functionality>');
      expect(prompt).toContain("<test reqs>");
      expect(prompt).toContain("- Simple implementation requirement");
      expect(prompt).toContain("Write conformance tests for functionality 1.");
    });
  });
});
