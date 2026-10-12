import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { conformanceStatus } from "../src/extension.ts";

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "turri-conformance-status-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const WITH = "***implementation reqs***\n\n- Python.\n\n***test reqs***\n\n- pytest.\n\n***functional specs***\n\n- Say hello.\n";

describe("the status bar's conformance", () => {
  it("says what config.yaml says, when it says it", () => {
    writeFileSync(join(dir, "config.yaml"), "conformance-tests: false\n");
    expect(conformanceStatus(dir)).toBe("conformance off (config.yaml)");
    writeFileSync(join(dir, "config.yaml"), "conformance-tests: true\n");
    expect(conformanceStatus(dir)).toBe("conformance on (config.yaml)");
  });

  it("is off when the config does not set it, whatever the module's test reqs", () => {
    writeFileSync(join(dir, "app.plain"), WITH);
    writeFileSync(join(dir, "config.yaml"), "module: app.plain\n");
    expect(conformanceStatus(dir)).toBe("conformance off - not set (config.yaml)");
  });

  it("finds a project one folder down, and says nothing where there is none", () => {
    expect(conformanceStatus(dir)).toBeUndefined();
    mkdirSync(join(dir, "plain"));
    writeFileSync(join(dir, "plain", "config.yaml"), "conformance-tests: false\n");
    expect(conformanceStatus(dir)).toBe("conformance off (config.yaml)");
  });
});
