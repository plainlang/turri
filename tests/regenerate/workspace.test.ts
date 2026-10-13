import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workspaceBlock } from "../../src/regenerate/workspace.ts";

/**
 * What an agent is told up front about its folder and this machine - what the hycu runs' agents went looking for: git
 * history, Maven's setup, the toolchains' versions.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-workspace-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const versions: Record<string, string> = {
  java: 'openjdk version "21.0.8" 2025-07-15',
  mvn: "Apache Maven 3.9.11 (3e54c93a704957b63ee3494413a2b544fd3d825b)",
  python3: "Python 3.12.4",
};
const probe = (command: string) => versions[command];

describe("your folder", () => {
  it("says an empty folder holds nothing yet, and there is nothing above it to find", () => {
    const block = workspaceBlock({ dir, hasMyDiff: true, implementationReqs: [], probe });
    expect(block).toContain(`- Your folder, \`${dir}\`, is empty: nothing is built yet, and there is nothing above it to find.`);
  });

  it("says code that was committed passed its unit tests then - no need to run them before changing anything", () => {
    writeFileSync(join(dir, "App.java"), "class App {}\n");
    writeFileSync(join(dir, ".turri.json"), "{}\n");
    const block = workspaceBlock({ dir, hasMyDiff: true, implementationReqs: [], probe });
    expect(block).toContain("holds the code built so far, and its unit tests passed when it was committed: you need not run them before you change anything.");
  });

  it("says it is no git repository, and what shows the work instead - only where the agent has my_diff", () => {
    expect(workspaceBlock({ dir, hasMyDiff: true, implementationReqs: [], probe })).toContain(
      "- It is not a git repository, and none above it is yours: `my_diff` shows what you have changed in this pulse.",
    );
    expect(workspaceBlock({ dir, hasMyDiff: false, implementationReqs: [], probe })).toContain("- It is not a git repository, and none above it is yours.");
  });
});

describe("this machine", () => {
  it("gives the versions of the toolchains the implementation reqs name, probed on this machine", () => {
    const block = workspaceBlock({ dir, hasMyDiff: true, implementationReqs: ["- :Implementation: is a Spring Boot service in Java 21, built with Maven."], probe });
    expect(block).toContain('- Java: openjdk version "21.0.8" 2025-07-15; Apache Maven 3.9.11 (3e54c93a704957b63ee3494413a2b544fd3d825b).');
    expect(block).not.toContain("Python");
  });

  it("says a toolchain the reqs name and this machine lacks is missing - the person's to install", () => {
    const block = workspaceBlock({ dir, hasMyDiff: true, implementationReqs: ["- Written in Go."], probe });
    expect(block).toContain("- Go: not on this machine - report it with report_environment_error if the work needs it.");
  });

  it("says where dependencies come from without naming turri's scratch area, and what to leave set", () => {
    const block = workspaceBlock({ dir, hasMyDiff: true, implementationReqs: ["- Java with Maven."], probe });
    expect(block).toContain("The network is open: the build tools fetch what the manifest declares.");
    expect(block).toContain("Maven's local repository is set for you, a cache shared by the project's modules: you need not look for it");
    expect(block).toContain("`JAVA_TOOL_OPTIONS` gives every JVM its temporary folder and home");
    expect(block).not.toContain(".turri");
  });
});
