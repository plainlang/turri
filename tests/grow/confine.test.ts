import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { confinedTools, ConfinementError, insideAny, sandboxNote } from "../../src/grow/confine.ts";

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
    expect(fence.note).toContain(`You work in one folder: \`${code}\`. Your file tools read and write it, and nothing else.`);
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

describe("an agent's walls, in its system prompt", () => {
  it("names its own folder, says its shell runs on this machine with its own home and temp folder, and what happens on a reach outside", () => {
    const fence = confinedTools({ workdir: code });
    expect(fence.note).toContain(`You work in one folder: \`${code}\`. Your file tools read and write it, and nothing else.`);
    expect(fence.note).toContain(`Your shell runs on this machine, in \`${code}\`, with this machine's toolchains.`);
    expect(fence.note).toContain("(`$HOME`, `$TMPDIR`)");
    expect(fence.note).toContain("A command that names a path outside is refused before it runs. Anything a command changes outside is\n  put back, and you are told.");
    expect(fence.note).toContain("If a port is taken by something else, use another port.");
    expect(fence.note).not.toMatch(/VM|every attempt fails|cheat/);
    expect(fence.note).not.toContain(".turri");
  });

  it("tells the conformance agent it reads the code and writes only tests, in its shell too - and the code fixer the other way round", async () => {
    const conformance = sandboxNote({ read: [tests, code], write: [tests], shell: true });
    expect(conformance).toContain(`You work in \`${tests}\`. Your file tools read and write it. They also read \`${code}\` - the code under test - but never write it: you write tests, not code.`);
    expect(conformance).toContain(`\`${code}\` is read only in your shell too.`);
    const fixer = sandboxNote({ read: [code, tests], write: [code], shell: true });
    expect(fixer).toContain("the conformance tests the code must pass - but never write it: you fix the code, not the tests.");
  });

  it("tells a reading role it writes nothing, shell included - and one with no shell that it has none", () => {
    const explorer = confinedTools({ workdir: code, read: [code], write: [] });
    expect(explorer.note).toContain(`You read \`${code}\`, and write nothing: not with your file tools, not with your shell.`);
    const judge = confinedTools({ workdir: tests, read: [code, tests], write: [], noBash: true });
    expect(judge.note).toContain(`You read \`${code}\` and \`${tests}\`, and write nothing.`);
    expect(judge.note).toContain("You have no shell.");
  });

  it("names the tool a missing piece of the machine is reported with, once there is one", () => {
    expect(sandboxNote({ read: [code], write: [code], shell: true })).toContain("say so plainly - what is missing and what needs it - and end your turn");
    expect(sandboxNote({ read: [code], write: [code], shell: true, environmentTool: "report_environment_error" })).toContain("report it as an environment error with report_environment_error");
  });
});

describe("an agent's bash, on this machine", () => {
  const run = (bash: any, command: string, timeout?: number) =>
    bash.execute("id", { command, ...(timeout !== undefined ? { timeout } : {}) }, undefined, undefined, {} as never).then(
      (result: any) => result.content.map((part: any) => part.text).join(""),
      (error: Error) => error.message,
    );

  it("runs commands in its folder, and refuses one that names a path outside - not running it", async () => {
    const bash = confinedTools({ workdir: code }).tools.find((t) => t.name === "bash")!;
    expect(await run(bash, "python3 app.py")).toContain("hi");
    const refused = await run(bash, `touch ran; cat ${join(outside, "secret.ts")}`);
    expect(refused).toMatch(/Not run: .*is outside what this command may reach/);
    expect(existsSync(join(code, "ran"))).toBe(false);
    expect(bash.description).toContain("You install nothing on the machine");
  });

  it("refuses a credential file it would write", async () => {
    const bash = confinedTools({ workdir: code }).tools.find((t) => t.name === "bash")!;
    expect(await run(bash, "echo TOKEN=dummy > .env")).toMatch(/Not run: \.env holds credentials/);
    expect(existsSync(join(code, ".env"))).toBe(false);
  });

  it("gives a command the timeout it asked for, and says when it ran out", async () => {
    const bash = confinedTools({ workdir: code }).tools.find((t) => t.name === "bash")!;
    expect(bash.description).toContain("start a server or a watcher in the background");
    const outcome = await run(bash, "echo started; sleep 300", 2);
    expect(outcome).toContain("started");
    expect(outcome).toContain("stopped after 2s, the time limit");
  });

  it("keeps a reading role's shell from writing its folder", async () => {
    const bash = confinedTools({ workdir: code, read: [code], write: [] }).tools.find((t) => t.name === "bash")!;
    await run(bash, 'P="$PWD"; echo x > "$P/new.py"');
    expect(existsSync(join(code, "new.py"))).toBe(false);
  });
});

describe("the walls, as an agent is told them", () => {
  it("never points into turri's own scratch area, which it is told not to go looking for", () => {
    const note = sandboxNote({ read: [code], write: [code], shell: true });
    expect(note).not.toContain(".turri");
    expect(note).not.toContain("copies test runs use");
  });

  it("gives every agent with a shell read_output, and keeps the shell from pointing at a file outside its walls", async () => {
    const fence = confinedTools({ workdir: code });
    expect(fence.names).toContain("read_output");
    const bash = fence.tools.find((t) => t.name === "bash")!;
    const result = await bash.execute("id", { command: "seq 1 5000" }, undefined, undefined, undefined);
    const text = result.content[0].text as string;
    expect(text).toMatch(/The whole output is kept as `[^`]+`: read it with read_output\]$/);
    expect(text).not.toMatch(/Full output: \//);
  });
});
