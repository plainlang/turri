import { mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_ROLES, CONFIG_KEYS, projectModels, readProjectConfig, ROLE_THINKING } from "../src/config.ts";
import { initConfig, main, QUICK_START_CONFIG, quickStartConfig, VENDORS, vendorOf, type Vendor } from "../src/init-config.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "turri-init-config-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("turri init-config", () => {
  it("writes a config.yaml with a strong model to talk to and a smaller one to write the code, as turri reads it", () => {
    expect(initConfig(dir).written).toBe(true);
    expect(readFileSync(join(dir, "config.yaml"), "utf8")).toBe(QUICK_START_CONFIG);
    const models = projectModels(readProjectConfig(dir));
    expect(models.harness?.model).toBe("anthropic/claude-opus-5-5");
    expect(models.coding?.model).toBe("google/gemini-3.1-flash-lite");
  });

  it("has every other key in it commented out - each read as written once uncommented", () => {
    initConfig(dir);
    const written = readFileSync(join(dir, "config.yaml"), "utf8");
    // Commented out, nothing but the two models is set.
    expect(Object.entries(readProjectConfig(dir)).filter(([, value]) => value !== undefined).map(([key]) => key).sort()).toEqual(["codingModel", "harnessModel"]);
    writeFileSync(join(dir, "config.yaml"), written.replace(/^# (?=[a-z-]+:|  [a-z-]+:)/gm, ""));
    const config = readProjectConfig(dir);
    for (const key of Object.keys(CONFIG_KEYS)) expect(config[key as keyof typeof config], key).toBeDefined();
    expect(Object.keys(config.models ?? {}).sort()).toEqual(["default", ...AGENT_ROLES].sort());
  });

  it("leaves a config.yaml already there as it is, unless told to write it again", () => {
    writeFileSync(join(dir, "config.yaml"), "module: app.plain\n");
    const result = initConfig(dir);
    expect(result).toMatchObject({ written: false });
    expect(result.message).toContain("--force");
    expect(readFileSync(join(dir, "config.yaml"), "utf8")).toBe("module: app.plain\n");
    expect(initConfig(dir, { force: true }).written).toBe(true);
    expect(readFileSync(join(dir, "config.yaml"), "utf8")).toBe(QUICK_START_CONFIG);
  });

  it("fills in the vendor's own models - each read as turri reads them, every role example its vendor's too", () => {
    for (const vendor of Object.keys(VENDORS) as Vendor[]) {
      const sub = join(dir, vendor);
      mkdirSync(sub);
      initConfig(sub, { vendor });
      const written = readFileSync(join(sub, "config.yaml"), "utf8");
      expect(written).toBe(quickStartConfig(vendor));
      const models = projectModels(readProjectConfig(sub));
      expect(models.harness?.model, vendor).toBe(VENDORS[vendor].harness);
      expect(models.coding?.model, vendor).toBe(VENDORS[vendor].coding);
      // Uncommented, every model named is the vendor's - but for other, a mix of two.
      writeFileSync(join(sub, "config.yaml"), written.replace(/^# (?=[a-z-]+:|  [a-z-]+:)/gm, ""));
      const named = Object.values(readProjectConfig(sub).models ?? {}).map((entry) => entry.model).filter((model) => model !== undefined);
      if (vendor !== "other") for (const model of named) expect(model!.split("/")[0], `${vendor}: ${model}`).toBe(vendor);
    }
    // Other is what turri wrote before it asked: a capable Anthropic model to talk to, a cheap Google one to code.
    expect(quickStartConfig("other")).toBe(QUICK_START_CONFIG);
  });

  it("shows how hard each role thinks unless a level is named - the work low, the judging medium - as turri runs them", () => {
    initConfig(dir, { vendor: "anthropic" });
    const written = readFileSync(join(dir, "config.yaml"), "utf8");
    // The two models carry their level: the one you talk to medium, the coding one low - the judging on it medium.
    expect(written).toMatch(/^harness-model: anthropic\/claude-opus-5-5:medium +#/m);
    expect(written).toMatch(/^coding-model: anthropic\/claude-haiku-5-5:low +#/m);
    expect(written).toContain("The reviews and judges run on the\n# coding model but think medium");
    expect(projectModels(readProjectConfig(dir))).toMatchObject({ harness: { thinking: "medium" }, coding: { thinking: "low" } });
    expect(projectModels(readProjectConfig(dir)).judge).toEqual({ model: "anthropic/claude-haiku-5-5" });
    // Uncommented, each role thinks as turri has it think unset - so the file shows what applies.
    writeFileSync(join(dir, "config.yaml"), written.replace(/^# (?=[a-z-]+:|  [a-z-]+:)/gm, ""));
    const models = readProjectConfig(dir).models ?? {};
    for (const [role, level] of Object.entries(ROLE_THINKING)) expect(models[role as keyof typeof models]?.thinking, role).toBe(level);
  });

  it("takes a vendor by its number in the list or its name, and nothing else", () => {
    expect(vendorOf("1")).toBe("anthropic");
    expect(vendorOf(" OpenAI ")).toBe("openai");
    expect(vendorOf("3")).toBe("google");
    expect(vendorOf("other")).toBe("other");
    expect(vendorOf("5")).toBeUndefined();
    expect(vendorOf("mistral")).toBeUndefined();
  });

  it("says where it wrote the file, the key pi reads for the vendor or /login, and that turri reads it from that folder alone", () => {
    const { message } = initConfig(dir, { vendor: "openai" });
    expect(message).toContain(`Wrote ${join(dir, "config.yaml")}, with OpenAI's models:`);
    expect(message).toContain("harness-model: openai/gpt-6-astra");
    expect(message).toContain("OPENAI_API_KEY");
    expect(message).toContain("type /login");
    expect(message).toContain(`This config belongs to this folder:\n  ${dir}`);
    expect(message).toContain("Started anywhere else");
    expect(message).toContain(`Then: cd ${dir} && turri`);
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
