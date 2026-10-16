import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordHistory } from "../../src/regenerate/lineage.ts";
import { createCanItFailTool, createMyDiffTool, selfCheckNote } from "../../src/regenerate/self-check.ts";
import { unitReviewTask } from "../../src/regenerate/unit-review.ts";
import { createAskExplorerTool } from "../../src/regenerate/conformance-agents.ts";

let root: string;
let code: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "turri-self-check-")));
  code = join(root, "plain_modules", "app", "code");
  mkdirSync(code, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map((part) => part.text ?? "").join("");
const call = async (tool: { execute: (...args: never[]) => unknown }, params: object) =>
  text((await (tool.execute as (...args: unknown[]) => Promise<{ content: Array<{ type: string; text?: string }> }>)("id", params, undefined, undefined, {})));

describe("my_diff", () => {
  it("shows the work as the reviewer is shown it: the code folder from the commit the work started from, a new file whole", async () => {
    writeFileSync(join(code, "app.py"), "print('hello')\n");
    recordHistory(code, "built hello");
    writeFileSync(join(code, "app.py"), "print('hello, world')\n");
    writeFileSync(join(code, "extra.py"), "x = 1\n");
    const diff = await call(createMyDiffTool({ dir: code, what: "code" }), {});
    expect(diff).toContain("+print('hello, world')");
    expect(diff).toContain("-print('hello')");
    expect(diff).toContain("+x = 1");
  });

  it("says so when nothing has changed", async () => {
    writeFileSync(join(code, "app.py"), "print('hello')\n");
    recordHistory(code, "built hello");
    expect(await call(createMyDiffTool({ dir: code, what: "code" }), {})).toBe("Nothing in the code folder has changed yet.");
  });
});

describe("the coding agent told to check its own work", () => {
  it("by the tools it has, and not at all with none", () => {
    expect(selfCheckNote(["my_diff", "can_it_fail"]).join("\n")).toMatch(/can_it_fail.*read my_diff/);
    expect(selfCheckNote(["my_diff"]).join("\n")).not.toContain("can_it_fail");
    expect(selfCheckNote([])).toEqual([]);
  });

  it("and the reviewer told to check a test it doubts - only when it can", () => {
    const options = { buildDir: "/b", what: "the change", spec: "<spec>", forChange: true };
    expect(unitReviewTask({ ...options, canItFail: true })).toContain("A test you doubt can fail, check: can_it_fail");
    expect(unitReviewTask(options)).not.toContain("can_it_fail");
  });
});

describe("can_it_fail", () => {
  it("takes only a change it can make: in a code file, of text that is there exactly once", async () => {
    writeFileSync(join(code, "calc.sh"), "add() { echo $(( $1 + $2 )); }\n# add adds\n# add adds\n");
    const tool = createCanItFailTool({ buildDir: code, script: join(root, "run_unittests.sh") });
    expect(await call(tool, { file: "nope.sh", find: "x", replace: "y" })).toContain("There is no nope.sh");
    expect(await call(tool, { file: "../../../escape.sh", find: "x", replace: "y" })).toContain("is not in the code folder");
    expect(await call(tool, { file: "calc.sh", find: "$1 * $2", replace: "y" })).toContain("is not in calc.sh");
    expect(await call(tool, { file: "calc.sh", find: "# add adds", replace: "#" })).toContain("more than once");
    expect(await call(tool, { file: "calc.sh", find: "$1 + $2", replace: "$1 + $2" })).toContain("changes nothing");
  });

  describe("run on a copy", () => {
    beforeEach(() => writeFileSync(join(root, "config.yaml"), "testing-scripts-run-on: copy\n"));

    it("runs the unit tests on a copy with the bug in - fails when a test catches it, passes when none does - and never touches the code", async () => {
      const source = "add() { echo $(( $1 + $2 )); }\n# the sum of two numbers\n";
      writeFileSync(join(code, "calc.sh"), source);
      const script = join(root, "test_scripts", "run_unittests.sh");
      mkdirSync(join(root, "test_scripts"));
      writeFileSync(script, 'cd "$1" && . ./calc.sh && [ "$(add 1 2)" = 3 ] && echo ok || { echo "add 1 2 is not 3"; exit 1; }\n');
      const tool = createCanItFailTool({ buildDir: code, script });
      const caught = await call(tool, { file: "calc.sh", find: "$1 + $2", replace: "$1 - $2" });
      expect(caught).toContain("The unit tests fail with calc.sh changed: something catches it.");
      expect(caught).toContain("add 1 2 is not 3");
      const missed = await call(tool, { file: "calc.sh", find: "the sum of two numbers", replace: "anything" });
      expect(missed).toContain("Every unit test passes with calc.sh changed: no test catches this bug.");
      expect(readFileSync(join(code, "calc.sh"), "utf8")).toBe(source);
    }, 300_000);

    it("gives up soon on a bug that makes the code hang, and says it hung - never that a test caught it", async () => {
      const { runUnitScript } = await import("../../src/regenerate/test-scripts.ts");
      writeFileSync(join(code, "calc.sh"), "add() { echo $(( $1 + $2 )); }\n");
      const script = join(root, "test_scripts", "run_unittests.sh");
      mkdirSync(join(root, "test_scripts"));
      writeFileSync(script, 'cd "$1" && . ./calc.sh && [ "$(add 1 2)" = 3 ] || exit 1\n');
      // A passing run first: the limit is three times as long as it took, and never under 15 seconds.
      expect((await runUnitScript(code, script)).exitCode).toBe(0);
      const started = Date.now();
      const hung = await call(createCanItFailTool({ buildDir: code, script }), { file: "calc.sh", find: "echo $(( $1 + $2 ))", replace: "while true; do :; done" });
      const limit = Number(/did not finish in (\d+)s with calc\.sh changed: the bug makes the code hang/.exec(hung)?.[1]);
      expect(limit).toBeGreaterThanOrEqual(15);
      expect(limit).toBeLessThanOrEqual(60);
      expect(hung).not.toContain("something catches it");
      expect(Date.now() - started).toBeLessThan((limit + 30) * 1000);
    }, 300_000);
  });
});

describe("can_it_fail, the testing scripts run in place", () => {
  const source = "add() { echo $(( $1 + $2 )); }\n# the sum of two numbers\n";
  let script: string;
  /** A unit testing script as an embedded integration's is: it finds the code from where it sits, not from its argument. */
  const fromItsOwnPath = 'cd "$(dirname "$0")/../plain_modules/app/code" && . ./calc.sh && [ "$(add 1 2)" = 3 ] && echo ok || { echo "add 1 2 is not 3"; exit 1; }\n';
  beforeEach(() => {
    writeFileSync(join(code, "calc.sh"), source);
    mkdirSync(join(root, "test_scripts"));
    script = join(root, "test_scripts", "run_unittests.sh");
    writeFileSync(script, fromItsOwnPath);
  });

  it("is given to every agent that has a unit testing script, and says the change is made to the code and put back", () => {
    const tool = createCanItFailTool({ buildDir: code, script });
    expect(tool.description).toContain("runs with that change made to the code, which is put back as it was once the run ends");
    expect(tool.description).not.toContain("copy");
  });

  it("runs alone, never beside another call - an edit made while the bug is in would be undone with it", () => {
    expect(createCanItFailTool({ buildDir: code, script }).executionMode).toBe("sequential");
  });

  it("makes the change to the code itself - so a script that finds the code from its own path sees it - and puts it back", async () => {
    const tool = createCanItFailTool({ buildDir: code, script });
    const caught = await call(tool, { file: "calc.sh", find: "$1 + $2", replace: "$1 - $2" });
    expect(caught).toContain("The unit tests fail with calc.sh changed: something catches it.");
    expect(caught).toContain("add 1 2 is not 3");
    expect(readFileSync(join(code, "calc.sh"), "utf8")).toBe(source);
    const missed = await call(tool, { file: "calc.sh", find: "the sum of two numbers", replace: "anything" });
    expect(missed).toContain("Every unit test passes with calc.sh changed: no test catches this bug.");
    expect(readFileSync(join(code, "calc.sh"), "utf8")).toBe(source);
  }, 60_000);

  it("puts the file back as it was even when the script rewrote it during the run, as a formatter in fix mode does", async () => {
    writeFileSync(script, 'echo "formatted" > "$(dirname "$0")/../plain_modules/app/code/calc.sh"; exit 1\n');
    await call(createCanItFailTool({ buildDir: code, script }), { file: "calc.sh", find: "$1 + $2", replace: "$1 - $2" });
    expect(readFileSync(join(code, "calc.sh"), "utf8")).toBe(source);
  }, 60_000);

  it("puts the file back after a bug that makes the code hang, and says it hung - never that a test caught it", async () => {
    const { runUnitScript } = await import("../../src/regenerate/test-scripts.ts");
    // A passing run in place first: the limit is three times as long as it took, and never under 15 seconds.
    expect((await runUnitScript(code, script)).exitCode).toBe(0);
    const hung = await call(createCanItFailTool({ buildDir: code, script }), { file: "calc.sh", find: "echo $(( $1 + $2 ))", replace: "while true; do :; done" });
    expect(hung).toMatch(/did not finish in 15s with calc\.sh changed: the bug makes the code hang/);
    expect(hung).not.toContain("something catches it");
    expect(readFileSync(join(code, "calc.sh"), "utf8")).toBe(source);
  }, 120_000);

  it("puts the file back when the run itself fails to start", async () => {
    const { runOnCode } = await import("../../src/regenerate/test-scripts.ts");
    const missing = join(root, "test_scripts", "gone.sh");
    const run = await runOnCode(code, missing, "unit testing script, with the change", { file: "calc.sh", text: "broken" }).catch((error: unknown) => error);
    expect(run).toBeDefined();
    expect(readFileSync(join(code, "calc.sh"), "utf8")).toBe(source);
  }, 60_000);

  it("refuses a second change to a file another run has changed already, and puts back the first's original", async () => {
    const { runOnCode } = await import("../../src/regenerate/test-scripts.ts");
    writeFileSync(script, "sleep 1\n");
    const first = runOnCode(code, script, "unit testing script, with the change", { file: "calc.sh", text: "first" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readFileSync(join(code, "calc.sh"), "utf8")).toBe("first");
    await expect(runOnCode(code, script, "unit testing script, with the change", { file: "calc.sh", text: "second" })).rejects.toThrow(/being changed for another run already/);
    await first;
    expect(readFileSync(join(code, "calc.sh"), "utf8")).toBe(source);
  }, 60_000);

  it("puts the file back when turri exits during the run", () => {
    writeFileSync(script, "sleep 30\n");
    const module = resolve("src/regenerate/test-scripts.ts");
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `const { runOnCode } = await import(${JSON.stringify(module)}); setTimeout(() => process.exit(3), 1000); await runOnCode(${JSON.stringify(code)}, ${JSON.stringify(script)}, "unit testing script, with the change", { file: "calc.sh", text: "the bug" });`],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(child.status).toBe(3);
    expect(readFileSync(join(code, "calc.sh"), "utf8")).toBe(source);
  }, 60_000);
});

describe("ask_explorer", () => {
  it("puts the conformance agent's question to the explorer, a few times a run at most", async () => {
    const asked: string[] = [];
    const tool = createAskExplorerTool({ ask: async (question) => (asked.push(question), `It is POST /contacts, body {"email"}.`), questions: 2 });
    expect(await call(tool, { question: "How is a contact created?" })).toContain('It is POST /contacts, body {"email"}.\n\n(1 question left)');
    await call(tool, { question: "And deleted?" });
    expect(await call(tool, { question: "And listed?" })).toContain("No questions left in this run");
    expect(asked).toEqual(["How is a contact created?", "And deleted?"]);
  });
});
