import { describe, expect, it } from "vitest";
import { missingToolchain, scriptFailure } from "../../src/regenerate/test-scripts.ts";
import { describeStop } from "../../src/regenerate/stop-report.ts";

describe("a testing script that cannot find its toolchain", () => {
  it("names the command timeout could not run", () => {
    expect(missingToolchain({ exitCode: 127, output: "Running...\ntimeout: failed to run command ‘flutter’: No such file or directory\n" })).toEqual({ command: "flutter" });
  });

  it("names the command bash could not find", () => {
    expect(missingToolchain({ exitCode: 127, output: "/tmp/run_unittests.sh: line 30: flutter: command not found\n" })).toEqual({ command: "flutter" });
    expect(missingToolchain({ exitCode: 1, output: "bash: cargo: command not found\n" })).toEqual({ command: "cargo" });
  });

  it("takes exit 69 and 127 as a missing toolchain even when the output names none", () => {
    expect(missingToolchain({ exitCode: 69, output: "go is not installed" })).toEqual({});
    expect(missingToolchain({ exitCode: 127, output: "" })).toEqual({});
  });

  it("takes a failing test for a failing test", () => {
    expect(missingToolchain({ exitCode: 1, output: "FAILED (failures=1)\nAssertionError: 2 != 3" })).toBeUndefined();
  });

  it("tells the person what is missing - on this machine, where the testing scripts run - not to split the spec", () => {
    const told = describeStop({ moduleName: "game2048", at: "unit tests", attempts: 1, missingToolchain: { command: "flutter" } });
    expect(told).toContain("`flutter` is not installed on this machine");
    expect(told).toContain("Install flutter on this machine");
    expect(told).not.toContain("Split it");
    expect(told).not.toContain("vm-image");
  });

  it("tells the agent to stop, not to work around it, whatever the command", () => {
    const run = { command: "run_unittests.sh", exitCode: 127, output: "run.sh: line 2: no-such-toolchain-xyz: command not found", timeoutMs: 1000 };
    const told = scriptFailure(run, "unit testing");
    expect(told).toContain("Call report_environment_error");
    expect(told).not.toContain("install_system_packages");
  });
});
