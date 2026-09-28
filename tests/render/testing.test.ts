import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  describeRemovals,
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
  it("returns the output of a successful command", async () => {
    expect(await runCommand(dir, "echo hello")).toEqual({ exitCode: 0, output: "hello\n" });
  });

  it("returns the exit code and output of a failing command", async () => {
    const result = await runCommand(dir, "echo boom >&2; exit 2");
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

describe("long output, as an agent is shown it", () => {
  it("is shown whole up to 60,000 characters - every failing test's whole trace - and past that, its last 60,000", async () => {
    const { truncateOutput } = await import("../../src/render/testing.ts");
    const traces = Array.from({ length: 30 }, (_, n) => `FAILED test_${n}\nTraceback (most recent call last):\n${"  frame\n".repeat(150)}AssertionError: ${n}`).join("\n");
    expect(traces.length).toBeGreaterThan(20_000);
    expect(truncateOutput(traces, "/p/log")).toBe(traces);
    const output = `toolchain: python 3.12\n${"installing a dependency\n".repeat(4000)}FAILED test_login - AssertionError: 401 != 200\n`;
    const shown = truncateOutput(output, "/p/plain_modules/.plainwright/logs/run.log");
    expect(shown).toMatch(/^\.\.\. \[\d+ characters cut from the start - the whole output is in \/p\/plain_modules\/\.plainwright\/logs\/run\.log; read it with read or grep\] \.\.\.\n\n/);
    expect(shown.endsWith(output.slice(-60_000))).toBe(true);
    expect(shown).not.toContain("toolchain: python 3.12");
    expect(truncateOutput("short")).toBe("short");
  });

  it("is kept whole in plain_modules, where the agent can read it, when it had to be cut", async () => {
    const { keepFullOutput } = await import("../../src/render/testing.ts");
    const root = mkdtempSync(join(tmpdir(), "plainwright-logs-"));
    const code = join(root, "plain_modules", "app", "code");
    mkdirSync(code, { recursive: true });
    const long = "x".repeat(70_000);
    const file = keepFullOutput(code, "run_unittests_python.sh", long)!;
    expect(file.startsWith(join(root, "plain_modules", ".plainwright", "logs"))).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(long);
    expect(keepFullOutput(code, "short", "ok")).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });
});
