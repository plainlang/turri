import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { describeStop } from "../../src/grow/stop-report.ts";
import { keepingTestsUnchanged, type TestRun, verifyUnitSuite } from "../../src/grow/testing.ts";
import { closeAllVms, runInVm, vmSupported } from "../../src/grow/vm.ts";
import { setScriptTimeoutForTests } from "../../src/grow/test-scripts.ts";
import { UNIT_SCRIPT, writeTestScripts, scriptsInForThisTest } from "../test-scripts.ts";

let root: string;
let code: string;
let tests: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "turri-gates-")));
  code = join(root, "plain_modules", "app", "code");
  tests = join(root, "plain_modules", "app", "tests");
  mkdirSync(code, { recursive: true });
  mkdirSync(tests, { recursive: true });
});
afterEach(async () => {
  await closeAllVms();
  rmSync(root, { recursive: true, force: true });
});

const passingTest = "import unittest\n\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n";
const failingTest = "import unittest\n\nclass T(unittest.TestCase):\n    def test_broken(self):\n        self.assertEqual(1, 2)\n";

describe.runIf(vmSupported())("the harness's own run of the unit tests", { timeout: 120_000 }, () => {
  const script = () => join(root, "test_scripts", "run_unittests_python.sh");
  beforeEach(() => writeTestScripts(root));

  it("is the project's unit testing script, whatever the agent ran - and sends back what it saw failing", async () => {
    writeFileSync(join(code, "test_app.py"), failingTest);
    // The agent's own run passed - on a command that runs nothing.
    const runs: TestRun[] = [{ command: "true", exitCode: 0 }];
    const verdict = await verifyUnitSuite(code, runs, script());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.prompt).toContain("The harness ran the project's unit testing script, `test_scripts/run_unittests_python.sh`");
      expect(verdict.prompt).toContain("test_broken");
    }
    expect(runs.at(-1)).toMatchObject({ command: "test_scripts/run_unittests_python.sh", exitCode: 1 });
  });

  it("passes when the script passes", async () => {
    writeFileSync(join(code, "test_app.py"), passingTest);
    expect(await verifyUnitSuite(code, [], script())).toEqual({ ok: true, command: "test_scripts/run_unittests_python.sh" });
  });

  it("runs the script as the project has it, not a copy an agent could have changed", async () => {
    writeFileSync(join(code, "test_app.py"), passingTest);
    writeTestScripts(root, { unit: "#!/bin/bash\necho from-the-project; exit 3\n" });
    const verdict = await verifyUnitSuite(code, [], script());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.prompt).toContain("from-the-project");
  });

  it("sends back why the tests failed however much a verbose script printed first, and keeps all of it", async () => {
    writeFileSync(join(code, "test_app.py"), failingTest);
    const noisy = UNIT_SCRIPT.replace("python3 -m unittest discover", "for i in $(seq 3000); do echo \"Downloading dependency $i of 3000\"; done\npython3 -m unittest discover");
    writeTestScripts(root, { unit: noisy });
    const verdict = await verifyUnitSuite(code, [], script());
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.prompt).toContain("test_broken");
    expect(verdict.prompt).toContain("AssertionError");
    const log = /the whole output is in (\S+?);/.exec(verdict.prompt)![1]!;
    expect(readFileSync(log, "utf8")).toContain("Downloading dependency 1 of 3000");
  });

  it("counts a run past the time limit as failed, stops it in the VM, and says what most often keeps tests from ending", async () => {
    setScriptTimeoutForTests(3000);
    onTestFinished(() => setScriptTimeoutForTests(undefined));
    writeTestScripts(root, { unit: "#!/bin/bash\necho running test_login_waits_for_server\nsleep 300\n" });

    const runs: TestRun[] = [];
    const verdict = await verifyUnitSuite(code, runs, script());

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.prompt).toContain("had not finished after 3 seconds - the");
    expect(verdict.prompt).toContain("counts as failed");
    expect(verdict.prompt).toContain("running test_login_waits_for_server");
    expect(verdict.prompt).toContain("a server or a watcher started in the foreground");
    expect(runs.at(-1)).toMatchObject({ exitCode: 124 });
    // Gone from the VM, not only given up on.
    const ps = await runInVm("ps -o stat,args | grep -v ' Z ' | grep -c 'sleep 300$' || true", { cwd: code });
    expect(ps.output.trim()).toBe("0");
  });

  it("stages every run somewhere new, so the VM never sees a copy an earlier run removed", async () => {
    scriptsInForThisTest("vm");
    writeFileSync(join(code, "test_app.py"), passingTest);
    writeTestScripts(root, { unit: "#!/bin/bash\necho \"staged in $1\"\nls \"$1\"\n" });
    const places = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      const verdict = await verifyUnitSuite(code, [], script());
      expect(verdict.ok).toBe(true);
    }
    const { runUnitScript } = await import("../../src/grow/test-scripts.ts");
    for (let i = 0; i < 3; i += 1) {
      const run = await runUnitScript(code, script());
      expect(run.output).toContain("test_app.py");
      places.add(/staged in (\S+)/.exec(run.output)![1]!);
    }
    expect(places.size).toBe(3);
  });

  it("leaves the code as it was: the script works on a copy", async () => {
    writeFileSync(join(code, "test_app.py"), passingTest);
    await verifyUnitSuite(code, [], script());
    expect(readdirSync(code).sort()).toEqual(["test_app.py"]);
  });
});

