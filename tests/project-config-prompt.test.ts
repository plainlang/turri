import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectConfigBlock, machineBlock } from "../src/extension.ts";
import { onThisMachine } from "../src/grow/test-scripts.ts";

const onPath = (command: string) => onThisMachine(command) !== undefined;

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

describe("what the chat's agent is told about this machine", () => {
  it("says which wall is up, the toolchains each module's implementation reqs need and which this machine lacks, and what its testing scripts lack", async () => {
    writeFileSync(join(root, "game.plain"), "***implementation reqs***\n\n- :Implementation: is written in Odin.\n\n***functional specs***\n\n- Draw a square.\n");
    mkdirSync(join(root, "test_scripts"), { recursive: true });
    writeFileSync(join(root, "test_scripts", "run_unittests_odin.sh"), "#!/bin/bash\nexport ODIN_ROOT=$(/usr/libexec/no_such_odin_home)\nodin test .\n");
    const block = machineBlock(root);
    expect(block).toContain("<this machine>");
    expect(block).toContain("The agents' commands run on this machine, with its toolchains, behind the command check");
    if (!onPath("odin")) expect(block).toMatch(/game: its implementation reqs need Odin \(odin\) - this machine LACKS Odin/);
    expect(block).toContain("test_scripts/run_unittests_odin.sh does not fit this machine: it names `/usr/libexec/no_such_odin_home`, which this machine does not have");
    expect(block).not.toMatch(/VM|vm-image|managing-vms/);
  });
});
