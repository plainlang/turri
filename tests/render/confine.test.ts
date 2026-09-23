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
import { runInSandbox } from "../../src/render/conformance.ts";
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

  it("lets the agent write anywhere in plain_modules", async () => {
    const result = await sh(`echo built > out.txt && echo t > ${join(tests, "t.txt")} && cat out.txt`);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("built");
    expect(existsSync(join(code, "out.txt"))).toBe(true);
    expect(existsSync(join(tests, "t.txt"))).toBe(true);
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

  it("runs a conformance suite in a copy inside plain_modules, and leaves nothing behind", async () => {
    writeFileSync(join(tests, "check.sh"), "python3 app.py; pwd\n");
    const result = await runInSandbox(code, tests, "sh check.sh");
    expect(result.output).toContain("hi\n");
    expect(result.output).toContain(join(root, "plain_modules", ".plainwright", "runs"));
    expect((await runInSandbox(code, tests, `cat ${join(outside, "secret.ts")}`)).exitCode).not.toBe(0);
    expect(readdirSync(join(root, "plain_modules", ".plainwright", "runs")).flatMap((key) => readdirSync(join(root, "plain_modules", ".plainwright", "runs", key)))).toEqual([]);
  });
});
