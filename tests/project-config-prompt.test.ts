import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectConfigBlock, sandboxBlock } from "../src/extension.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "turri-config-prompt-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("what the chat's agent is told about the project's config.yaml", () => {
  it("says conformance is off when the file turns it off, and what else it sets", () => {
    mkdirSync(join(root, "test_scripts"));
    writeFileSync(join(root, "test_scripts", "run_unittests.sh"), "#!/bin/bash\n");
    writeFileSync(
      join(root, "config.yaml"),
      "unittests-script: test_scripts/run_unittests.sh\ncoding-model: amazon-bedrock/eu.anthropic.claude-sonnet-5\nharness-model: google/gemini-3.1-pro\nconformance-tests: false\nmodule: orders.plain\n",
    );
    const block = projectConfigBlock(root);
    expect(block).toContain("conformance tests are OFF: renders write none and run none");
    expect(block).toContain("module: orders.plain - the module to build when the user does not name one");
    expect(block).toContain("coding-model: amazon-bedrock/eu.anthropic.claude-sonnet-5");
    expect(block).toContain("unit testing script: test_scripts/run_unittests.sh");
    expect(block).toContain("conformance testing script: none found");
  });

  it("shows each module's own config file over the project's - its stack's scripts and models", () => {
    mkdirSync(join(root, "test_scripts"));
    for (const script of ["run_unittests_python.sh", "run_unittests_typescript.sh"]) writeFileSync(join(root, "test_scripts", script), "#!/bin/bash\n");
    writeFileSync(join(root, "config.yaml"), "harness-model: google/gemini-3.1-pro\ncoding-model: google/gemini-3.1-flash\n");
    writeFileSync(join(root, "config.backend.yaml"), "unittests-script: test_scripts/run_unittests_python.sh\n");
    writeFileSync(join(root, "config.frontend.yaml"), "unittests-script: test_scripts/run_unittests_typescript.sh\ncoding-model: amazon-bedrock/eu.anthropic.claude-sonnet-5\n");
    writeFileSync(join(root, "backend.plain"), "***functional specs***\n\n- Serve.\n");
    writeFileSync(join(root, "frontend.plain"), "***functional specs***\n\n- Show.\n");
    const block = projectConfigBlock(root);
    expect(block).toContain("unit testing script: none for the whole project - each module's file below names its own");
    const backend = block.slice(block.indexOf("config.backend.yaml, over config.yaml"), block.indexOf("config.frontend.yaml, over"));
    expect(backend).toContain("unit testing script: test_scripts/run_unittests_python.sh");
    expect(backend).toContain("coding-model: google/gemini-3.1-flash");
    expect(backend).not.toContain("harness-model");
    const frontend = block.slice(block.indexOf("config.frontend.yaml, over"));
    expect(frontend).toContain("unit testing script: test_scripts/run_unittests_typescript.sh");
    expect(frontend).toContain("coding-model: amazon-bedrock/eu.anthropic.claude-sonnet-5");
  });

  it("is nothing without a config.yaml", () => {
    expect(projectConfigBlock(root)).toBe("");
  });
});

describe("what the chat's agent is told about the sandbox VM", () => {
  it("names the image, what goes into it, what the project's implementation reqs need of it and it lacks, and the extra packages", async () => {
    process.env.TURRI_VM_IMAGE_CONFIG = join(root, "home-vm-image.json");
    try {
      writeFileSync(join(root, "config.yaml"), "system-packages: [sqlite]\nvm-image:\n  add: [zig]\n  remove: [java]\n");
      writeFileSync(join(root, "game.plain"), "***implementation reqs***\n\n- :Implementation: is written in Zig.\n\n***functional specs***\n\n- Draw a square.\n");
      const block = sandboxBlock(root);
      expect(block).toContain("<sandbox VM>");
      expect(block).toContain("the managing-vms rule says how they work");
      expect(block).toContain("then this project's vm-image: in config.yaml");
      expect(block).toMatch(/game: its implementation reqs need Zig \(zig\)/);
      expect(block).toContain("system-packages: in config.yaml - sqlite");
      // Its own image is not built here: it takes a build.
      expect(block).toContain("build_vm_image");
    } finally {
      delete process.env.TURRI_VM_IMAGE_CONFIG;
    }
  });

  it("is backed by the managing-vms rule, loaded with the ***plain rules", async () => {
    const { loadRules } = await import("../src/rules.ts");
    const rule = loadRules("forge/rules").find((item) => item.name === "managing-vms");
    expect(rule?.content).toContain("Against the implementation reqs");
    expect(rule?.content).toContain("build_vm_image");
  });
});

