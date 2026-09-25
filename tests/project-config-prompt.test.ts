import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectConfigBlock } from "../src/extension.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plainwright-config-prompt-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("what the chat's agent is told about the project's config.yaml", () => {
  it("says conformance is off when the file turns it off, and what else it sets", () => {
    mkdirSync(join(root, "test_scripts"));
    writeFileSync(join(root, "test_scripts", "run_unittests.sh"), "#!/bin/bash\n");
    writeFileSync(
      join(root, "config.yaml"),
      "unittests-script: test_scripts/run_unittests.sh\ncoding-model: amazon-bedrock/eu.anthropic.claude-sonnet-5\nharness-model: google/gemini-3.1-pro\nconformance-tests: false\nmodule: d365_restore_api.plain\n",
    );
    const block = projectConfigBlock(root);
    expect(block).toContain("conformance tests are OFF: renders write none and run none");
    expect(block).toContain("module: d365_restore_api.plain - the module to build when the user does not name one");
    expect(block).toContain("coding-model: amazon-bedrock/eu.anthropic.claude-sonnet-5");
    expect(block).toContain("unit testing script: test_scripts/run_unittests.sh");
    expect(block).toContain("conformance testing script: none found");
  });

  it("is nothing without a config.yaml", () => {
    expect(projectConfigBlock(root)).toBe("");
  });
});
