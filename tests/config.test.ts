import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_ROLES, budgetFor, modelOnly, projectModels, readProjectConfig, ROLE_THINKING, roleModel, roleTurnLimitMs } from "../src/config.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "turri-config-"));
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

    // Not given at all: the judge is the coding model - its model alone, thinking as its role does - the coding model
    // the harness model, its thinking too.
    writeFileSync(join(root, "config.yaml"), "harness-model: google/gemini-3.1-pro:medium\n");
    const inherited = projectModels(readProjectConfig(root));
    expect(inherited.coding).toEqual({ model: "google/gemini-3.1-pro", thinking: "medium" });
    expect(inherited.judge).toEqual({ model: "google/gemini-3.1-pro" });

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

  it("has conformance tests for all the functional specs, for the chosen ones, or for none - true read as all", () => {
    const read = (value: string) => {
      writeFileSync(join(root, "config.yaml"), `conformance-tests: ${value}\n`);
      return readProjectConfig(root).conformanceTests;
    };
    expect(read("all")).toBe(true);
    expect(read("true")).toBe(true);
    expect(read("chosen")).toBe("chosen");
    expect(read("Chosen")).toBe("chosen");
    expect(read("false")).toBe(false);
    expect(read("some")).toBeUndefined();
  });

  it("turns the review of the code and its tests on or off, and reads nothing else as either", () => {
    writeFileSync(join(root, "config.yaml"), "review: false\n");
    expect(readProjectConfig(root).review).toBe(false);
    writeFileSync(join(root, "config.yaml"), "review: true\n");
    expect(readProjectConfig(root).review).toBe(true);
    writeFileSync(join(root, "config.yaml"), "review: sometimes\n");
    expect(readProjectConfig(root).review).toBeUndefined();
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
    const { defaultParallelJobs } = await import("../src/grow/jobs.ts");
    expect(parallelJobs(root)).toBe(defaultParallelJobs());
    writeFileSync(join(root, "config.yaml"), "parallel-jobs: 6\n");
    expect(readProjectConfig(root).parallelJobs).toBe(6);
    expect(parallelJobs(root)).toBe(6);
    process.env.TURRI_PARALLEL_JOBS = "2";
    try {
      expect(parallelJobs(root)).toBe(2);
    } finally {
      delete process.env.TURRI_PARALLEL_JOBS;
    }
    writeFileSync(join(root, "config.yaml"), "parallel-jobs: 0\n");
    expect(readProjectConfig(root).parallelJobs).toBeUndefined();
  });
});

describe("compact-at", () => {
  it("is how much of an agent's work it keeps before it is compacted - the project's alone, and a number worth compacting at", () => {
    writeFileSync(join(root, "config.yaml"), "compact-at: 150000\n");
    expect(readProjectConfig(root).compactAt).toBe(150_000);
    writeFileSync(join(root, "config.yaml"), "compact-at: 12\n");
    expect(readProjectConfig(root).compactAt).toBeUndefined();
    writeFileSync(join(root, "config.yaml"), "compact-at: lots\n");
    expect(readProjectConfig(root).compactAt).toBeUndefined();
    writeFileSync(join(root, "config.yaml"), "compact-at: 150000\n");
    writeFileSync(join(root, "config.backend.yaml"), "compact-at: 50000\n");
    expect(readProjectConfig(root, "backend").compactAt).toBe(150_000);
  });
});

describe("conformance-budget:", () => {
  it("is a count or a share of a module's functional specs - a share rounded up, at least one - and unset is no limit", () => {
    writeFileSync(join(root, "config.yaml"), "conformance-budget: 2\n");
    expect(readProjectConfig(root).conformanceBudget).toEqual({ count: 2 });
    writeFileSync(join(root, "config.yaml"), "conformance-budget: 30%\n");
    const share = readProjectConfig(root).conformanceBudget!;
    expect(share).toEqual({ share: 0.3 });
    expect([budgetFor(share, 1), budgetFor(share, 7), budgetFor(share, 10)]).toEqual([1, 3, 3]);
    writeFileSync(join(root, "config.yaml"), "conformance-budget: lots\n");
    expect(readProjectConfig(root).conformanceBudget).toBeUndefined();
    writeFileSync(join(root, "config.yaml"), "conformance-tests: chosen\n");
    expect(readProjectConfig(root).conformanceBudget).toBeUndefined();
  });
});

describe("how hard each role thinks when nothing names a level", () => {
  it("has the agents that do the work think low, the ones that judge medium, and leaves the conversation its own", () => {
    for (const role of ["coding", "conformance", "explorer", "release"] as const) expect(ROLE_THINKING[role], role).toBe("low");
    for (const role of ["reviewer", "test-reviewer", "judge", "arbiter", "debugger", "planner", "chooser", "diagnosis"] as const) expect(ROLE_THINKING[role], role).toBe("medium");
    expect(ROLE_THINKING.chat).toBeUndefined();
    expect(AGENT_ROLES.filter((role) => role !== "chat" && ROLE_THINKING[role] === undefined)).toEqual([]);
  });

  it("is what an agent starts with: below a level the config or its model names, above the conversation's", async () => {
    const { agentThinking } = await import("../src/pi.ts");
    const conversation = () => "high" as const;
    expect(agentThinking(undefined, "coding", conversation)).toBe("low");
    expect(agentThinking(undefined, "judge", conversation)).toBe("medium");
    expect(agentThinking("xhigh", "coding", conversation)).toBe("xhigh");
    expect(agentThinking(undefined, undefined, conversation)).toBe("high");
  });

  it("gives a judging role falling back on the coding model the model alone, not how hard the coding agent thinks", () => {
    expect(modelOnly("google/gemini-3.1-flash-lite:low")).toEqual({ model: "google/gemini-3.1-flash-lite" });
    expect(modelOnly("google/gemini-3.1-flash-lite")).toEqual({ model: "google/gemini-3.1-flash-lite" });
    expect(modelOnly(":high")).toEqual({});
    expect(modelOnly(undefined)).toEqual({});
  });
});

