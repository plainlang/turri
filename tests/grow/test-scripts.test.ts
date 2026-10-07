import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { renderConformanceTests } from "../../src/grow/conformance.ts";
import { renderSpecDiff } from "../../src/grow/regrow.ts";
import { findTestScripts, projectRootFor, requireTestScripts, withTestingScripts } from "../../src/grow/test-scripts.ts";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "turri-test-scripts-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (path: string, content = "#!/bin/bash\n") => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
};

describe("finding the testing scripts", () => {
  it("looks in config.yaml first, then the project root, then test_scripts/", () => {
    put("test_scripts/run_unittests_python.sh");
    put("test_scripts/run_conformance_tests_python.sh");
    expect(findTestScripts(root)).toEqual({
      unit: join(root, "test_scripts/run_unittests_python.sh"),
      conformance: join(root, "test_scripts/run_conformance_tests_python.sh"),
    });

    put("run_unittests.sh");
    expect(findTestScripts(root).unit).toBe(join(root, "run_unittests.sh"));

    put("scripts/unit.sh");
    put("config.yaml", "template_dir: template\nunittests-script: scripts/unit.sh\nconformance-tests-script: test_scripts/run_conformance_tests_python.sh\n");
    expect(findTestScripts(root)).toEqual({
      unit: join(root, "scripts/unit.sh"),
      conformance: join(root, "test_scripts/run_conformance_tests_python.sh"),
    });
  });

  it("says so when config.yaml names a script that is not there, and looks further", () => {
    put("config.yaml", "unittests-script: test_scripts/run_unittests.sh\n");
    put("test_scripts/run_unittests_python.sh");
    const found = findTestScripts(root);
    expect(found.unit).toBe(join(root, "test_scripts/run_unittests_python.sh"));
    expect(found.notes?.unit).toContain("config.yaml names test_scripts/run_unittests.sh");
  });

  it("refuses a script config.yaml names inside plain_modules, where agents write", () => {
    put("plain_modules/app/code/run_unittests.sh");
    put("config.yaml", "unittests-script: plain_modules/app/code/run_unittests.sh\n");
    const found = findTestScripts(root);
    expect(found.unit).toBeUndefined();
    expect(found.notes?.unit).toContain("inside plain_modules - where agents write");
  });

  it("does not guess between two of a kind in one folder, and the stop says to name one", () => {
    put("test_scripts/run_unittests_python.sh");
    put("test_scripts/run_unittests_react.sh");
    const found = findTestScripts(root);
    expect(found.unit).toBeUndefined();
    expect(() => requireTestScripts("app", found, { conformance: false })).toThrow(
      /test_scripts\/ holds run_unittests_python.sh, run_unittests_react.sh - name the one to use in config.yaml/,
    );
  });

  it("stops a build with nothing to decide it, saying where it looked", () => {
    expect(() => requireTestScripts("app", findTestScripts(root), { conformance: false })).toThrow(
      /Stopped before building app: it has no unit testing script[\s\S]*config.yaml[\s\S]*unittests-script: <path>/,
    );
    put("run_unittests.sh");
    expect(() => requireTestScripts("app", findTestScripts(root), { conformance: true })).toThrow(/no conformance testing script/);
    expect(() => requireTestScripts("app", findTestScripts(root), { conformance: false })).not.toThrow();
  });

  it("belongs to the project that holds the build's plain_modules", () => {
    expect(projectRootFor("/p/specs/app.plain", "/p/plain_modules/app/code")).toBe("/p");
    expect(projectRootFor("/p/specs/app.plain", "/elsewhere/build")).toBe("/p/specs");
  });
});

describe("the testing scripts, in an agent's prompt", () => {
  it("are there whole, and only the kinds that judge its work", () => {
    put("test_scripts/run_unittests_python.sh", "#!/bin/bash\npython3 -m unittest discover\n");
    put("test_scripts/run_conformance_tests_python.sh", "#!/bin/bash\npytest \"$2\"\n");
    const scripts = findTestScripts(root);
    const both = withTestingScripts("Build it.", scripts, ["unit", "conformance"], root);
    expect(both).toContain('<script kind="unit tests" path="test_scripts/run_unittests_python.sh">\n#!/bin/bash\npython3 -m unittest discover\n</script>');
    expect(both).toContain('<script kind="conformance tests" path="test_scripts/run_conformance_tests_python.sh">');
    expect(both.endsWith("Build it.")).toBe(true);
    expect(withTestingScripts("Build it.", scripts, ["unit"], root)).not.toContain("conformance tests");
    // Shown, not to be run: the agent calls the tools.
    expect(both).toContain("not in your workspace");
    expect(both).toContain("Never copy, recreate or adapt them in the codebase");
    expect(both).toContain("call run_unit_tests and run_conformance_tests");
  });

  it("carry the unit testing script to the coding agent, and the conformance testing script to the conformance agent alone", async () => {
    put("test_scripts/run_unittests_python.sh", "#!/bin/bash\necho unit-script\n");
    put("test_scripts/run_conformance_tests_python.sh", "#!/bin/bash\necho conformance-script\n");
    // Linked from the spec too: it still comes once, as a testing script, never as a resource.
    writeFileSync(
      join(root, "app.plain"),
      "***implementation reqs***\n\n- Python.\n\n***test reqs***\n\n- Run with [the runner](test_scripts/run_conformance_tests_python.sh).\n\n***functional specs***\n\n- It prints hello.\n",
    );
    const cwd = process.cwd();
    process.chdir(root);
    onTestFinished(() => process.chdir(cwd));
    const buildDir = join(root, "plain_modules", "app", "code");

    const coding = (await renderSpecDiff({ plainFile: join(root, "app.plain"), diff: "+- It prints hello.", applied: "already applied", cwd: root, dryRun: true })).task!;
    expect(coding).toContain("echo unit-script");
    expect(coding).not.toContain("conformance-script");

    // The conformance agent tests code: there is some.
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(join(buildDir, "app.py"), "print('hello')\n");
    const conformance = (await renderConformanceTests({ plainFile: join(root, "app.plain"), frid: "1", buildDir, dryRun: true })).prompt;
    expect(conformance.match(/echo conformance-script/g)).toHaveLength(1);
    expect(conformance).not.toContain("<linked resources>\n");
  });
});

