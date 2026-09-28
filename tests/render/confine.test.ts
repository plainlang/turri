import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ceilingFor,
  confinedTools,
  ConfinementError,
  insideAny,
} from "../../src/render/confine.ts";
import { withActivity } from "../../src/render/activity.ts";
import { runConformanceScript } from "../../src/render/test-scripts.ts";
import { runCommand } from "../../src/render/testing.ts";
import { closeAllVms, installSystemPackages, runInVm, systemPackages, vmImage, vmSupported } from "../../src/render/vm.ts";

let root: string;
let code: string;
let tests: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plainwright-confine-"));
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

describe("ceilingFor", () => {
  it("stops at plain_modules", () => {
    expect(ceilingFor(code)).toBe(join(root, "plain_modules"));
    expect(ceilingFor(tests)).toBe(join(root, "plain_modules"));
  });

  it("makes a build directory elsewhere its own ceiling", () => {
    expect(ceilingFor("/tmp/sandbox/build")).toBe("/tmp/sandbox/build");
  });
});

describe("insideAny", () => {
  it("accepts the root itself and what is under it", () => {
    expect(insideAny(code, [code])).toBe(true);
    expect(insideAny(join(code, "pkg", "x.py"), [code])).toBe(true);
  });

  it("rejects a sibling whose name starts the same", () => {
    expect(insideAny(`${code}-other`, [code])).toBe(false);
  });

  it("rejects a walk back out", () => {
    expect(insideAny(join(code, "..", "..", "..", "src"), [code])).toBe(false);
  });
});

describe("confinedTools", () => {
  it("replaces the built-in file tools", () => {
    const fence = confinedTools({ workdir: code });
    expect(fence.names).toEqual(
      expect.arrayContaining(["read", "write", "edit", "ls", "grep", "find"]),
    );
  });

  const execute = (tool: any, params: unknown) =>
    tool.execute("id", params, undefined, undefined, {} as never);

  it("refuses a copy of the project's testing scripts, and a spec, in the codebase - pointing at the tools", async () => {
    const fence = confinedTools({ workdir: code });
    const write = fence.tools.find((tool) => tool.name === "write")!;
    await expect(execute(write, { path: "test_scripts/run_unittests_python.sh", content: "pytest\n" })).rejects.toThrow(/run_unit_tests and run_conformance_tests/);
    await expect(execute(write, { path: "run_conformance_tests_python.sh", content: "pytest\n" })).rejects.toThrow(/never copied, recreated or run by you/);
    await expect(execute(write, { path: "cognio.plain", content: "***definitions***\n" })).rejects.toThrow(/specs are not written here/);
    expect(existsSync(join(code, "test_scripts"))).toBe(false);
    // Anything else - a test of the code's own - is written as ever.
    await execute(write, { path: "tests/test_app.py", content: "def test_ok(): pass\n" });
    expect(existsSync(join(code, "tests", "test_app.py"))).toBe(true);
  });

  it("reaches every module in plain_modules", async () => {
    const fence = confinedTools({ workdir: tests });
    const read = fence.tools.find((t) => t.name === "read")!;
    const write = fence.tools.find((t) => t.name === "write")!;
    await expect(execute(read, { path: join(code, "app.py") })).resolves.toBeDefined();
    await execute(write, { path: join(root, "plain_modules", "other", "code", "x.py"), content: "x" });
    expect(existsSync(join(root, "plain_modules", "other", "code", "x.py"))).toBe(true);
  });

  it("refuses to read above plain_modules", async () => {
    const fence = confinedTools({ workdir: code });
    const read = fence.tools.find((t) => t.name === "read")!;

    await expect(execute(read, { path: join(outside, "secret.ts") })).rejects.toThrow(
      /outside this agent's read directory/,
    );
    await expect(execute(read, { path: "../../../src/secret.ts" })).rejects.toThrow(
      ConfinementError,
    );
    await expect(execute(read, { path: join(root, "app.plain") })).rejects.toThrow(ConfinementError);
  });

  it("refuses to write above plain_modules", async () => {
    const fence = confinedTools({ workdir: tests });
    const write = fence.tools.find((t) => t.name === "write")!;
    await expect(execute(write, { path: join(outside, "secret.ts"), content: "x" })).rejects.toThrow(
      /outside this agent's write directory/,
    );
    expect(readFileSync(join(outside, "secret.ts"), "utf8")).toBe("const secret = 1;\n");
  });

  it("refuses a pattern that climbs out", async () => {
    const fence = confinedTools({ workdir: code });
    const find = fence.tools.find((t) => t.name === "find")!;
    await expect(execute(find, { pattern: "../../**/*.ts" })).rejects.toThrow(/reaches outside/);
  });
});

