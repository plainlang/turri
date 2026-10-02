import { describe, expect, it } from "vitest";
import { missingToolchain, needsThePerson, scriptFailure } from "../../src/grow/test-scripts.ts";
import { describeStop } from "../../src/grow/stop-report.ts";

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

  it("tells the person what is missing and where, not to split the spec", () => {
    const vm = describeStop({ moduleName: "game2048", at: "unit tests", attempts: 3, missingToolchain: { command: "flutter", where: "vm" } });
    expect(vm).toContain("`flutter` is not installed in the sandbox VM");
    expect(vm).toContain("vm-image");
    expect(vm).not.toContain("Split it");

    const host = describeStop({ moduleName: "game2048", at: "unit tests", attempts: 1, missingToolchain: { command: "flutter", where: "host" } });
    expect(host).toContain("`flutter` is not installed on this machine");
    expect(host).toContain("Install flutter on this machine");
  });

  it("points at running the scripts on this machine when the command is installed here", () => {
    const vm = describeStop({ moduleName: "app", at: "unit tests", missingToolchain: { command: "sh", where: "vm" } });
    expect(vm).toMatch(/It is installed on this machine \(.*\/sh\): set `run-testing-scripts-in: host`/);
  });

  it("always needs the person: the agents install nothing", () => {
    expect(needsThePerson({ command: "anything-at-all-xyz" }, "host")).toBe(true);
    expect(needsThePerson({ command: "no-such-toolchain-xyz" }, "vm")).toBe(true);
    expect(needsThePerson({}, "vm")).toBe(true);
  });

  it("tells the agent to stop, not to work around it, whatever the command", () => {
    const run = { command: "run_unittests.sh", exitCode: 127, output: "run.sh: line 2: no-such-toolchain-xyz: command not found", timeoutMs: 1000, where: "vm" as const };
    const told = scriptFailure(run, "unit testing");
    expect(told).toContain("End your turn");
    expect(told).not.toContain("install_system_packages");
  });
});
