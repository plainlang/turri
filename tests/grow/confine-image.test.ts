import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runConformanceScript } from "../../src/grow/test-scripts.ts";
import { runCommand } from "../../src/grow/testing.ts";
import { closeAllVms, installSystemPackages, runInVm, systemPackages, vmImage, vmSupported } from "../../src/grow/vm.ts";
import { scriptsInForThisTest } from "../test-scripts.ts";

let root: string;
let code: string;
let tests: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "turri-confine-"));
  code = join(root, "plain_modules", "demo", "code");
  tests = join(root, "plain_modules", "demo", "tests", "1");
  outside = join(root, "src");
  for (const dir of [code, tests, outside]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(outside, "secret.ts"), "const secret = 1;\n");
  writeFileSync(join(code, "app.py"), "print('hi')\n");
});

afterEach(async () => {
  // Each test is a project of its own, and so has a VM of its own.
  await closeAllVms();
  rmSync(root, { recursive: true, force: true });
});

// Each project gets one VM; the first ever also fetches the image.
const VM_TIMEOUT = 120_000;

describe.runIf(vmSupported() && vmImage() !== undefined)("the turri image", { timeout: VM_TIMEOUT }, () => {
  it("builds and runs Java, Go, Rust and C", async () => {
    writeFileSync(join(code, "a.c"), "int main(){return 0;}\n");
    writeFileSync(join(code, "m.go"), 'package main\nfunc main(){println("go-ok")}\n');
    writeFileSync(join(code, "m.rs"), 'fn main(){println!("rust-ok")}\n');
    writeFileSync(join(code, "M.java"), 'class M{public static void main(String[] a){System.out.println("java-ok");}}\n');
    const result = await runInVm(
      "gcc a.c -o a && ./a && echo c-ok; go run m.go; rustc m.rs -o mr && ./mr; java M.java; mvn -v | head -1; git --version",
      { cwd: code },
    );
    for (const ok of ["c-ok", "go-ok", "rust-ok", "java-ok", "Apache Maven", "git version"]) {
      expect(result.output).toContain(ok);
    }
  });

  it("lets a process in the code attach to itself, as tools that check who owns a file need", async () => {
    // The JVM only answers an attach whose trigger file, written to its working directory, is
    // its own - so the host folder's files have to be root's, as the VM's commands are.
    writeFileSync(
      join(code, "Self.java"),
      "public class Self { public static void main(String[] a) throws Exception {\n" +
        "  var vm = com.sun.tools.attach.VirtualMachine.attach(String.valueOf(ProcessHandle.current().pid()));\n" +
        '  System.out.println("attached"); vm.detach(); } }\n',
    );
    const result = await runInVm("stat -c %u Self.java && java -Djdk.attach.allowAttachSelf=true Self.java", { cwd: code });
    expect(result.output).toMatch(/^0\n/);
    expect(result.output).toContain("attached");
  });

  it("keeps a system package installed before, for every VM the project starts", async () => {
    const installed = await installSystemPackages(code, ["jq"]);
    expect(installed.exitCode).toBe(0);
    expect(systemPackages(code)).toEqual(["jq"]);

    await closeAllVms();
    const result = await runInVm("echo '{\"a\":1}' | jq .a", { cwd: code });
    expect(result.output.trim()).toBe("1");
  });

  it("refuses what is not a package name", async () => {
    const result = await installSystemPackages(code, ["jq; rm -rf /"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("Not an Alpine package name");
    expect(systemPackages(code)).toEqual([]);
  });
});

describe.runIf(vmSupported())("running the tests", { timeout: VM_TIMEOUT }, () => {
  it("cannot be used to read the spec above plain_modules", async () => {
    writeFileSync(join(root, "app.plain"), "***functional specs***\n");
    const result = await runCommand(code, "cat ../../../app.plain");
    expect(result.exitCode).not.toBe(0);
    expect(result.output).not.toContain("functional specs");
  });

  it("can still resolve its own working directory", async () => {
    const result = await runCommand(code, "python3 -c 'import os; print(os.path.abspath(\".\"))'");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(code);
  });

  it("still runs the tests themselves", async () => {
    expect(await runCommand(code, "python3 app.py")).toEqual({ exitCode: 0, output: "hi\n" });
  });

  it("runs the conformance testing script in the module's VM, on a copy inside plain_modules, and leaves nothing behind", async () => {
    scriptsInForThisTest("vm");
    writeFileSync(join(tests, "check.sh"), "python3 app.py; pwd\n");
    const script = (body: string) => {
      writeFileSync(join(root, "run_conformance_tests.sh"), body);
      return { conformance: join(root, "run_conformance_tests.sh") };
    };
    const result = await runConformanceScript(code, [tests], script('cd "$1" && sh "$2/check.sh"\n'));
    expect(result.output).toContain("hi\n");
    expect(result.output).toContain(join(root, "plain_modules", ".turri", "scripts"));
    expect(result.where).toBe("vm");
    // In the VM, which holds nothing above plain_modules.
    expect((await runConformanceScript(code, [tests], script(`cat ${join(outside, "secret.ts")}\n`))).exitCode).not.toBe(0);
    expect(readdirSync(join(root, "plain_modules", ".turri", "scripts"))).toEqual([]);
  });
});