// Each project gets one VM; the first ever also fetches the image.
const VM_TIMEOUT = 120_000;

describe.runIf(vmSupported())("the project's VM", { timeout: VM_TIMEOUT }, () => {
  const sh = (command: string, cwd = code) => runInVm(command, { cwd });

  it("lets the agent write its own folder - the code's shell has the code only, the tests' shell the tests and the code read only", async () => {
    const result = await sh(`echo built > out.txt && cat out.txt; ls ${tests} 2>&1 || true`);
    expect(result.output).toContain("built");
    expect(result.output).toContain("No such file or directory");
    expect(existsSync(join(code, "out.txt"))).toBe(true);

    // The tests' shell writes the tests, and reads and runs the code - but never changes it.
    const inTests = await sh(`echo t > t.txt && cat t.txt; python3 ${code}/app.py; echo x > ${code}/hack.txt 2>&1 || echo refused`, tests);
    expect(inTests.output).toContain("t\n");
    expect(inTests.output).toContain("hi");
    expect(inTests.output).toContain("refused");
    expect(existsSync(join(tests, "t.txt"))).toBe(true);
    expect(existsSync(join(code, "hack.txt"))).toBe(false);
  });

  it("does not hold the project above plain_modules at all", async () => {
    writeFileSync(join(root, "app.plain"), "***functional specs***\n");
    const result = await sh(`cat ../../../src/secret.ts ${join(outside, "secret.ts")} ${join(root, "app.plain")} 2>/dev/null; echo ---; ls -A ${root}`);
    expect(result.output).not.toContain("const secret");
    expect(result.output).not.toContain("functional specs");
    // Only the path down to plain_modules exists.
    expect(result.output.split("---\n")[1]).toBe("plain_modules\n");
  });

  it("does not hold the home directory, other projects, or the host's environment", async () => {
    const home = homedir();
    const result = await sh(`ls -A ${home} 2>&1; echo ---; env`);
    const [listing, env] = result.output.split("---\n");
    expect(listing).toMatch(/No such file or directory/);
    expect(env).not.toMatch(/API_KEY|ANTHROPIC|OPENAI/);
  });

  it("stops a write above plain_modules", async () => {
    const result = await sh(`echo bad > ${join(outside, "written.txt")}`);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(join(outside, "written.txt"))).toBe(false);
  });

  it("runs what is built there - binaries and scripts alike", async () => {
    writeFileSync(join(code, "run.sh"), "#!/bin/sh\necho script-ok\n");
    const result = await sh("chmod +x run.sh && ./run.sh");
    expect(result.output).toContain("script-ok");
  });

  it("stops a command that runs past its time limit - in the VM too - and says what to do instead", async () => {
    // A server it put in the background, and the command in the foreground that never ends.
    const result = await runInVm("sleep 301 > /dev/null 2>&1 & sleep 300", { cwd: code, timeoutMs: 2000 });
    expect(result.exitCode).toBe(124);
    expect(result.output).toContain("stopped after 2s, the time limit");
    expect(result.output).toContain("in the background");
    // Gone from the VM, not only given up on - and what it started with it.
    expect((await sh("ps -o stat,args | grep -v ' Z ' | grep -c 'sleep 30[01]$' || true")).output.trim()).toBe("0");
  });

  it("ends a command at once when its job is stopped - the agent's, a test run, the harness's", async () => {
    const stop = new AbortController();
    const quiet = { stage() {}, activity() {}, now() {}, usage() {}, transcript() {}, signal: stop.signal };
    const started = Date.now();
    const run = withActivity(quiet, () => runCommand(code, "sleep 300"));
    setTimeout(() => stop.abort(), 1500);
    await expect(run).rejects.toThrow("aborted");
    expect(Date.now() - started).toBeLessThan(15_000);
    expect((await sh("ps -o stat,args | grep -v ' Z ' | grep -c 'sleep 300$' || true")).output.trim()).toBe("0");
  });

  it("gives the agent's bash the timeout it asked for, and says when it ran out", async () => {
    const bash = confinedTools({ workdir: code }).tools.find((t) => t.name === "bash")!;
    expect(bash.description).toContain("start a server or a watcher in the background");
    const outcome = await (bash as any).execute("id", { command: "echo started; sleep 300", timeout: 2 }, undefined, undefined, {} as never).then(
      (result: any) => result.content.map((part: any) => part.text).join(""),
      (error: Error) => error.message,
    );
    expect(outcome).toContain("started");
    expect(outcome).toContain("stopped after 2s, the time limit");
  });

  it("runs several commands at once", async () => {
    const results = await Promise.all([1, 2, 3].map((n) => sh(`sleep 1; echo ${n}`)));
    expect(results.map((r) => r.output.trim())).toEqual(["1", "2", "3"]);
  });

  it("is the shell the agent's bash tool runs", async () => {
    const fence = confinedTools({ workdir: code });
    const bash = fence.tools.find((t) => t.name === "bash")!;
    const run = (command: string) =>
      (bash as any).execute("id", { command }, undefined, undefined, {} as never).then(
        (result: any) => result.content.map((part: any) => part.text).join(""),
        (error: Error) => error.message,
      );
    expect(await run("python3 app.py")).toContain("hi");
    expect(await run(`cat ${join(outside, "secret.ts")}`)).not.toContain("const secret");
    expect(bash.description).toContain("install_system_packages");
  });
});

