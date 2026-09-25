import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { conformanceDirFor } from "../../src/render/conformance.ts";
import { runConformanceScript } from "../../src/render/test-scripts.ts";
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

describe("the conformance testing script, on several test sets", () => {
  // Lists the suite it was given, and runs each check from the build.
  const listing = () => {
    const script = join(root, "test_scripts", "run_conformance_tests_sh.sh");
    mkdirSync(join(root, "test_scripts"), { recursive: true });
    writeFileSync(script, 'cd "$1" || exit 2\nfor check in $(cd "$2" && find . -name "*.sh" | sort); do sh "$2/$check" || exit 1; done\n');
    return { conformance: script };
  };

  it("gets every set as one suite, over the build", async () => {
    writeFileSync(join(buildDir, "app.txt"), "hello");
    const one = join(root, "c", "1");
    const two = join(root, "c", "2");
    mkdirSync(one, { recursive: true });
    mkdirSync(two, { recursive: true });
    writeFileSync(join(one, "a.sh"), "cat app.txt");
    writeFileSync(join(two, "b.sh"), "echo second");

    const result = await runConformanceScript(buildDir, [one, two], listing());

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("hello");
    expect(result.output).toContain("second");
  });

  it("renames a clashing file instead of overwriting it", async () => {
    const one = join(root, "c", "1");
    const two = join(root, "c", "2");
    mkdirSync(one, { recursive: true });
    mkdirSync(two, { recursive: true });
    writeFileSync(join(one, "test.sh"), "echo from-one");
    writeFileSync(join(two, "test.sh"), "echo from-two");

    const result = await runConformanceScript(buildDir, [one, two], listing());

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("from-one");
    expect(result.output).toContain("from-two");
  });

  it("skips a set that does not exist yet", async () => {
    writeFileSync(join(buildDir, "app.txt"), "hello");
    expect((await runConformanceScript(buildDir, [join(root, "c", "nope")], listing())).exitCode).toBe(0);
  });
});

describe("ensureRegressionPasses", () => {
  // The project's conformance testing script: every check in the suite, run from the build.
  const scripts = () => {
    const script = join(root, "test_scripts", "run_conformance_tests_sh.sh");
    mkdirSync(join(root, "test_scripts"), { recursive: true });
    writeFileSync(script, 'cd "$1" || exit 2\nfor check in $(cd "$2" && find . -name "*.sh" | sort); do sh "$2/$check" || exit 1; done\n');
    return { conformance: script };
  };
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
      scripts: scripts(),
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
      scripts: scripts(),
    });

    expect(result.passed).toBe(true);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({ command: "test_scripts/run_conformance_tests_sh.sh", frids: ["1", "2"] });
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
      scripts: scripts(),
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
