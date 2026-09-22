import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  describeRemovals,
  failingTestsPrompt,
  findTestRemovals,
  inventoryTests,
  removalChallengePrompt,
  runCommand,
} from "../../src/render/testing.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "forge-testing-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runCommand", () => {
  it("returns the output of a successful command", () => {
    expect(runCommand(dir, "echo hello")).toEqual({ exitCode: 0, output: "hello\n" });
  });

  it("returns the exit code and output of a failing command", () => {
    const result = runCommand(dir, "echo boom >&2; exit 2");
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("boom");
  });
});

describe("inventoryTests", () => {
  it("counts test cases across common idioms", () => {
    writeFileSync(join(dir, "test_app.py"), "def test_one():\n  pass\ndef test_two():\n  pass\n");
    writeFileSync(join(dir, "app.spec.ts"), "it('a', () => {});\nit('b', () => {});\nit('c', () => {});\n");
    writeFileSync(join(dir, "AppTest.java"), "@Test void a() {}\n@Test void b() {}\n");

    const inventory = inventoryTests(dir);

    expect(inventory.get("test_app.py")).toBe(2);
    expect(inventory.get("app.spec.ts")).toBe(3);
    expect(inventory.get("AppTest.java")).toBe(2);
  });

  it("ignores files that are not tests", () => {
    writeFileSync(join(dir, "app.py"), "def test_helper_name_only(): pass");
    expect(inventoryTests(dir).has("app.py")).toBe(false);
  });

  it("finds tests in subdirectories", () => {
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "tests", "test_nested.py"), "def test_a():\n  pass\n");
    expect(inventoryTests(dir).get("tests/test_nested.py")).toBe(1);
  });
});

describe("findTestRemovals", () => {
  it("reports a deleted test file", () => {
    writeFileSync(join(dir, "test_app.py"), "def test_one():\n  pass\n");
    const before = inventoryTests(dir);
    unlinkSync(join(dir, "test_app.py"));

    const removals = findTestRemovals(before, inventoryTests(dir));

    expect(removals).toEqual([{ file: "test_app.py", before: 1, after: 0, deleted: true }]);
  });

  it("reports a file that lost test cases", () => {
    writeFileSync(join(dir, "test_app.py"), "def test_one():\n  pass\ndef test_two():\n  pass\n");
    const before = inventoryTests(dir);
    writeFileSync(join(dir, "test_app.py"), "def test_one():\n  pass\n");

    expect(findTestRemovals(before, inventoryTests(dir))).toEqual([
      { file: "test_app.py", before: 2, after: 1, deleted: false },
    ]);
  });

  it("does not report added or unchanged tests", () => {
    writeFileSync(join(dir, "test_app.py"), "def test_one():\n  pass\n");
    const before = inventoryTests(dir);
    writeFileSync(join(dir, "test_app.py"), "def test_one():\n  pass\ndef test_two():\n  pass\n");
    writeFileSync(join(dir, "test_more.py"), "def test_three():\n  pass\n");

    expect(findTestRemovals(before, inventoryTests(dir))).toEqual([]);
  });
});

describe("the challenge the harness sends", () => {
  const removals = [{ file: "test_app.py", before: 3, after: 0, deleted: true }];

  it("names what went missing", () => {
    expect(describeRemovals(removals)).toBe("- test_app.py was deleted (it held ~3 tests)");
  });

  it("states the narrow ground on which a test may go", () => {
    const prompt = removalChallengePrompt(removals, "unit tests");
    expect(prompt).toContain("only acceptable when a test asserts nothing meaningful");
    expect(prompt).toContain("A test that is inconvenient, slow, or currently failing is not a reason");
    expect(prompt).toContain("Restore every test you removed");
  });
});

describe("failingTestsPrompt", () => {
  it("asks for a run when the agent never ran the tests", () => {
    expect(failingTestsPrompt([], "run_unit_tests")).toContain("have not run the tests yet");
  });

  it("quotes the failing command and forbids weakening tests", () => {
    const prompt = failingTestsPrompt([{ command: "pytest", exitCode: 1 }], "run_unit_tests");
    expect(prompt).toContain("`pytest` exited 1");
    expect(prompt).toContain("Do not remove or weaken a test to get a pass.");
  });
});

describe("chooseRegressionCommand", () => {
  it("prefers a command that discovers the whole suite", async () => {
    const { chooseRegressionCommand } = await import("../../src/render/testing.ts");
    const chosen = chooseRegressionCommand([
      { command: "python -m unittest discover", exitCode: 0 },
      { command: "python -m unittest test_conformance_2", exitCode: 0 },
    ]);
    expect(chosen).toEqual({ command: "python -m unittest discover", narrow: false });
  });

  it("flags a narrow command when nothing ran the whole suite", async () => {
    const { chooseRegressionCommand } = await import("../../src/render/testing.ts");
    expect(chooseRegressionCommand([{ command: "python -m unittest test_conformance_2", exitCode: 0 }])).toEqual({
      command: "python -m unittest test_conformance_2",
      narrow: true,
    });
  });

  it("ignores failing runs", async () => {
    const { chooseRegressionCommand } = await import("../../src/render/testing.ts");
    expect(
      chooseRegressionCommand([
        { command: "pytest", exitCode: 1 },
        { command: "python -m unittest test_x", exitCode: 0 },
      ]),
    ).toEqual({ command: "python -m unittest test_x", narrow: true });
  });

  it("returns nothing when no run passed", async () => {
    const { chooseRegressionCommand } = await import("../../src/render/testing.ts");
    expect(chooseRegressionCommand([{ command: "pytest", exitCode: 1 }])).toEqual({
      command: null,
      narrow: false,
    });
  });

  it("recognises whole-suite commands across ecosystems", async () => {
    const { isWholeSuiteCommand } = await import("../../src/render/testing.ts");
    for (const command of ["pytest", "npm test", "go test ./...", "mvn test", "gradle check", "cargo test"]) {
      expect(isWholeSuiteCommand(command), command).toBe(true);
    }
    for (const command of ["pytest tests/test_one.py", "python -m unittest test_two", "go test ./pkg"]) {
      expect(isWholeSuiteCommand(command), command).toBe(false);
    }
  });
});
