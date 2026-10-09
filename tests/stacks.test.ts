import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chooseStack, chosenStack } from "../src/config.ts";
import { knownStacks, switchStack } from "../src/stacks.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "turri-stacks-"));
  writeFileSync(join(root, "config.turri.yaml"), "review: false\n");
  writeFileSync(join(root, "config.turri.backend.yaml"), "unittests-script: run_unittests_python.sh\n");
});
afterEach(() => {
  chooseStack(undefined);
  rmSync(root, { recursive: true, force: true });
});

describe("choosing a stack", () => {
  it("knows the stacks of the folder and of the projects one folder down", () => {
    mkdirSync(join(root, "plain"));
    writeFileSync(join(root, "plain", "config.turri.frontend.yaml"), "unittests-script: run_unittests_react.sh\n");
    expect(knownStacks(root)).toEqual(["backend", "frontend"]);
  });

  it("chooses one the project has a file for, or none, and says what everything is built with from now on", () => {
    expect(switchStack(root, "backend")).toContain("Stack backend chosen: everything is built with config.turri.backend.yaml over config.turri.yaml");
    expect(chosenStack()).toBe("backend");
    expect(switchStack(root, "none")).toContain("No stack chosen");
    expect(chosenStack()).toBeUndefined();
  });

  it("refuses a stack the project has no file for, naming the ones it has - and keeps the one chosen", () => {
    switchStack(root, "backend");
    expect(() => switchStack(root, "mobile")).toThrow("There is no stack mobile here. The stacks: backend - or none.");
    expect(chosenStack()).toBe("backend");
    rmSync(join(root, "config.turri.backend.yaml"));
    expect(() => switchStack(root, "backend")).toThrow("This project has no stacks");
  });
});
