import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { conformanceDirFor, runInSandbox } from "../../src/render/conformance.ts";
import { ensureRegressionPasses, regenerateFunctionality, renderModule } from "../../src/render/module.ts";
import type { MarshalledPlainSource } from "../../src/plain/spec.ts";

const SIMPLE = "tests/data/simple.plain";
const EMPTY_TREE: MarshalledPlainSource = {};

let root: string;
let buildDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "forge-module-"));
  buildDir = join(root, "build");
  mkdirSync(buildDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("conformanceDirFor", () => {
  it("gives the module one directory, organised however its tests need", () => {
    expect(conformanceDirFor("demo", "/tmp/conf")).toBe("/tmp/conf/demo/tests");
  });
});

describe("runInSandbox with several test sets", () => {
  it("merges every set over the build", () => {
    writeFileSync(join(buildDir, "app.txt"), "hello");
    const one = join(root, "c", "1");
    const two = join(root, "c", "2");
    mkdirSync(one, { recursive: true });
    mkdirSync(two, { recursive: true });
    writeFileSync(join(one, "a.sh"), "cat app.txt");
    writeFileSync(join(two, "b.sh"), "echo second");

    const result = runInSandbox(buildDir, [one, two], "sh a.sh && sh b.sh");

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("hello");
    expect(result.output).toContain("second");
  });

  it("renames a clashing file instead of overwriting it", () => {
    const one = join(root, "c", "1");
    const two = join(root, "c", "2");
    mkdirSync(one, { recursive: true });
    mkdirSync(two, { recursive: true });
    writeFileSync(join(one, "test.sh"), "echo from-one");
    writeFileSync(join(two, "test.sh"), "echo from-two");

    const result = runInSandbox(buildDir, [one, two], "sh test.sh && sh 2_test.sh");

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("from-one");
    expect(result.output).toContain("from-two");
  });

  it("skips a set that does not exist yet", () => {
    writeFileSync(join(buildDir, "app.txt"), "hello");
    const missing = join(root, "c", "nope");

    expect(runInSandbox(buildDir, [missing], "cat app.txt").exitCode).toBe(0);
  });
});

describe("ensureRegressionPasses", () => {
  const base = {
    moduleName: "demo",
    tree: EMPTY_TREE,
    maxRounds: 0,
  };

  it("passes trivially when no functionality has tests yet", async () => {
    const result = await ensureRegressionPasses({
      ...base,
      buildDir,
      conformanceRoot: join(root, "conformance"),
      frids: ["1"],
      command: null,
    });

    expect(result.passed).toBe(true);
    expect(result.runs).toEqual([]);
  });

  it("runs every functionality's tests together, however they are organised", async () => {
    writeFileSync(join(buildDir, "app.txt"), "hello");
    const dir = conformanceDirFor("demo", join(root, "conformance"));
    mkdirSync(join(dir, "auth"), { recursive: true });
    writeFileSync(join(dir, "check_1.sh"), "cat app.txt");
    writeFileSync(join(dir, "auth", "check_2.sh"), "cat app.txt");

    const result = await ensureRegressionPasses({
      ...base,
      buildDir,
      conformanceRoot: join(root, "conformance"),
      frids: ["1", "2"],
      command: "sh check_1.sh && sh auth/check_2.sh",
    });

    expect(result.passed).toBe(true);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]!.frids).toEqual(["1", "2"]);
  });

  it("reports failure without repairing when no rounds are allowed", async () => {
    const dir = conformanceDirFor("demo", join(root, "conformance"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "check.sh"), "exit 1");

    const result = await ensureRegressionPasses({
      ...base,
      buildDir,
      conformanceRoot: join(root, "conformance"),
      frids: ["1"],
      command: "sh check.sh",
    });

    expect(result.passed).toBe(false);
    expect(result.repairs).toEqual([]);
  });
});

describe("renderModule", () => {
  it("rejects a --from that is not a functionality", async () => {
    await expect(renderModule({ plainFile: SIMPLE, from: "9", buildDir })).rejects.toThrow(
      "Functionality 9 does not exist.",
    );
  });

  it("rejects a --to that is not a functionality", async () => {
    await expect(renderModule({ plainFile: SIMPLE, to: "9", buildDir })).rejects.toThrow(
      "Functionality 9 does not exist.",
    );
  });
});

describe("regenerateFunctionality", () => {
  it("refuses when there is no code to regenerate", async () => {
    await expect(regenerateFunctionality({ plainFile: SIMPLE, frid: "1", buildDir })).rejects.toThrow(
      "Nothing to regenerate",
    );
  });

  it("rejects an unknown functionality id", async () => {
    writeFileSync(join(buildDir, "app.py"), "x = 1");
    await expect(regenerateFunctionality({ plainFile: SIMPLE, frid: "9", buildDir })).rejects.toThrow(
      "Functionality 9 does not exist. Available: 1.",
    );
  });
});
