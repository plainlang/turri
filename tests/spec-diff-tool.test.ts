import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What each render was told the change is, and where it landed, in order. */
const rendered: string[] = [];
const renderedIn: string[] = [];
// A render that lands leaves code, and the record of what it is built from, committed - as the real one does.
vi.mock("../src/grow/regrow.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/grow/regrow.ts")>();
  return {
    ...actual,
    renderSpecDiff: async (options: { diff: string; spec: { tree: object; chain: Array<{ moduleName: string; buildDir: string }> } }) => {
      const tip = options.spec.chain.at(-1)!;
      rendered.push(options.diff);
      renderedIn.push(tip.moduleName);
      mkdirSync(tip.buildDir, { recursive: true });
      writeFileSync(join(tip.buildDir, `${tip.moduleName}.py`), "# built\n", { flag: "a" });
      (await import("../src/grow/records.ts")).writeCodeRecord(tip.buildDir, options.spec.tree as never);
      (await import("../src/grow/lineage.ts")).recordHistory(tip.buildDir, "spec diff");
      return { moduleName: tip.moduleName, buildDir: tip.buildDir, diff: "already applied", response: "", runs: [], attempts: 0, testRemovals: [], files: { added: [], changed: [], removed: [] }, passed: true, stoppedAt: null };
    },
  };
});

const { createSpecDiffTools } = await import("../src/spec-tools.ts");
const { createWorkLoop } = await import("../src/grow/loop.ts");
const { createJobRegistry } = await import("../src/grow/jobs.ts");
const { readRecord } = await import("../src/grow/records.ts");

let dir: string;
let cwd: string;
const plain = (fs: string[]) =>
  `***definitions***\n\n- :User: is a person.\n\n***implementation reqs***\n\n- Python.\n${fs.length ? `\n***functional specs***\n\n${fs.join("\n\n")}\n` : ""}`;
