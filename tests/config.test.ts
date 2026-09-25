import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProjectConfig } from "../src/config.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plainwright-config-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the project's config.yaml", () => {
  it("says what to build, on which model, with or without conformance, and where the testing scripts are", () => {
    writeFileSync(
      join(root, "config.yaml"),
      [
        "module: prism_cli.plain",
        "model: google/gemini-3.1-flash",
        "conformance-tests: false",
        "unittests-script: test_scripts/run_unittests_rust.sh",
        "conformance-tests-script: test_scripts/run_conformance_tests_rust.sh",
      ].join("\n"),
    );
    expect(readProjectConfig(root)).toEqual({
      module: "prism_cli.plain",
      model: "google/gemini-3.1-flash",
      conformanceTests: false,
      unittestsScript: "test_scripts/run_unittests_rust.sh",
      conformanceTestsScript: "test_scripts/run_conformance_tests_rust.sh",
    });
  });

  it("reads underscores as dashes, and ignores keys it does not know and values of the wrong type", () => {
    writeFileSync(
      join(root, "config.yaml"),
      "module: app.plain\nconformance_tests: true\nunittests_script: run_unittests.sh\nmodel: 42\ntemplate-dir: template\ntest-script-timeout: 600\n",
    );
    expect(readProjectConfig(root)).toEqual({
      module: "app.plain",
      model: undefined,
      conformanceTests: true,
      unittestsScript: "run_unittests.sh",
      conformanceTestsScript: undefined,
    });
  });

  it("is empty when there is no file, or it does not parse", () => {
    expect(readProjectConfig(root)).toEqual({});
    writeFileSync(join(root, "config.yaml"), "module: [unclosed\n");
    expect(readProjectConfig(root)).toEqual({});
    writeFileSync(join(root, "config.yaml"), "- a list\n- not a map\n");
    expect(readProjectConfig(root)).toEqual({});
  });
});