describe("models: and turn-limit:", () => {
  const sonnet = "amazon-bedrock/eu.anthropic.claude-sonnet-5";
  const luna = "amazon-bedrock/global.openai.gpt-6-luna";
  const lite = "google/gemini-3.1-flash-lite";
  const opus = "amazon-bedrock/eu.anthropic.claude-opus-5-5";

  it("gives each agent role its own model, thinking and turn limit, and every role it does not name the default", () => {
    writeFileSync(
      join(root, "config.yaml"),
      [
        "harness-model: " + opus,
        "turn-limit: 150",
        "models:",
        `  default: { model: ${luna}, thinking: medium }`,
        `  coding: { model: ${sonnet}, thinking: high, turn-limit: 180 }`,
        `  explorer: ${lite}`,
        "  reviewer:",
        "    thinking: low",
        "  nonsense: whatever",
      ].join("\n"),
    );
    const config = readProjectConfig(root);
    expect(config.models).toEqual({
      default: { model: luna, thinking: "medium" },
      coding: { model: sonnet, thinking: "high", turnLimit: 180 },
      explorer: { model: lite },
      reviewer: { thinking: "low" },
    });
    // The job's model - the coding agents' - and the chat's.
    expect(projectModels(config)).toEqual({ harness: { model: opus }, coding: { model: sonnet, thinking: "high" }, judge: { model: luna, thinking: "medium" } });
    // What a role runs on: its own entry, what it leaves out from the default; the coding role is given its model.
    expect(roleModel(config, "explorer")).toEqual({ model: lite, thinking: "medium" });
    expect(roleModel(config, "reviewer")).toEqual({ model: luna, thinking: "low" });
    expect(roleModel(config, "judge")).toEqual({ model: luna, thinking: "medium" });
    expect(roleModel(config, "coding")).toBeUndefined();
    // The debugger, unnamed, runs on the coding model it is given - not the default.
    expect(roleModel(config, "debugger")).toBeUndefined();
    // The conversation's side keeps the chat's model unless named.
    expect(roleModel(config, "chooser")).toBeUndefined();
    // Turn limits: the role's own, else the default's, else turn-limit:.
    expect(roleTurnLimitMs(config, "coding")).toBe(180_000);
    expect(roleTurnLimitMs(config, "explorer")).toBe(150_000);
    expect(roleTurnLimitMs(config, undefined)).toBe(150_000);
  });

  it("runs the debugger on its own model when models: names one, and on the coding model when it does not", () => {
    writeFileSync(join(root, "config.yaml"), "models:\n  default: openai/gpt-5.5\n  debugger: { model: anthropic/claude-opus-5-5, thinking: high }\n");
    expect(roleModel(readProjectConfig(root), "debugger")).toEqual({ model: "anthropic/claude-opus-5-5", thinking: "high" });
    writeFileSync(join(root, "config.yaml"), "models:\n  default: openai/gpt-5.5\n");
    expect(roleModel(readProjectConfig(root), "debugger")).toBeUndefined();
  });

  it("takes one turn limit for every agent from turn-limit: alone, and none from nothing - the harness's two minutes", () => {
    writeFileSync(join(root, "config.yaml"), "turn-limit: 150\n");
    expect(roleTurnLimitMs(readProjectConfig(root), "conformance")).toBe(150_000);
    writeFileSync(join(root, "config.yaml"), "coding-model: google/gemini-3.8-flash\n");
    expect(roleTurnLimitMs(readProjectConfig(root), "conformance")).toBeUndefined();
  });

  it("reads the old keys as before, models: winning over them - judge-model for the judge and the test review", () => {
    writeFileSync(join(root, "config.yaml"), [`harness-model: ${opus}`, `coding-model: ${luna}`, `judge-model: ${sonnet}`].join("\n"));
    let config = readProjectConfig(root);
    expect(projectModels(config)).toEqual({ harness: { model: opus }, coding: { model: luna }, judge: { model: sonnet } });
    expect(roleModel(config, "test-reviewer")).toEqual({ model: sonnet });
    expect(roleModel(config, "explorer")).toBeUndefined();
    writeFileSync(join(root, "config.yaml"), [`harness-model: ${opus}`, `coding-model: ${luna}`, "models:", `  coding: ${sonnet}`, `  chat: ${lite}`].join("\n"));
    config = readProjectConfig(root);
    expect(projectModels(config).coding).toEqual({ model: sonnet });
    expect(projectModels(config).harness).toEqual({ model: lite });
  });

  it("lays a module's own models: over the project's, role by role - but never the chat's", () => {
    writeFileSync(join(root, "config.yaml"), ["models:", `  default: { model: ${luna}, turn-limit: 120 }`, `  chat: ${opus}`].join("\n"));
    writeFileSync(join(root, "config.backend.yaml"), ["models:", "  default: { thinking: high }", `  explorer: ${lite}`, `  chat: ${lite}`, "turn-limit: 200"].join("\n"));
    const config = readProjectConfig(root, "backend");
    expect(config.models).toEqual({ default: { model: luna, thinking: "high", turnLimit: 120 }, chat: { model: opus }, explorer: { model: lite } });
    expect(config.turnLimit).toBe(200);
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
    const { projectDirOf } = await import("../src/grow/paths.ts");
    const { findTestScripts } = await import("../src/grow/test-scripts.ts");
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
