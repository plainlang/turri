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
        "harness-model: anthropic/claude-opus-5-5",
        "coding-model: google/gemini-3.1-flash",
        "judge-model: google/gemini-3.1-pro",
        "conformance-tests: false",
        "unittests-script: test_scripts/run_unittests_rust.sh",
        "conformance-tests-script: test_scripts/run_conformance_tests_rust.sh",
      ].join("\n"),
    );
    expect(readProjectConfig(root)).toEqual({
      module: "prism_cli.plain",
      harnessModel: { model: "anthropic/claude-opus-5-5" },
      codingModel: { model: "google/gemini-3.1-flash" },
      judgeModel: { model: "google/gemini-3.1-pro" },
      conformanceTests: false,
      unittestsScript: "test_scripts/run_unittests_rust.sh",
      conformanceTestsScript: "test_scripts/run_conformance_tests_rust.sh",
      testingScripts: undefined,
    });
  });

  it("gives each model a reference and a thinking level, and fills in what one leaves out from the one it inherits", async () => {
    const { projectModels, modelSpec, splitModelSpec } = await import("../src/config.ts");
    writeFileSync(
      join(root, "config.yaml"),
      [
        "harness-model:",
        "  model: anthropic/claude-opus-5-5",
        "  thinking: high",
        "coding-model:",
        "  model: google/gemini-3.1-flash-lite",
        "judge-model:",
        "  thinking: xhigh",
      ].join("\n"),
    );
    const config = readProjectConfig(root);
    expect(config.harnessModel).toEqual({ model: "anthropic/claude-opus-5-5", thinking: "high" });
    const models = projectModels(config);
    // Coding takes the harness's thinking level; the judge takes the coding model, with its own level.
    expect(models.coding).toEqual({ model: "google/gemini-3.1-flash-lite", thinking: "high" });
    expect(models.judge).toEqual({ model: "google/gemini-3.1-flash-lite", thinking: "xhigh" });
    expect(modelSpec(models.judge)).toBe("google/gemini-3.1-flash-lite:xhigh");

    // Not given at all: the judge is the coding model, the coding model the harness model.
    writeFileSync(join(root, "config.yaml"), "harness-model: google/gemini-3.1-pro:medium\n");
    const inherited = projectModels(readProjectConfig(root));
    expect(inherited.coding).toEqual({ model: "google/gemini-3.1-pro", thinking: "medium" });
    expect(inherited.judge).toEqual(inherited.coding);

    // A model id with a colon of its own is not a thinking level.
    expect(splitModelSpec("amazon-bedrock/anthropic.claude-v2:1")).toEqual({ model: "amazon-bedrock/anthropic.claude-v2:1" });
    expect(splitModelSpec(":low")).toEqual({ thinking: "low" });
    // A thinking level that is not one is left out.
    writeFileSync(join(root, "config.yaml"), "coding-model:\n  model: a/b\n  thinking: very\n");
    expect(readProjectConfig(root).codingModel).toEqual({ model: "a/b" });
  });

  it("reads underscores as dashes, and ignores keys it does not know and values of the wrong type", () => {
    writeFileSync(
      join(root, "config.yaml"),
      "module: app.plain\nconformance_tests: true\nunittests_script: run_unittests.sh\nmodel: 42\ntemplate-dir: template\ntest-script-timeout: 600\n",
    );
    expect(readProjectConfig(root)).toEqual({
      module: "app.plain",
      harnessModel: undefined,
      codingModel: undefined,
      judgeModel: undefined,
      conformanceTests: true,
      unittestsScript: "run_unittests.sh",
      conformanceTestsScript: undefined,
    });
  });

  it("reads model:, from before there were two, as the coding model", () => {
    writeFileSync(join(root, "config.yaml"), "model: amazon-bedrock/eu.anthropic.claude-sonnet-5\n");
    expect(readProjectConfig(root).codingModel).toEqual({ model: "amazon-bedrock/eu.anthropic.claude-sonnet-5" });
    writeFileSync(join(root, "config.yaml"), "model: a/old\ncoding_model: b/new\n");
    expect(readProjectConfig(root).codingModel).toEqual({ model: "b/new" });
  });

  it("is empty when there is no file, or it does not parse", () => {
    expect(readProjectConfig(root)).toEqual({});
    writeFileSync(join(root, "config.yaml"), "module: [unclosed\n");
    expect(readProjectConfig(root)).toEqual({});
    writeFileSync(join(root, "config.yaml"), "- a list\n- not a map\n");
    expect(readProjectConfig(root)).toEqual({});
  });
});