describe.runIf(vmSupported() && vmImage() !== undefined)("the plainwright image", { timeout: VM_TIMEOUT }, () => {
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

  it("keeps a system package the agent installed, for every VM the project starts", async () => {
    const fence = confinedTools({ workdir: code });
    const install = fence.tools.find((t) => t.name === "install_system_packages")!;
    const installed = await (install as any).execute("id", { packages: ["jq"] }, undefined, undefined, {} as never);
    expect(installed.details.exitCode).toBe(0);
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

  it("runs the conformance testing script on this machine, on a copy inside plain_modules, and leaves nothing behind", async () => {
    writeFileSync(join(tests, "check.sh"), "python3 app.py; pwd\n");
    const script = (body: string) => {
      writeFileSync(join(root, "run_conformance_tests.sh"), body);
      return { conformance: join(root, "run_conformance_tests.sh") };
    };
    const result = await runConformanceScript(code, [tests], script('cd "$1" && sh "$2/check.sh"\n'));
    expect(result.output).toContain("hi\n");
    expect(result.output).toContain(join(root, "plain_modules", ".plainwright", "scripts"));
    // On the host, in its environment - not the VM, which holds nothing above plain_modules.
    const onHost = await runConformanceScript(code, [tests], script(`cat ${join(outside, "secret.ts")}\n`));
    expect(onHost.exitCode).toBe(0);
    expect(onHost.output).toContain("const secret = 1;");
    expect(readdirSync(join(root, "plain_modules", ".plainwright", "scripts"))).toEqual([]);
  });
});

describe("an agent's sandbox, in its system prompt", () => {
  it("says exactly what its file tools and its shell can reach, that nothing else exists, and not to try to get around it", async () => {
    const { confinedTools } = await import("../../src/render/confine.ts");
    const fence = confinedTools({ workdir: tests, read: [tests], write: [tests] });
    expect(fence.note).toContain("You work inside a sandbox, and only there.");
    expect(fence.note).toContain(`- Your file tools can read \`${tests}\`, and write \`${tests}\`.`);
    expect(fence.note).toContain("never try to get around the sandbox");
    if (vmSupported()) expect(fence.note).toMatch(/Your shell runs in a Linux VM that holds only `[^`]*tests[^`]*`/);
    // A judge: reads, writes nothing, no shell.
    const judge = confinedTools({ workdir: tests, read: [code, tests], write: [], noBash: true });
    expect(judge.note).toContain(`- Your file tools can read \`${code}\`, \`${tests}\`, and write nothing: you only read.`);
    expect(judge.note).toContain("- You have no shell.");
  });
});