describe("the testing scripts, run", () => {
  it("run by default on the code in place, from the project - without the provider keys", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { runUnitScript } = await import("../../src/grow/test-scripts.ts");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "turri-host-scripts-")));
    const code = join(root, "plain_modules", "app", "code");
    mkdirSync(code, { recursive: true });
    writeFileSync(join(code, "app.py"), "print('hi')\n");
    const script = join(root, "run_unittests.sh");
    writeFileSync(script, 'echo "cwd=$(pwd)"; echo "build=$1"; ls "$1"; echo "key=${ANTHROPIC_API_KEY:-none}"; echo "host=$(uname -s)"\n');
    const before = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-secret";
    try {
      const run = await runUnitScript(code, script);
      expect(run.exitCode).toBe(0);
      expect(run.output).toContain(`cwd=${root}\n`);
      // In place: the real build folder, not a copy.
      expect(run.output).toContain(`build=${code}\n`);
      expect(run.output).toContain("app.py");
      expect(run.output).toContain("key=none");
      expect(run.output).toContain(`host=${process.platform === "darwin" ? "Darwin" : "Linux"}`);
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tell an agent a missing toolchain is the person's to install on this machine, and to end its turn", async () => {
    const { scriptFailure } = await import("../../src/grow/test-scripts.ts");
    const run = { command: "test_scripts/run_unittests_python.sh", exitCode: 69, output: "Error: Python 3.12 or newer is required", timeoutMs: 120_000 };
    const said = scriptFailure(run, "unit testing");
    expect(said).toContain("is not installed on this machine");
    expect(said).toContain("Call report_environment_error");
  });
});

describe("the testing scripts, run on a copy", () => {
  it("run with testing-scripts-run-on: copy on this machine, on a fresh copy of the code named for its module and the run, with the script copied beside it, in the person's environment but for the provider keys", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, readdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { runUnitScript } = await import("../../src/grow/test-scripts.ts");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "turri-copy-scripts-")));
    const code = join(root, "plain_modules", "app", "code");
    mkdirSync(code, { recursive: true });
    writeFileSync(join(code, "app.py"), "print('hi')\n");
    writeFileSync(join(root, "config.yaml"), "testing-scripts-run-on: copy\n");
    const script = join(root, "test_scripts", "run_unittests.sh");
    mkdirSync(join(root, "test_scripts"));
    writeFileSync(script, 'echo "build=$1"; ls "$1"; echo "me=$0"; echo "home=$HOME"; echo "key=${ANTHROPIC_API_KEY:-none}"; touch "$1/made-by-the-run"\n');
    const before = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-secret";
    try {
      const run = await runUnitScript(code, script);
      expect(run.exitCode, run.output).toBe(0);
      expect(run.output).toMatch(new RegExp(`build=${join(root, "plain_modules", ".turri", "scripts").replace(/[/.]/g, "\\$&")}/[\\w-]+/app-[\\w-]+\n`));
      expect(run.output).toContain("app.py");
      // The copy names itself as the project's script.
      expect(run.output).toContain("me=test_scripts/run_unittests.sh");
      // The person's own environment - their home - but not turri's provider keys.
      expect(run.output).toContain(`home=${process.env.HOME}`);
      expect(run.output).toContain("key=none");
      // The code is left as it was, and the copy is gone.
      expect(readdirSync(code)).toEqual(["app.py"]);
      expect(readdirSync(join(root, "plain_modules", ".turri", "scripts"))).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("no longer reads run-testing-scripts-in", async () => {
    const { mkdtempSync, writeFileSync, realpathSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { readProjectConfig } = await import("../../src/config.ts");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "turri-old-key-")));
    writeFileSync(join(root, "config.yaml"), "run-testing-scripts-in: host\n");
    expect(readProjectConfig(root).testingScriptsRunOn).toBeUndefined();
    writeFileSync(join(root, "config.yaml"), "testing-scripts-run-on: in-place\n");
    expect(readProjectConfig(root).testingScriptsRunOn).toBe("in-place");
    rmSync(root, { recursive: true, force: true });
  });
});
