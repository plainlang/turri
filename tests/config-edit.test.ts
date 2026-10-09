import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProjectConfig, roleTurnLimitMs } from "../src/config.ts";
import { currentValue, overriddenBy, parseValue, settingOf, settings, withSetting, writeSetting } from "../src/config-edit.ts";
import { QUICK_START_CONFIG } from "../src/init-config.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "turri-config-edit-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A value each kind of setting takes, as typed. */
function sample(key: string): string {
  const setting = settingOf(key, ["concise-specs"])!;
  switch (setting.kind) {
    case "boolean":
      return "false";
    case "choice":
      return setting.options!.at(-1)!;
    case "number":
      // compact-at takes 1000 or more; the rest, 7.
      return (setting.min ?? 0) >= 1000 ? "150000" : "7";
    case "budget":
      return "30%";
    case "model":
      return "openai/gpt-6-luna:low";
    case "list":
      return key === "rules-off" ? "concise-specs" : key === "toolchains" ? "/srv/zig" : key === "agent-env.files" ? ".env" : "MY_KEY";
    case "path":
      return key === "module" ? "app.plain" : "test_scripts/run.sh";
  }
}

describe("/turri-config's settings", () => {
  it("are every key turri reads - each written as typed is read back by turri as set", () => {
    for (const setting of settings(["concise-specs"])) {
      const parsed = parseValue(setting, sample(setting.key));
      expect("value" in parsed, setting.key).toBe(true);
      writeFileSync(join(dir, "config.yaml"), withSetting("", setting.key, (parsed as { value: unknown }).value));
      const config = readProjectConfig(dir);
      const [top, role, field] = setting.key.split(".");
      if (top === "models") {
        if (field === "turn-limit") expect(roleTurnLimitMs(config, role === "default" ? undefined : (role as never)), setting.key).toBe(7000);
        else expect(config.models?.[role as never], setting.key).toMatchObject({ model: "openai/gpt-6-luna", thinking: "low" });
        continue;
      }
      const name = Object.entries({
        module: "module", "harness-model": "harnessModel", "coding-model": "codingModel", "judge-model": "judgeModel", "conformance-tests": "conformanceTests",
        "conformance-budget": "conformanceBudget", review: "review", "allow-to-stop-jobs": "allowToStopJobs", "release-after-pulse": "releaseAfterPulse",
        "unittests-script": "unittestsScript", "conformance-tests-script": "conformanceTestsScript", "static-checks-script": "staticChecksScript",
        "testing-scripts-run-on": "testingScriptsRunOn", "parallel-jobs": "parallelJobs", "max-specs-per-pulse": "maxSpecsPerPulse",
        "max-lines-per-pulse": "maxLinesPerPulse", "turn-limit": "turnLimit", "compact-at": "compactAt", "rules-off": "rulesOff",
        "agent-env": "agentEnv", toolchains: "toolchains",
      }).find(([written]) => written === top)?.[1];
      expect(name, setting.key).toBeDefined();
      expect((config as Record<string, unknown>)[name!], setting.key).toBeDefined();
    }
  });

  it("change a key in its line, its comment kept, and put a new one under its commented-out example", () => {
    let text = withSetting(QUICK_START_CONFIG, "harness-model", "openai/gpt-6-astra:medium");
    expect(text).toMatch(/^harness-model: openai\/gpt-6-astra:medium +# you talk to it/m);
    text = withSetting(text, "review", false);
    const lines = text.split("\n");
    expect(lines.indexOf("review: false")).toBe(lines.indexOf("# review: false") + 1);
    // Unset, it is gone; the example stays.
    text = withSetting(text, "review", undefined);
    expect(text).not.toMatch(/^review:/m);
    expect(text).toContain("# review: false");
  });

  it("write a role's model and turn limit under models: - a string alone, an object once it has a turn limit - and take the block out once empty", () => {
    let text = withSetting("", "models.coding", "openai/gpt-6-luna:low");
    expect(text).toBe("models:\n  coding: openai/gpt-6-luna:low\n");
    text = withSetting(text, "models.coding.turn-limit", 200);
    expect(currentValue(text, "models.coding")).toBe("openai/gpt-6-luna:low");
    expect(currentValue(text, "models.coding.turn-limit")).toBe(200);
    expect(readProjectConfig(writeAndRead(text)).models?.coding).toEqual({ model: "openai/gpt-6-luna", thinking: "low", turnLimit: 200 });
    text = withSetting(text, "models.coding.turn-limit", undefined);
    expect(text).toBe("models:\n  coding: openai/gpt-6-luna:low\n");
    text = withSetting(text, "models.coding", undefined);
    expect(text).toBe("");
  });

  it("read what is typed as the setting takes it, and refuse what it does not - unset for its default", () => {
    expect(parseValue(settingOf("review")!, "no")).toEqual({ value: false });
    expect(parseValue(settingOf("review")!, "maybe")).toMatchObject({ error: expect.stringContaining("true or false") });
    expect(parseValue(settingOf("conformance-tests")!, "false")).toEqual({ value: false });
    expect(parseValue(settingOf("parallel-jobs")!, "0")).toMatchObject({ error: expect.stringContaining("at least 1") });
    expect(parseValue(settingOf("conformance-budget")!, "30 %")).toEqual({ value: "30%" });
    expect(parseValue(settingOf("harness-model")!, "opus")).toMatchObject({ error: expect.stringContaining("provider/id") });
    expect(parseValue(settingOf("harness-model")!, "anthropic/claude-opus-5-5:loud")).toMatchObject({ error: expect.stringContaining("thinks") });
    expect(parseValue(settingOf("harness-model")!, "acme/x", (model) => model !== "acme/x")).toMatchObject({ error: expect.stringContaining("can reach here") });
    expect(parseValue(settingOf("rules-off", ["concise-specs"])!, "concise-specs, nope")).toMatchObject({ error: expect.stringContaining("nope") });
    expect(parseValue(settingOf("review")!, "unset")).toEqual({ unset: true });
  });

  it("say what wins over a change: models: over the model keys, a stack's file over the project's", () => {
    writeFileSync(join(dir, "config.turri.backend.yaml"), "review: true\n");
    const text = writeSetting(dir, "review", false);
    expect(overriddenBy(dir, text, settingOf("review")!)).toEqual(["config.turri.backend.yaml sets review too, and wins while the stack backend is chosen."]);
    const models = writeSetting(dir, "models.chat", "openai/gpt-6-astra");
    expect(overriddenBy(dir, models, settingOf("harness-model")!)[0]).toContain("models.chat is set too");
    expect(readFileSync(join(dir, "config.turri.yaml"), "utf8")).toContain("review: false");
  });
});

function writeAndRead(text: string): string {
  writeFileSync(join(dir, "config.yaml"), text);
  return dir;
}