describe("the conformance tests, while an agent fixes the code", () => {
  it("are put back when it changes them, and it is sent to fix the code instead", async () => {
    writeFileSync(join(tests, "test_login.py"), "assert login() == 200\n");
    const prompts: string[] = [];

    const { report, restored } = await keepingTestsUnchanged({
      dirs: [tests],
      label: "app 2",
      start: async () => {
        // The shortcut: weaken the test, add a new one, delete nothing.
        writeFileSync(join(tests, "test_login.py"), "assert True\n");
        writeFileSync(join(tests, "test_extra.py"), "assert True\n");
        return "fixed";
      },
      again: async (prompt) => {
        prompts.push(prompt);
        writeFileSync(join(code, "login.py"), "def login(): return 200\n");
        return "fixed the code";
      },
    });

    expect(readFileSync(join(tests, "test_login.py"), "utf8")).toBe("assert login() == 200\n");
    expect(existsSync(join(tests, "test_extra.py"))).toBe(false);
    expect(restored).toEqual([join(tests, "test_extra.py"), join(tests, "test_login.py")]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("You changed conformance tests");
    expect(report).toBe("fixed the code");
  });

  it("are left alone, and nothing is asked again, when it leaves them alone", async () => {
    writeFileSync(join(tests, "test_login.py"), "assert login() == 200\n");
    let asked = 0;
    const result = await keepingTestsUnchanged({
      dirs: [tests],
      label: "app 2",
      start: async () => "fixed",
      again: async () => {
        asked += 1;
        return "again";
      },
    });
    expect(result).toEqual({ report: "fixed", restored: [] });
    expect(asked).toBe(0);
  });

  it("are put back even when it keeps changing them", async () => {
    writeFileSync(join(tests, "test_login.py"), "original\n");
    const tamper = async () => {
      writeFileSync(join(tests, "test_login.py"), "weakened\n");
      return "again";
    };
    await keepingTestsUnchanged({ dirs: [tests], label: "app", start: tamper, again: tamper });
    expect(readFileSync(join(tests, "test_login.py"), "utf8")).toBe("original\n");
  });

  it("include a test it deleted", async () => {
    writeFileSync(join(tests, "test_login.py"), "assert login() == 200\n");
    await keepingTestsUnchanged({
      dirs: [tests],
      label: "app",
      start: async () => {
        rmSync(join(tests, "test_login.py"));
        return "fixed";
      },
      again: async () => "fixed the code",
    });
    expect(readFileSync(join(tests, "test_login.py"), "utf8")).toBe("assert login() == 200\n");
  });
});

describe("when a build stops", () => {
  it("says where, why and what to change in the spec, for each gate", () => {
    const unit = describeStop({ moduleName: "app", frid: "3", at: "unit tests", runs: [{ command: "pytest", exitCode: 1 }] });
    expect(unit).toContain("Stopped at app functionality 3: after 20 attempts it still could not be built");
    expect(unit).toContain("What to change in the spec:");
    expect(unit).toContain("break-down-func-spec");
    expect(unit).toContain("implementation reqs");
    expect(unit).toContain("it picks up here");

    const conformance = describeStop({ moduleName: "app", frid: "3", at: "conformance" });
    expect(conformance).toContain("still disagree about what the spec means");
    expect(conformance).toContain("acceptance tests");
    expect(conformance).toContain("test reqs");

    const regression = describeStop({ moduleName: "app", frid: "3", at: "regression", repairs: 20 });
    expect(regression).toContain("broke what was built before it, and 20 attempts");
    expect(regression).toContain("resolve-spec-conflict");
  });

  it("says how many attempts there really were, not the most there could have been", () => {
    expect(describeStop({ moduleName: "rt_tuples", frid: "2", at: "unit tests", attempts: 3 })).toContain(
      "Stopped at rt_tuples functionality 2: after 3 attempts it still could not be built",
    );
    expect(describeStop({ moduleName: "app", frid: "1", at: "unit tests", attempts: 1 })).toContain("after 1 attempt it still");
    expect(describeStop({ moduleName: "app", frid: "1", at: "conformance", conformance: { runs: [], rounds: 4 } })).toContain(
      "after 4 rounds, its conformance tests",
    );
  });

  it("never sends the person to the code, the tests or the machine", () => {
    for (const at of ["unit tests", "conformance", "regression"] as const) {
      const text = describeStop({ moduleName: "app", frid: "3", at, runs: [{ command: "pytest", exitCode: 1 }] });
      for (const codeLevel of ["/watch", "install_system_packages", "turri doctor", "ALLOWED_HOSTS", "script", "exit 1", "pytest"]) {
        expect(text).not.toContain(codeLevel);
      }
    }
  });

  it("names a spec change for what it is", () => {
    expect(describeStop({ moduleName: "app", at: "unit tests" })).toContain("Stopped at the spec change in app:");
  });
});
