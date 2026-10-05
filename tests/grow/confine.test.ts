import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { confinedTools, ConfinementError, insideAny } from "../../src/grow/confine.ts";
import { closeAllVms, vmSupported } from "../../src/grow/vm.ts";

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

  it("refuses a credential file - the person's to provide - but writes a template of one", async () => {
    const fence = confinedTools({ workdir: code });
    const write = fence.tools.find((tool) => tool.name === "write")!;
    await expect(execute(write, { path: ".env", content: "HUBSPOT_ACCESS_TOKEN=dummy\n" })).rejects.toThrow(/the person's to provide - never an agent's to write/);
    await expect(execute(write, { path: "config/.env.test", content: "A=1\n" })).rejects.toThrow(/holds credentials/);
    expect(existsSync(join(code, ".env"))).toBe(false);
    await execute(write, { path: ".env.example", content: "HUBSPOT_ACCESS_TOKEN=\n" });
    expect(existsSync(join(code, ".env.example"))).toBe(true);
  });

  it("refuses the record of what the code is built from - it is the harness's to write", async () => {
    const fence = confinedTools({ workdir: code });
    const write = fence.tools.find((tool) => tool.name === "write")!;
    const edit = fence.tools.find((tool) => tool.name === "edit")!;
    await expect(execute(write, { path: ".turri.json", content: "{}\n" })).rejects.toThrow(/the harness's record of what the code is built from/);
    await expect(execute(edit, { path: ".turri.json", edits: [{ oldText: "{", newText: "[" }] })).rejects.toThrow(/no agent does/);
  });

  it("reads and writes only its own module's code - not a sibling module, not turri's scratch, not the module's lineage", async () => {
    // The coding agent's and the regression repair's fence: the default, from their code folder.
    const sibling = join(root, "plain_modules", "other", "code");
    const scratch = join(root, "plain_modules", ".turri", "logs");
    const lineage = join(root, "plain_modules", "demo", ".plaingit");
    for (const dir of [sibling, scratch, lineage]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "x.txt"), "theirs\n");
    }
    const fence = confinedTools({ workdir: code });
    const read = fence.tools.find((t) => t.name === "read")!;
    const write = fence.tools.find((t) => t.name === "write")!;
    const ls = fence.tools.find((t) => t.name === "ls")!;
    for (const dir of [sibling, scratch, lineage]) {
      await expect(execute(read, { path: join(dir, "x.txt") })).rejects.toThrow(/outside this agent's read directory/);
      await expect(execute(write, { path: join(dir, "x.txt"), content: "mine\n" })).rejects.toThrow(/outside this agent's write directory/);
      expect(readFileSync(join(dir, "x.txt"), "utf8")).toBe("theirs\n");
    }
    await expect(execute(ls, { path: ".." })).rejects.toThrow(ConfinementError);
    await expect(execute(read, { path: "app.py" })).resolves.toBeDefined();
    await execute(write, { path: "pkg/new.py", content: "x = 1\n" });
    expect(existsSync(join(code, "pkg", "new.py"))).toBe(true);
    expect(fence.note).toContain(`- Your file tools can read \`${code}\`, and write \`${code}\`.`);
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

describe("an agent's sandbox, in its system prompt", () => {
  it("says exactly what its file tools and its shell can reach, that nothing else exists, and not to try to get around it", async () => {
    const { confinedTools } = await import("../../src/grow/confine.ts");
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

describe("the walls, as an agent is told them", () => {
  it("never points into turri's own scratch area, which it is told not to go looking for", async () => {
    const { sandboxNote } = await import("../../src/grow/confine.ts");
    const scratch = join(root, "plain_modules", ".turri");
    const note = sandboxNote({ read: [code], write: [code], shell: [join(root, "plain_modules", "demo"), scratch] });
    expect(note).toContain(`- Your shell runs in a Linux VM that holds only \`${join(root, "plain_modules", "demo")}\`.`);
    expect(note).not.toContain(".turri");
    expect(note).not.toContain("copies test runs use");
  });

  it("gives every agent with a shell read_output, and keeps the shell from pointing at a file outside its walls", async () => {
    const fence = confinedTools({ workdir: code });
    expect(fence.names).toContain("read_output");
    if (!vmSupported()) return;
    const bash = fence.tools.find((t) => t.name === "bash")!;
    const result = await bash.execute("id", { command: "seq 1 5000" }, undefined, undefined, undefined);
    const text = result.content[0].text as string;
    expect(text).toMatch(/The whole output is kept as `[^`]+`: read it with read_output\]$/);
    expect(text).not.toMatch(/Full output: \//);
  });
});
