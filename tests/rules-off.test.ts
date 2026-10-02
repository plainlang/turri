import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProjectConfig } from "../src/config.ts";
import { loadRules } from "../src/rules.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("rules a project leaves out", () => {
  it("are read from config.yaml's rules-off", () => {
    const dir = mkdtempSync(join(tmpdir(), "turri-rules-off-"));
    dirs.push(dir);
    writeFileSync(join(dir, "config.yaml"), "rules-off:\n  - integrations\n  - integration-standalone.md\n");
    expect(readProjectConfig(dir).rulesOff).toEqual(["integrations", "integration-standalone.md"]);
  });

  it("are left out of the rules, by name with or without .md, and the rest stay", () => {
    const all = loadRules(join(process.cwd(), "forge", "rules")).map((rule) => rule.name);
    const kept = loadRules(join(process.cwd(), "forge", "rules"), ["integrations", "integration-standalone.md"]).map((rule) => rule.name);
    expect(all).toContain("integrations");
    expect(kept).not.toContain("integrations");
    expect(kept).not.toContain("integration-standalone");
    expect(kept).toContain("integration-embedded");
    expect(kept).toHaveLength(all.length - 2);
  });
});
