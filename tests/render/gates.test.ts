import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeStop } from "../../src/render/stop-report.ts";
import { keepingTestsUnchanged, type TestRun, verifyUnitSuite } from "../../src/render/testing.ts";
import { closeAllVms, vmSupported } from "../../src/render/vm.ts";

let root: string;
let code: string;
let tests: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "plainwright-gates-")));
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
  it("does not take a run that only named one target", async () => {
    const runs: TestRun[] = [{ command: "python3 -m pytest tests/test_one.py", exitCode: 0 }];
    const verdict = await verifyUnitSuite(code, runs);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.prompt).toContain("does not run the whole unit test suite");
  });

  it("does not take a command that runs nothing", async () => {
    const verdict = await verifyUnitSuite(code, [{ command: "true", exitCode: 0 }]);
    expect(verdict.ok).toBe(false);
  });

  it("runs the whole suite itself, and sends back what it saw failing", async () => {
    writeFileSync(join(code, "test_app.py"), failingTest);
    const runs: TestRun[] = [{ command: "python3 -m unittest discover", exitCode: 0 }];
    const verdict = await verifyUnitSuite(code, runs);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.prompt).toContain("The harness ran the whole unit test suite itself");
      expect(verdict.prompt).toContain("test_broken");
    }
    expect(runs.at(-1)).toMatchObject({ command: "python3 -m unittest discover", exitCode: 1 });
  });

  it("passes when its own run passes", async () => {
    writeFileSync(join(code, "test_app.py"), passingTest);
    const verdict = await verifyUnitSuite(code, [{ command: "python3 -m unittest discover", exitCode: 0 }]);
    expect(verdict).toEqual({ ok: true, command: "python3 -m unittest discover" });
  });

  it("uses the unit-test script the codebase carries over the agent's command", async () => {
    mkdirSync(join(code, "test_scripts"));
    writeFileSync(join(code, "test_scripts", "run_unittests_python.sh"), "#!/bin/bash\necho from-the-script\nexit 0\n");
    const verdict = await verifyUnitSuite(code, [{ command: "true", exitCode: 0 }]);
    expect(verdict).toEqual({ ok: true, command: "bash test_scripts/run_unittests_python.sh ." });
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

  it("never sends the person to the code, the tests or the machine", () => {
    for (const at of ["unit tests", "conformance", "regression"] as const) {
      const text = describeStop({ moduleName: "app", frid: "3", at, runs: [{ command: "pytest", exitCode: 1 }] });
      for (const codeLevel of ["/watch", "install_system_packages", "plainwright doctor", "ALLOWED_HOSTS", "script", "exit 1", "pytest"]) {
        expect(text).not.toContain(codeLevel);
      }
    }
  });

  it("names a spec change for what it is", () => {
    expect(describeStop({ moduleName: "app", at: "unit tests" })).toContain("Stopped at the spec change in app:");
  });
});
