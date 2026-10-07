import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_ROLES, CONFIG_KEYS, projectModels, readProjectConfig } from "../src/config.ts";
import { initConfig, QUICK_START_CONFIG } from "../src/init-config.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-init-config-"));
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
    writeFileSync(join(dir, "config.yaml"), written.replace(/^# (?=[a-z-]+:|  )/gm, ""));
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
});
