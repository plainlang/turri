import { mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_ROLES, CONFIG_KEYS, projectModels, readProjectConfig, ROLE_THINKING } from "../src/config.ts";
import { BEDROCK_REGIONS, bedrockMakerOf, bedrockModels, bedrockRegionOf, DEFAULTS, defaultParallel, initConfig, main, QUICK_START_CONFIG, quickStartConfig, VENDORS, vendorOf, withModels, type Vendor } from "../src/init-config.ts";
import { defaultParallelJobs } from "../src/regenerate/jobs.ts";
import { DEFAULT_COMPACT_AT, DEFAULT_TURN_LIMIT_MS } from "../src/pi.ts";
import { MAX_LINES_PER_JOB, MAX_SPECS_PER_JOB } from "../src/regenerate/chunk-plan.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "turri-init-config-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("turri init-config", () => {
  it("writes a config.turri.yaml with a strong model to talk to and a smaller one to write the code, as turri reads it", () => {
    expect(initConfig(dir).written).toBe(true);
    expect(readFileSync(join(dir, "config.turri.yaml"), "utf8")).toBe(QUICK_START_CONFIG);
    const models = projectModels(readProjectConfig(dir));
    expect(models.harness?.model).toBe("anthropic/claude-opus-5-5");
    expect(models.coding?.model).toBe("google/gemini-3.1-flash-lite");
  });

  it("writes every other setting with the value turri uses for it, and the optional ones commented out - each read as written once uncommented", () => {
    initConfig(dir);
    const written = readFileSync(join(dir, "config.turri.yaml"), "utf8");
    expect(readProjectConfig(dir)).toMatchObject({
      conformanceTests: false,
      review: false,
      mutationTesting: true,
      allowToStopJobs: true,
      releaseAfterPulse: false,
      testingScriptsRunOn: "in-place",
      turnLimit: DEFAULTS.turnLimit,
      parallelJobs: defaultParallelJobs(),
      compactAt: DEFAULTS.compactAt,
      maxSpecsPerPulse: DEFAULTS.maxSpecsPerPulse,
      maxLinesPerPulse: DEFAULTS.maxLinesPerPulse,
      rulesOff: [],
      toolchains: [],
    });
    // Commented out, the optional ones have no value.
    const config0 = readProjectConfig(dir);
    for (const key of ["module", "judgeModel", "models", "conformanceBudget", "unittestsScript", "conformanceTestsScript", "prepareEnvironmentScript"] as const) {
      expect(config0[key], key).toBeUndefined();
    }
    // agent-env with nothing in it is no agent-env.
    expect(config0.agentEnv).toBeUndefined();
    expect(written).not.toContain("unset");
    writeFileSync(join(dir, "config.turri.yaml"), written.replace(/^# (?=[a-z-]+:|  [a-z-]+:)/gm, ""));
    const config = readProjectConfig(dir);
    // agent-env is written out empty - its examples in its comment - so it alone has no value.
    for (const key of Object.keys(CONFIG_KEYS).filter((key) => key !== "agentEnv")) expect(config[key as keyof typeof config], key).toBeDefined();
    expect(Object.keys(config.models ?? {}).sort()).toEqual(["default", ...AGENT_ROLES].sort());
  });

  it("sets only the two models in a config.turri.yaml already there - everything else left as it was - unless told to write it all again", () => {
    writeFileSync(join(dir, "config.turri.yaml"), "module: app.plain\nharness-model:\n  model: old/one\n  thinking: high\nconformance-tests: false\n");
    const result = initConfig(dir, { vendor: "openai" });
    expect(result).toMatchObject({ written: true });
    expect(result.message).toContain("everything else in it left as it was");
    const text = readFileSync(join(dir, "config.turri.yaml"), "utf8");
    expect(text).toContain("module: app.plain");
    expect(text).toContain("conformance-tests: false");
    expect(text).not.toContain("old/one");
    const config = readProjectConfig(dir);
    expect(config.module).toBe("app.plain");
    expect(projectModels(config)).toMatchObject({ harness: { model: "openai/gpt-6-astra", thinking: "medium" }, coding: { model: "openai/gpt-6-luna", thinking: "low" } });
    expect(initConfig(dir, { force: true }).written).toBe(true);
    expect(readFileSync(join(dir, "config.turri.yaml"), "utf8")).toBe(QUICK_START_CONFIG);
  });

  it("takes from another tool's config.yaml the keys turri reads too - each in its place in the quick start - and leaves the rest, and config.yaml, as they were", () => {
    const other = [
      "template_dir: template",
      "prepare-environment-script: test_scripts/prepare_environment_java.sh",
      "unittests-script: test_scripts/run_unittests.sh",
      "conformance-tests-script: test_scripts/run_conformance_tests.sh",
      "verbose: true",
      "api: https://api.example.com",
      "coding-model: somebody/else",
      "",
    ].join("\n");
    writeFileSync(join(dir, "config.yaml"), other);
    const result = initConfig(dir, { vendor: "openai" });
    expect(result.message).toContain("Took from config.yaml what turri reads too - prepare-environment-script, unittests-script, conformance-tests-script.");
    expect(result.message).toContain("Not taken, turri does not read them: template_dir, verbose, api.");
    expect(readFileSync(join(dir, "config.yaml"), "utf8")).toBe(other);
    const text = readFileSync(join(dir, "config.turri.yaml"), "utf8");
    // In its place: under its commented-out example, not at the end.
    expect(text.indexOf("unittests-script: test_scripts/run_unittests.sh")).toBeGreaterThan(text.indexOf("# unittests-script:"));
    expect(text).not.toContain("api:");
    expect(text).not.toContain("somebody/else");
    const config = readProjectConfig(dir);
    expect(config).toMatchObject({
      unittestsScript: "test_scripts/run_unittests.sh",
      conformanceTestsScript: "test_scripts/run_conformance_tests.sh",
      prepareEnvironmentScript: "test_scripts/prepare_environment_java.sh",
    });
    expect(projectModels(config).coding).toEqual({ model: "openai/gpt-6-luna", thinking: "low" });
  });

  it("takes a block - models:, agent-env: - whole, copies the old stacks' files to their new names, and takes nothing into a config.turri.yaml already there", () => {
    writeFileSync(join(dir, "config.yaml"), "agent-env:\n  vars: [D365_TENANT_ID]\nreview: false\n");
    writeFileSync(join(dir, "config.backend.yaml"), "unittests-script: run_unittests_python.sh\n");
    initConfig(dir, { vendor: "openai" });
    expect(readProjectConfig(dir)).toMatchObject({ agentEnv: { files: [], vars: ["D365_TENANT_ID"] }, review: false });
    expect(readFileSync(join(dir, "config.turri.backend.yaml"), "utf8")).toBe("unittests-script: run_unittests_python.sh\n");
    writeFileSync(join(dir, "config.yaml"), "conformance-tests: false\n");
    initConfig(dir, { vendor: "openai" });
    // The file already there keeps its own conformance-tests, the quick start's.
    expect(readProjectConfig(dir).conformanceTests).toBe(false);
  });

  it("writes the values turri falls back to, so a setting written out does as one left out", () => {
    expect(DEFAULTS.turnLimit * 1000).toBe(DEFAULT_TURN_LIMIT_MS);
    expect(DEFAULTS.compactAt).toBe(DEFAULT_COMPACT_AT);
    expect(DEFAULTS.maxSpecsPerPulse).toBe(MAX_SPECS_PER_JOB);
    expect(DEFAULTS.maxLinesPerPulse).toBe(MAX_LINES_PER_JOB);
    for (const cores of [1, 2, 7, 8, 32]) expect(defaultParallel(cores)).toBe(defaultParallelJobs(cores));
  });

  it("replaces a model key where it is, block and all, and puts one that is missing at the top", () => {
    const lines: [string, string] = ["harness-model: a/b:medium", "coding-model: c/d:low"];
    expect(withModels("x: 1\nharness-model:\n  model: o/p\ny: 2\n", lines)).toBe("coding-model: c/d:low\nx: 1\nharness-model: a/b:medium\ny: 2\n");
  });

  it("fills in Amazon Bedrock's models for the maker and the region chosen - Opus and Haiku, or Astra and Luna - the coding one thinking low", () => {
    expect(bedrockModels({ maker: "anthropic", region: "eu" })).toMatchObject({ harness: "amazon-bedrock/eu.anthropic.claude-opus-5-5", coding: "amazon-bedrock/eu.anthropic.claude-haiku-5-5" });
    expect(bedrockModels({ maker: "openai", region: "us" })).toMatchObject({ harness: "amazon-bedrock/us.openai.gpt-6-astra", coding: "amazon-bedrock/us.openai.gpt-6-luna" });
    const { message } = initConfig(dir, { vendor: "amazon-bedrock", bedrock: { maker: "anthropic", region: "eu" } });
    expect(message).toContain("Anthropic's on Amazon Bedrock (eu) models");
    expect(message).toContain("AWS_PROFILE");
    expect(message).toContain("AWS_BEARER_TOKEN_BEDROCK");
    expect(message).toContain("AWS_REGION=eu-central-1");
    expect(projectModels(readProjectConfig(dir))).toMatchObject({
      harness: { model: "amazon-bedrock/eu.anthropic.claude-opus-5-5", thinking: "medium" },
      coding: { model: "amazon-bedrock/eu.anthropic.claude-haiku-5-5", thinking: "low" },
    });
    // Only the regions each maker's models are served in.
    expect(BEDROCK_REGIONS.openai).toEqual(["global", "us"]);
    expect(bedrockRegionOf("openai", "eu")).toBeUndefined();
    expect(bedrockRegionOf("anthropic", "3")).toBe("eu");
    expect(bedrockMakerOf("2")).toBe("openai");
    expect(bedrockMakerOf("google")).toBeUndefined();
  });

  it("takes Amazon Bedrock's maker and region from --maker and --region without asking, and refuses a region the maker's models are not in", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await main([dir, "--vendor", "bedrock", "--maker", "openai", "--region=us"])).toBe(0);
      expect(projectModels(readProjectConfig(dir)).coding?.model).toBe("amazon-bedrock/us.openai.gpt-6-luna");
      expect(await main([dir, "--vendor", "amazon-bedrock", "--maker", "openai", "--region", "eu"])).toBe(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("fills in the vendor's own models - each read as turri reads them, every role example its vendor's too", () => {
    for (const vendor of Object.keys(VENDORS) as Vendor[]) {
      const sub = join(dir, vendor);
      mkdirSync(sub);
      initConfig(sub, { vendor });
      const written = readFileSync(join(sub, "config.turri.yaml"), "utf8");
      expect(written).toBe(quickStartConfig(vendor));
      const models = projectModels(readProjectConfig(sub));
      expect(models.harness?.model, vendor).toBe(VENDORS[vendor].harness);
      expect(models.coding?.model, vendor).toBe(VENDORS[vendor].coding);
      // Uncommented, every model named is the vendor's - but for other, a mix of two.
      writeFileSync(join(sub, "config.turri.yaml"), written.replace(/^# (?=[a-z-]+:|  [a-z-]+:)/gm, ""));
      const named = Object.values(readProjectConfig(sub).models ?? {}).map((entry) => entry.model).filter((model) => model !== undefined);
      if (vendor !== "other") for (const model of named) expect(model!.split("/")[0], `${vendor}: ${model}`).toBe(vendor);
    }
    // Other is what turri wrote before it asked: a capable Anthropic model to talk to, a cheap Google one to code.
    expect(quickStartConfig("other")).toBe(QUICK_START_CONFIG);
  });

  it("shows how hard each role thinks unless a level is named - the work low, the judging medium - as turri runs them", () => {
    initConfig(dir, { vendor: "anthropic" });
    const written = readFileSync(join(dir, "config.turri.yaml"), "utf8");
    // The two models carry their level: the one you talk to medium, the coding one low - the judging on it medium.
    expect(written).toMatch(/^harness-model: anthropic\/claude-opus-5-5:medium +#/m);
    expect(written).toMatch(/^coding-model: anthropic\/claude-haiku-5-5:low +#/m);
    expect(written).toContain("The reviews and judges run on the\n# coding model but think medium");
    expect(projectModels(readProjectConfig(dir))).toMatchObject({ harness: { thinking: "medium" }, coding: { thinking: "low" } });
    expect(projectModels(readProjectConfig(dir)).judge).toEqual({ model: "anthropic/claude-haiku-5-5" });
    // The release follows steps: the coding model, thinking low.
    expect(written).toMatch(/^# {3}release: \{ model: anthropic\/claude-haiku-5-5, thinking: low \}/m);
    // Uncommented, each role thinks as turri has it think unset - so the file shows what applies.
    writeFileSync(join(dir, "config.turri.yaml"), written.replace(/^# (?=[a-z-]+:|  [a-z-]+:)/gm, ""));
    const models = readProjectConfig(dir).models ?? {};
    for (const [role, level] of Object.entries(ROLE_THINKING)) expect(models[role as keyof typeof models]?.thinking, role).toBe(level);
  });

  it("takes a vendor by its number in the list or its name, and nothing else", () => {
    expect(vendorOf("1")).toBe("anthropic");
    expect(vendorOf(" OpenAI ")).toBe("openai");
    expect(vendorOf("3")).toBe("google");
    expect(vendorOf("4")).toBe("amazon-bedrock");
    expect(vendorOf("bedrock")).toBe("amazon-bedrock");
    expect(vendorOf("5")).toBe("other");
    expect(vendorOf("other")).toBe("other");
    expect(vendorOf("6")).toBeUndefined();
    expect(vendorOf("mistral")).toBeUndefined();
  });

  it("says in a few lines where it wrote the file, the two models, the key pi reads for the vendor or /login, and what to run next", () => {
    const { message } = initConfig(dir, { vendor: "openai" });
    expect(message).toContain(`✓ Wrote ${join(dir, "config.turri.yaml")}`);
    expect(message).toContain("with OpenAI's models");
    expect(message).toMatch(/you talk to +openai\/gpt-6-astra:medium/);
    expect(message).toMatch(/it codes +openai\/gpt-6-luna:low/);
    expect(message).toContain("export OPENAI_API_KEY=...");
    expect(message).toContain("type /login");
    expect(message).toContain(`turri reads this config when it starts in ${dir} or one below it.`);
    expect(message).toContain(`Then\n  cd ${dir}\n  turri doctor   checks the models answer with your credentials\n  turri`);
    // Written to a pipe, as here, it has no colours.
    expect(message).not.toContain("\x1b[");
    // Other names both keys, and that any provider pi supports will do.
    mkdirSync(join(dir, "mix"));
    const mix = initConfig(join(dir, "mix")).message;
    expect(mix).toContain("ANTHROPIC_API_KEY");
    expect(mix).toContain("GEMINI_API_KEY");
    expect(mix).toContain("Another provider");
  });

  it("takes the vendor from --vendor without asking - in the current folder, or the one named, either way round", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      expect(await main(["--vendor", "anthropic"])).toBe(0);
      expect(projectModels(readProjectConfig(dir)).coding?.model).toBe("anthropic/claude-haiku-5-5");
      mkdirSync(join(dir, "a"));
      mkdirSync(join(dir, "b"));
      expect(await main(["a", "--vendor=google"])).toBe(0);
      expect(projectModels(readProjectConfig(join(dir, "a"))).harness?.model).toBe("google/gemini-3.1-pro-preview");
      expect(await main(["--vendor", "openai", "b"])).toBe(0);
      expect(projectModels(readProjectConfig(join(dir, "b"))).harness?.model).toBe("openai/gpt-6-astra");
      expect(await main(["--vendor", "mistral", "b"])).toBe(1);
    } finally {
      process.chdir(cwd);
      vi.restoreAllMocks();
    }
  });
});
