import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { readProjectConfig } from "../../src/config.ts";
import { runConformanceScript, runUnitScript, setScriptTimeoutForTests } from "../../src/render/test-scripts.ts";

/**
 * An integration embedded in a host codebase, laid out like my-awesome-crm: the host at the top,
 * its specs, config.yaml and plain_modules in plain/, and testing scripts that find the host from
 * their own place and merge the generated package into it.
 */
let host: string;
let project: string;
let code: string;
let tests: string;
beforeEach(() => {
  host = realpathSync(mkdtempSync(join(tmpdir(), "plainwright-host-")));
  project = join(host, "plain");
  code = join(project, "plain_modules", "hubspot", "code");
  tests = join(project, "plain_modules", "hubspot", "tests");
  mkdirSync(join(code, "src", "integrations", "hubspot"), { recursive: true });
  mkdirSync(tests, { recursive: true });
  mkdirSync(join(project, "test_scripts"), { recursive: true });
  mkdirSync(join(host, "src", "integrations"), { recursive: true });
  writeFileSync(join(code, "src", "integrations", "hubspot", "client.py"), "x = 1\n");
  writeFileSync(join(tests, "test_hubspot.py"), "t = 1\n");
  writeFileSync(join(project, "config.yaml"), "unittests-script: test_scripts/run_unittests.sh\nrun-testing-scripts-in: host\n");
});
afterEach(() => rmSync(host, { recursive: true, force: true }));

const embedded = (extra = "") =>
  [
    "#!/bin/bash",
    'PLAIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"',
    'HOST="$(cd "$PLAIN_DIR/.." && pwd)"',
    'echo "plain: $PLAIN_DIR"; echo "cwd: $(pwd)"; echo "build: $1"; echo "tests: $2"',
    'echo "key: ${ANTHROPIC_API_KEY:-none}"',
    'cp -R "$1/src/integrations/." "$HOST/src/integrations/"',
    extra,
  ].join("\n");

describe("run-testing-scripts-in: host", () => {
  it("is read from the project's config.yaml, beside the specs", () => {
    expect(readProjectConfig(project).runTestingScriptsIn).toBe("host");
    expect(readProjectConfig(host).runTestingScriptsIn).toBeUndefined();
    // Its name before is read the same, so a project written for it keeps running its scripts where it did.
    writeFileSync(join(host, "config.yaml"), "testing-scripts: host\n");
    expect(readProjectConfig(host).runTestingScriptsIn).toBe("host");
    writeFileSync(join(host, "config.yaml"), "run-testing-scripts-in: vm\n");
    expect(readProjectConfig(host).runTestingScriptsIn).toBe("vm");
  });

  it("runs the scripts in place - at their own path, from plain/, on the real folders - so they merge into the real host", async () => {
    writeFileSync(join(project, "test_scripts", "run_unittests.sh"), embedded());
    process.env.ANTHROPIC_API_KEY = "sk-secret";
    onTestFinished(() => delete process.env.ANTHROPIC_API_KEY);

    const unit = await runUnitScript(code, join(project, "test_scripts", "run_unittests.sh"));
    expect(unit.exitCode).toBe(0);
    expect(unit.output).toContain(`plain: ${project}`);
    expect(unit.output).toContain(`cwd: ${project}`);
    expect(unit.output).toContain(`build: ${code}`);
    expect(unit.output).toContain("key: none");
    expect(readFileSync(join(host, "src", "integrations", "hubspot", "client.py"), "utf8")).toBe("x = 1\n");
    // Nothing copied into a fake host in plainwright's scratch.
    expect(existsSync(join(project, "plain_modules", ".plainwright", "src"))).toBe(false);

    writeFileSync(join(project, "test_scripts", "run_conformance_tests.sh"), embedded());
    const conformance = await runConformanceScript(code, [tests], { conformance: join(project, "test_scripts", "run_conformance_tests.sh") });
    expect(conformance.output).toContain(`tests: ${tests}`);
  });

  it("still stops a run past the time limit, and what it started with it", async () => {
    setScriptTimeoutForTests(1500);
    onTestFinished(() => setScriptTimeoutForTests(undefined));
    const marker = join(host, "still-running");
    writeFileSync(join(project, "test_scripts", "run_unittests.sh"), embedded(`(sleep 3; touch ${marker}) & sleep 30`));
    const run = await runUnitScript(code, join(project, "test_scripts", "run_unittests.sh"));
    expect(run).toMatchObject({ exitCode: 124, timedOut: true });
    await new Promise((done) => setTimeout(done, 2500));
    expect(existsSync(marker)).toBe(false);
  });
});