const fileDiff = (file: string, before: string, after: string) =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${before.split("\n").length - 1} +1,${after.split("\n").length - 1} @@`,
    ...before.split("\n").slice(0, -1).map((line) => `-${line}`),
    ...after.split("\n").slice(0, -1).map((line) => `+${line}`),
    "",
  ].join("\n");
const diffOf = (before: string, after: string) => fileDiff("app.plain", before, after);

function setup(options: { paced?: boolean } = {}) {
  const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false });
  const { tools, pace } = createSpecDiffTools({ loop, cwd: dir, ...options });
  const call = (params: object) => tools[0]!.execute("id", params as never, undefined, undefined, {} as never);
  return { loop, pace, call };
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "turri-diff-tool-")));
  cwd = process.cwd();
  process.chdir(dir);
  writeFileSync(join(dir, "config.yaml"), "conformance-tests: false\n");
  rendered.length = 0;
  renderedIn.length = 0;
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

describe("write_spec_diff", () => {
  it("applies the change and starts building it, in one call", async () => {
    writeFileSync(join(dir, "app.plain"), plain(["- A :User: can register."]));
    const { call, loop } = setup();
    const diff = diffOf(plain(["- A :User: can register."]), plain(["- A :User: can register.", "- A :User: can log in."]));

    const result = await call({ plain_file: "app.plain", diff });
    await loop.drain();

    expect(readFileSync(join(dir, "app.plain"), "utf8")).toContain("- A :User: can log in.");
    expect(result.details.jobIds).toHaveLength(1);
    expect(result.content[0]!.text).toContain("Building in the background");
    expect(JSON.stringify(readRecord(join(dir, "plain_modules", "app", "code")))).toContain("can log in.");
  });

  it("needs an answer before the next change, but not for a correction", async () => {
    const one = plain(["- A :User: can register."]);
    const two = plain(["- A :User: can register.", "- A :User: can log in."]);
    writeFileSync(join(dir, "app.plain"), one);
    const { call, pace } = setup();
    await call({ plain_file: "app.plain", diff: diffOf(one, two) });

    const three = plain(["- A :User: can register.", "- A :User: can log in.", "- A :User: can log out."]);
    await expect(call({ plain_file: "app.plain", diff: diffOf(two, three) })).rejects.toThrow(/No question has been answered/);

    const fixed = plain(["- A :User: can register.", "- A :User: can log in with email."]);
    await expect(call({ plain_file: "app.plain", diff: diffOf(two, fixed), fixes_earlier: true })).resolves.toBeDefined();

    pace.answered();
    await expect(call({ plain_file: "app.plain", diff: diffOf(fixed, three.replace("log in.", "log in with email.")) })).resolves.toBeDefined();
  });

  it("writes one change after another without an answer between them for a skill that writes the specs on its own", async () => {
    const one = plain(["- A :User: can register."]);
    const two = plain(["- A :User: can register.", "- A :User: can log in."]);
    const three = plain(["- A :User: can register.", "- A :User: can log in.", "- A :User: can log out."]);
    writeFileSync(join(dir, "app.plain"), one);
    const { call, loop } = setup({ paced: false });
    await call({ plain_file: "app.plain", diff: diffOf(one, two) });
    await expect(call({ plain_file: "app.plain", diff: diffOf(two, three) })).resolves.toBeDefined();
    await loop.drain();
    expect(readFileSync(join(dir, "app.plain"), "utf8")).toBe(three);
    expect(JSON.stringify(readRecord(join(dir, "plain_modules", "app", "code")))).toContain("can log out.");
  });

  it("undoes a change that stops the spec parsing, and builds nothing", async () => {
    const one = plain(["- A :User: can register."]);
    writeFileSync(join(dir, "app.plain"), one);
    const { call } = setup();
    await expect(
      call({ plain_file: "app.plain", diff: diffOf(one, plain(["- A :User: can register.", "- An :Undefined: thing."])) }),
    ).rejects.toThrow(/no longer parses/);
    expect(readFileSync(join(dir, "app.plain"), "utf8")).toBe(one);
    expect(rendered).toEqual([]);
  });

  it("builds a change that touches only a definition, before any functional spec exists", async () => {
    const none = plain([]);
    writeFileSync(join(dir, "app.plain"), none);
    const { call, loop, pace } = setup();
    await call({ plain_file: "app.plain", diff: diffOf(none, none.replace("- Python.", "- Python 3.13.")) });
    await loop.drain();
    pace.answered();
    await call({ plain_file: "app.plain", diff: diffOf(none.replace("- Python.", "- Python 3.13."), none.replace("- Python.", "- Python 3.13.").replace(":User: is a person.", ":User: is a student.")) });
    await loop.drain();
    expect(rendered).toHaveLength(2);
    expect(rendered[1]).toContain("is a student.");
    expect(rendered[1]).not.toContain("Python 3.13.");
  });

  it("builds the whole spec - what the earlier phases wrote and what it imports - when nothing is built yet, and the next change only its own", async () => {
    mkdirSync(join(dir, "template"), { recursive: true });
    writeFileSync(join(dir, "template", "base.plain"), "***implementation reqs***\n\n- Log in JSON.\n");
    const before = `---\nimport:\n  - base\n---\n\n${plain([])}`;
    writeFileSync(join(dir, "app.plain"), before);
    const { call, loop, pace } = setup();
    const first = before.replace("import:", "description: A study tracker.\nimport:");
    await call({ plain_file: "app.plain", diff: fileDiff("app.plain", before, first) });
    await loop.drain();
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toContain("+- :User: is a person.");
    expect(rendered[0]).toContain("+- Python.");
    expect(rendered[0]).toContain("+- Log in JSON.");

    pace.answered();
    const second = first.replace(":User: is a person.", ":User: is a student.");
    await call({ plain_file: "app.plain", diff: fileDiff("app.plain", first, second) });
    await loop.drain();
    expect(rendered[1]).toContain("+- :User: is a student.");
    expect(rendered[1]).not.toContain("+- Log in JSON.");
  });
});

describe("a spec diff across two modules of a chain", () => {
  const accounts = (fs: string[]) => `***definitions***\n\n- :User: is a person.\n\n***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n${fs.join("\n\n")}\n`;
  const onAccounts = (fs: string[]) => `---\nrequires:\n  - accounts\n---\n\n***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n${fs.join("\n\n")}\n`;

  it("builds the module below first when the one above is not built yet, then the one above from its code", async () => {
    writeFileSync(join(dir, "accounts.plain"), accounts(["- A :User: can register."]));
    writeFileSync(join(dir, "app.plain"), onAccounts(["- Show the home page."]));
    const { call, loop } = setup();
    const diff =
      fileDiff("accounts.plain", accounts(["- A :User: can register."]), accounts(["- A :User: can register.", "- A :User: can log in."])) +
      fileDiff("app.plain", onAccounts(["- Show the home page."]), onAccounts(["- Show the home page to a visitor."]));
    await call({ plain_file: "app.plain", diff });
    await loop.drain();
    expect(renderedIn).toEqual(["accounts", "accounts", "app"]);
    // Built on the code below, it has what that implements already: only its own functional spec is new.
    expect(rendered[2]).toContain("+- Show the home page to a visitor.");
    expect(rendered[2]).not.toContain("+- Python.");
  });

  it("makes the change below in the codebase above once that is built, where the code now lives", async () => {
    writeFileSync(join(dir, "accounts.plain"), accounts(["- A :User: can register."]));
    writeFileSync(join(dir, "app.plain"), onAccounts(["- Show the home page."]));
    const { call, loop, pace } = setup();
    await call({ plain_file: "app.plain", diff: fileDiff("app.plain", onAccounts(["- Show the home page."]), onAccounts(["- Show the home page to a visitor."])) });
    await loop.drain();
    renderedIn.length = 0;
    pace.answered();
    await call({ plain_file: "accounts.plain", diff: fileDiff("accounts.plain", accounts(["- A :User: can register."]), accounts(["- A :User: can register.", "- A :User: can log in."])) });
    await loop.drain();
    expect(renderedIn).toEqual(["app"]);
  });
});
