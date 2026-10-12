import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordHistory } from "../../src/grow/lineage.ts";
import { createCanItFailTool, createMyDiffTool, selfCheckNote } from "../../src/grow/self-check.ts";
import { findStaticChecks } from "../../src/grow/test-scripts.ts";
import { unitReviewTask } from "../../src/grow/unit-review.ts";
import { createAskExplorerTool } from "../../src/grow/conformance-agents.ts";

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

describe("the static checks", () => {
  it("are optional: found when the project has one script for them, or names one in its config - and nothing otherwise", () => {
    expect(findStaticChecks(root)).toBeUndefined();
    mkdirSync(join(root, "test_scripts"));
    writeFileSync(join(root, "test_scripts", "run_static_checks_python.sh"), "#!/bin/bash\nruff check \"$1\"\n");
    expect(findStaticChecks(root)).toBe(join(root, "test_scripts", "run_static_checks_python.sh"));
    // Two of them: neither is guessed at.
    writeFileSync(join(root, "test_scripts", "run_static_checks_ts.sh"), "#!/bin/bash\n");
    expect(findStaticChecks(root)).toBeUndefined();
    writeFileSync(join(root, "config.yaml"), "static-checks-script: test_scripts/run_static_checks_ts.sh\n");
    expect(findStaticChecks(root)).toBe(join(root, "test_scripts", "run_static_checks_ts.sh"));
  });

  it("are never taken from plain_modules, where agents write", () => {
    writeFileSync(join(root, "config.yaml"), "static-checks-script: plain_modules/app/code/check.sh\n");
    writeFileSync(join(code, "check.sh"), "exit 0\n");
    expect(findStaticChecks(root)).toBeUndefined();
  });
});

describe("the coding agent told to check its own work", () => {
  it("by the tools it has, and not at all with none", () => {
    expect(selfCheckNote(["my_diff", "can_it_fail", "run_static_checks"]).join("\n")).toMatch(/run_static_checks as you go.*they count.*can_it_fail.*read my_diff/);
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
      const { runUnitScript } = await import("../../src/grow/test-scripts.ts");
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
