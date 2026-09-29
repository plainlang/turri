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
      runTestingScriptsIn: undefined,
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

describe("parallel-jobs", () => {
  it("is how many jobs the chat runs at once - the environment first, then config.yaml, then what the machine holds", async () => {
    const { parallelJobs } = await import("../src/extension.ts");
    const { defaultParallelJobs } = await import("../src/render/vm.ts");
    expect(parallelJobs(root)).toBe(defaultParallelJobs());
    writeFileSync(join(root, "config.yaml"), "parallel-jobs: 6\n");
    expect(readProjectConfig(root).parallelJobs).toBe(6);
    expect(parallelJobs(root)).toBe(6);
    process.env.PLAINWRIGHT_PARALLEL_JOBS = "2";
    try {
      expect(parallelJobs(root)).toBe(2);
    } finally {
      delete process.env.PLAINWRIGHT_PARALLEL_JOBS;
    }
    writeFileSync(join(root, "config.yaml"), "parallel-jobs: 0\n");
    expect(readProjectConfig(root).parallelJobs).toBeUndefined();
  });
});

describe("a module's own config file", () => {
  /** cognio: a Python backend and a React frontend side by side, importing one common module. */
  beforeEach(() => {
    writeFileSync(join(root, "config.yaml"), ["harness-model: anthropic/claude-opus-5-5", "coding-model: google/gemini-3.1-flash:low", "conformance-tests: true"].join("\n"));
    writeFileSync(
      join(root, "config.backend.yaml"),
      ["unittests-script: test_scripts/run_unittests_python.sh", "conformance-tests-script: test_scripts/run_conformance_tests_python.sh"].join("\n"),
    );
    writeFileSync(
      join(root, "config.frontend.yaml"),
      [
        "unittests-script: test_scripts/run_unittests_typescript.sh",
        "coding-model:",
        "  thinking: high",
        "conformance-tests: false",
        "harness-model: somebody/else",
        "module: frontend.plain",
      ].join("\n"),
    );
    writeFileSync(join(root, "base.plain"), "***definitions***\n\n- :User: is a person.\n");
    writeFileSync(join(root, "backend.plain"), "---\nimport:\n  - base\n---\n\n***functional specs***\n\n- Serve.\n");
    writeFileSync(join(root, "frontend.plain"), "---\nimport:\n  - base\n---\n\n***functional specs***\n\n- Show.\n");
    writeFileSync(join(root, "backend_admin.plain"), "---\nrequires:\n  - backend\n---\n\n***functional specs***\n\n- Administer.\n");
  });

  it("lays its keys over config.yaml's - a model it names taking what it leaves out from the project's", async () => {
    const { configForSpec, modulesWithConfig } = await import("../src/config.ts");
    expect(modulesWithConfig(root)).toEqual(["backend", "frontend"]);
    expect(configForSpec(join(root, "backend.plain"))).toEqual({
      harnessModel: { model: "anthropic/claude-opus-5-5" },
      codingModel: { model: "google/gemini-3.1-flash", thinking: "low" },
      conformanceTests: true,
      unittestsScript: "test_scripts/run_unittests_python.sh",
      conformanceTestsScript: "test_scripts/run_conformance_tests_python.sh",
    });
    // The conversation's model, and the module built when none is named, are the project's alone.
    expect(configForSpec(join(root, "frontend.plain"))).toEqual({
      harnessModel: { model: "anthropic/claude-opus-5-5" },
      codingModel: { model: "google/gemini-3.1-flash", thinking: "high" },
      conformanceTests: false,
      unittestsScript: "test_scripts/run_unittests_typescript.sh",
    });
  });

  it("holds for the modules built on it, down the requires chain - and an import module or a module without one has config.yaml alone", async () => {
    const { configForSpec, configModuleOf } = await import("../src/config.ts");
    expect(configModuleOf(root, join(root, "backend_admin.plain"))).toBe("backend");
    expect(configForSpec(join(root, "backend_admin.plain")).unittestsScript).toBe("test_scripts/run_unittests_python.sh");
    expect(configModuleOf(root, join(root, "base.plain"))).toBeUndefined();
    expect(configForSpec(join(root, "base.plain")).unittestsScript).toBeUndefined();
  });

  it("makes its folder a project, and each module finds its own stack's testing scripts there", async () => {
    const { mkdirSync } = await import("node:fs");
    const { projectDirOf } = await import("../src/render/paths.ts");
    const { findTestScripts } = await import("../src/render/test-scripts.ts");
    rmSync(join(root, "config.yaml"));
    mkdirSync(join(root, "test_scripts"));
    for (const script of ["run_unittests_python.sh", "run_unittests_typescript.sh", "run_conformance_tests_python.sh"]) writeFileSync(join(root, "test_scripts", script), "#!/bin/bash\n");
    expect(projectDirOf(join(root, "backend.plain"))).toBe(root);

    expect(findTestScripts(root, join(root, "backend.plain")).unit).toBe(join(root, "test_scripts", "run_unittests_python.sh"));
    expect(findTestScripts(root, join(root, "frontend.plain")).unit).toBe(join(root, "test_scripts", "run_unittests_typescript.sh"));
    // Run in the backend's codebase, a required module's spec is tested as the backend is.
    expect(findTestScripts(root, join(root, "base.plain"), join(root, "plain_modules", "backend_admin", "code")).unit).toBe(join(root, "test_scripts", "run_unittests_python.sh"));
    // Without a module, the project cannot say which of two it means - and says where to name it.
    const project = findTestScripts(root);
    expect(project.unit).toBeUndefined();
    expect(findTestScripts(root, join(root, "other.plain")).notes?.unit).toContain("config.other.yaml");
  });
});
