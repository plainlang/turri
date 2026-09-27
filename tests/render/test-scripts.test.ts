import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { renderFunctionality } from "../../src/render/render.ts";
import { findTestScripts, projectRootFor, requireTestScripts, withTestingScripts } from "../../src/render/test-scripts.ts";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "plainwright-test-scripts-")));
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

  it("carry the conformance testing script to the coding agent only when conformance tests are written", async () => {
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
    const prompt = async (conformance?: boolean) =>
      (await renderFunctionality({ plainFile: join(root, "app.plain"), frid: "1", buildDir: join(root, "plain_modules", "app", "code"), dryRun: true, conformance })).prompt;

    const on = await prompt();
    expect(on).toContain("echo unit-script");
    expect(on.match(/echo conformance-script/g)).toHaveLength(1);
    expect(on).not.toContain("<linked resources>");

    const off = await prompt(false);
    expect(off).toContain("echo unit-script");
    expect(off).not.toContain("conformance-script");
  });
});

describe("the testing scripts, run", () => {
  it("run on this machine, from the project, on a fresh copy of the code - never in the VM, and without the provider keys", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { runUnitScript } = await import("../../src/render/test-scripts.ts");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plainwright-host-scripts-")));
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
      // A copy named for its module and the run, so two modules testing at once never share /tmp/<lang>_<name>.
      expect(run.output).toMatch(new RegExp(`build=${join(root, "plain_modules", ".plainwright", "scripts")}/[\\w-]+/app-[\\w-]+\\n`));
      expect(run.output).toContain("app.py");
      expect(run.output).toContain("key=none");
      expect(run.output).toContain(`host=${process.platform === "darwin" ? "Darwin" : "Linux"}`);
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
