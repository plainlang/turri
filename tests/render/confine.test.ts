import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ceilingFor,
  confinedTools,
  ConfinementError,
  insideAny,
  runConfined,
  sandboxSupported,
} from "../../src/render/confine.ts";
import { runInSandbox } from "../../src/render/conformance.ts";
import { runCommand } from "../../src/render/testing.ts";

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

afterEach(() => {
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
    const fence = confinedTools({ workdir: code, read: [], write: [code] });
    expect(fence.names).toEqual(
      expect.arrayContaining(["read", "write", "edit", "ls", "grep", "find"]),
    );
  });

  it("refuses a root above the module root", () => {
    expect(() => confinedTools({ workdir: code, read: [root], write: [code] })).toThrow(
      ConfinementError,
    );
  });

  it("allows the test directory to read the code beside it", () => {
    const fence = confinedTools({ workdir: tests, read: [code], write: [tests] });
    expect(fence.names).toContain("read");
  });

  const execute = (tool: any, params: unknown) =>
    tool.execute("id", params, undefined, undefined, {} as never);

  it("refuses to read outside its roots", async () => {
    const fence = confinedTools({ workdir: code, read: [], write: [code] });
    const read = fence.tools.find((t) => t.name === "read")!;

    await expect(execute(read, { path: join(outside, "secret.ts") })).rejects.toThrow(
      /outside this agent's read directory/,
    );
    await expect(execute(read, { path: "../../../src/secret.ts" })).rejects.toThrow(
      ConfinementError,
    );
  });

  it("refuses to write outside its roots", async () => {
    const fence = confinedTools({ workdir: tests, read: [code], write: [tests] });
    const write = fence.tools.find((t) => t.name === "write")!;

    // It may read the code, but the code is not its to change.
    await expect(execute(write, { path: join(code, "app.py"), content: "x" })).rejects.toThrow(
      /outside this agent's write directory/,
    );
    expect(existsSync(join(code, "app.py"))).toBe(true);
  });

  it("refuses a pattern that climbs out", async () => {
    const fence = confinedTools({ workdir: code, read: [], write: [code] });
    const find = fence.tools.find((t) => t.name === "find")!;
    await expect(execute(find, { pattern: "../../**/*.ts" })).rejects.toThrow(/reaches outside/);
  });
});

describe.runIf(sandboxSupported())("the sandboxed shell", () => {
  it("lets the agent write inside its own directory", () => {
    const result = runConfined(
      { workdir: code, read: [code], write: [code] },
      "echo built > out.txt && cat out.txt",
    );
    expect(result.status).toBe(0);
    expect(result.output).toContain("built");
  });

  it("stops a write outside it", () => {
    const result = runConfined(
      { workdir: code, read: [code], write: [code] },
      `echo bad > ${join(outside, "written.txt")}`,
    );
    expect(result.status).not.toBe(0);
    expect(existsSync(join(outside, "written.txt"))).toBe(false);
  });

  it("stops a read of the project above plain_modules", () => {
    const result = runConfined(
      { workdir: code, read: [code], write: [code] },
      `cat ${join(outside, "secret.ts")}`,
    );
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain("const secret");
  });

  it("still lets ordinary tooling run", () => {
    const result = runConfined({ workdir: code, read: [code], write: [code] }, "python3 -c 'print(2+2)'");
    expect(result.status).toBe(0);
    expect(result.output).toContain("4");
  });
});

describe.runIf(sandboxSupported())("running the tests", () => {
  it("cannot be used to read the spec above plain_modules", () => {
    writeFileSync(join(root, "app.plain"), "***functional specs***\n");
    const result = runCommand(code, "cat ../../../app.plain");
    expect(result.exitCode).not.toBe(0);
    expect(result.output).not.toContain("functional specs");
  });

  it("cannot write outside the directory it runs in", () => {
    const result = runCommand(code, `echo bad > ${join(outside, "written.txt")}`);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(join(outside, "written.txt"))).toBe(false);
  });

  it("can still resolve its own working directory", () => {
    const result = runCommand(code, "python3 -c 'import os; print(os.path.abspath(\".\"))'");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("code");
  });

  it("still runs the tests themselves", () => {
    expect(runCommand(code, "python3 app.py")).toEqual({ exitCode: 0, output: "hi\n" });
  });

  it("fences a conformance run to its throwaway copy", () => {
    writeFileSync(join(tests, "check.sh"), "python3 app.py\n");
    expect(runInSandbox(code, tests, "sh check.sh").output).toBe("hi\n");
    expect(runInSandbox(code, tests, `cat ${join(outside, "secret.ts")}`).exitCode).not.toBe(0);
    expect(runInSandbox(code, tests, `cat ${join(code, "app.py")}`).exitCode).not.toBe(0);
  });
});
