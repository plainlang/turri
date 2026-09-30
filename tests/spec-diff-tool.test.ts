import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rendered: string[] = [];
/** The codebase each render landed in, in order. */
const renderedIn: string[] = [];
vi.mock("../src/render/spec-change.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/render/spec-change.ts")>();
  return {
    ...actual,
    renderSpecDiff: async (options: { diff: string; plainFile: string; spec?: { chain: Array<{ moduleName: string }> } }) => {
      rendered.push(options.diff);
      renderedIn.push(options.spec?.chain.at(-1)?.moduleName ?? "");
      return { moduleName: "app", buildDir: "", diff: "already applied", response: "", runs: [], testRemovals: [], files: { added: [], changed: [], removed: [] }, passed: true, stoppedAt: null };
    },
  };
});

const { createSpecDiffTools } = await import("../src/spec-tools.ts");
const { createRenderQueue } = await import("../src/render/queue.ts");
const { createJobRegistry } = await import("../src/render/jobs.ts");

let dir: string;
let cwd: string;
const plain = (fs: string[]) =>
  `***definitions***\n\n- :User: is a person.\n\n***implementation reqs***\n\n- Python.\n${fs.length ? `\n***functional specs***\n\n${fs.join("\n\n")}\n` : ""}`;
const diffOf = (before: string, after: string) =>
  [
    "diff --git a/app.plain b/app.plain",
    "--- a/app.plain",
    "+++ b/app.plain",
    "@@ -1,1 +1,1 @@",
    ...before.split("\n").slice(0, -1).map((line) => `-${line}`),
    ...after.split("\n").slice(0, -1).map((line) => `+${line}`),
    "",
  ].join("\n");

/** The codebases the queue built again from scratch, in order. */
const rebuilt: string[] = [];

function setup() {
  const registry = createJobRegistry();
  const queue = createRenderQueue({
    registry,
    cwd: dir,
    queueMaster: false,
    rebuild: async (request) => (rebuilt.push(request.plainFile), { report: "rebuilt", details: { passed: true, landed: true } }),
  });
  const { tools, pace } = createSpecDiffTools({ queue, cwd: dir });
  const call = (params: object) => tools[0]!.execute("id", params as never, undefined, undefined, {} as never);
  return { queue, pace, call, registry };
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "plainwright-diff-tool-")));
  cwd = process.cwd();
  process.chdir(dir);
  rendered.length = 0;
  renderedIn.length = 0;
  rebuilt.length = 0;
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

/** A codebase with something in it already: its changes are built as they come. */
function builtAlready() {
  mkdirSync(join(dir, "plain_modules", "app", "code"), { recursive: true });
  writeFileSync(join(dir, "plain_modules", "app", "code", "app.py"), "print('built')\n");
}

describe("write_spec_diff", () => {
  it("applies the change and queues its build, in one call", async () => {
    writeFileSync(join(dir, "app.plain"), plain(["- A :User: can register."]));
    builtAlready();
    const { call, queue } = setup();
    const diff = diffOf(plain(["- A :User: can register."]), plain(["- A :User: can register.", "- A :User: can log in."]));

    const result = await call({ plain_file: "app.plain", diff });
    await queue.drain();

    expect(readFileSync(join(dir, "app.plain"), "utf8")).toContain("- A :User: can log in.");
    expect(result.details.jobId).toBeDefined();
    expect(rendered).toEqual([diff]);
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
    const queue = createRenderQueue({ registry: createJobRegistry(), cwd: dir, queueMaster: false });
    const { tools } = createSpecDiffTools({ queue, cwd: dir, paced: false });
    const call = (params: object) => tools[0]!.execute("id", params as never, undefined, undefined, {} as never);
    await call({ plain_file: "app.plain", diff: diffOf(one, two) });
    await expect(call({ plain_file: "app.plain", diff: diffOf(two, three) })).resolves.toBeDefined();
    await queue.drain();
    expect(readFileSync(join(dir, "app.plain"), "utf8")).toBe(three);
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

  it("renders a change that touches only a definition, before any functional spec exists", async () => {
    const none = plain([]);
    writeFileSync(join(dir, "app.plain"), none);
    builtAlready();
    const { call, queue } = setup();
    const diff = diffOf(none, none.replace(":User: is a person.", ":User: is a student."));
    const result = await call({ plain_file: "app.plain", diff });
    await queue.drain();
    expect(readFileSync(join(dir, "app.plain"), "utf8")).toContain("is a student.");
    expect(result.details.jobId).toBeDefined();
    expect(rendered).toEqual([diff]);
  });
});

describe("the first change built into a codebase that holds nothing yet", () => {
  it("is given the whole spec - what the earlier phases wrote and what it imports - and the next change only its own", async () => {
    // What the stack and testing phases wrote with the file tools, and a shared template.
    mkdirSync(join(dir, "template"), { recursive: true });
    writeFileSync(join(dir, "template", "base.plain"), "***implementation reqs***\n\n- Log in JSON.\n");
    const before = `---\nimport:\n  - base\n---\n\n${plain([])}`;
    writeFileSync(join(dir, "app.plain"), before);
    const { call, queue, pace } = setup();

    // The first answer: the product description, in the frontmatter.
    const first = before.replace("import:", "description: A study tracker.\nimport:");
    const answer = [
      "diff --git a/app.plain b/app.plain",
      "--- a/app.plain",
      "+++ b/app.plain",
      "@@ -1,2 +1,3 @@",
      " ---",
      "+description: A study tracker.",
      " import:",
      "",
    ].join("\n");
    const result = await call({ plain_file: "app.plain", diff: answer });
    await queue.drain();

    expect(readFileSync(join(dir, "app.plain"), "utf8")).toBe(first);
    expect(rendered).toHaveLength(1);
    // Every file the module is built from, added from nothing.
    expect(rendered[0]).toContain("--- /dev/null\n+++ b/app.plain");
    expect(rendered[0]).toContain("+description: A study tracker.");
    expect(rendered[0]).toContain("+- :User: is a person.");
    expect(rendered[0]).toContain("+- Python.");
    expect(rendered[0]).toContain("+++ b/template/base.plain");
    expect(rendered[0]).toContain("+- Log in JSON.");
    expect(result.content[0]!.text).toContain("given the whole spec");

    // The next answer, while the first is building or after: its own diff.
    pace.answered();
    const line = first.split("\n").indexOf("- :User: is a person.") + 1;
    const own = [
      "diff --git a/app.plain b/app.plain",
      "--- a/app.plain",
      "+++ b/app.plain",
      `@@ -${line - 1},3 +${line - 1},3 @@`,
      " ",
      "-- :User: is a person.",
      "+- :User: is a student.",
      " ",
      "",
    ].join("\n");
    await call({ plain_file: "app.plain", diff: own });
    await queue.drain();
    expect(rendered[1]).toBe(own);
  });

  it("is not given the whole spec when the codebase already holds code", async () => {
    writeFileSync(join(dir, "app.plain"), plain([]));
    builtAlready();
    const { call, queue } = setup();
    const diff = diffOf(plain([]), plain([]).replace(":User: is a person.", ":User: is a student."));
    await call({ plain_file: "app.plain", diff });
    await queue.drain();
    expect(rendered).toEqual([diff]);
  });
});

/** A diff of one file, from what it was to what it is - /dev/null for one that is new. */
const fileDiff = (file: string, before: string | null, after: string) =>
  [
    `diff --git a/${file} b/${file}`,
    ...(before === null ? ["new file mode 100644", "--- /dev/null"] : [`--- a/${file}`]),
    `+++ b/${file}`,
    `@@ -${before === null ? "0,0" : `1,${before.split("\n").length - 1}`} +1,${after.split("\n").length - 1} @@`,
    ...(before ?? "").split("\n").slice(0, -1).map((line) => `-${line}`),
    ...after.split("\n").slice(0, -1).map((line) => `+${line}`),
    "",
  ].join("\n");

/** A module's code, built from its spec as it stands now. */
async function builtFrom(module: string) {
  const { plainFileParser } = await import("../src/plain/parser.ts");
  const { writeBuiltTree } = await import("../src/render/state.ts");
  const { recordHistory } = await import("../src/render/history.ts");
  const code = join(dir, "plain_modules", module, "code");
  mkdirSync(code, { recursive: true });
  writeFileSync(join(code, `${module}.py`), `# ${module}\n`);
  writeBuiltTree(code, plainFileParser(`${module}.plain`, [dir])[1]);
  recordHistory(code, `built ${module}`);
}

const accounts = (fs: string[]) => `***definitions***\n\n- :User: is a person.\n\n***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n${fs.join("\n\n")}\n`;
const onAccounts = (fs: string[]) => `---\nrequires:\n  - accounts\n---\n\n***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n${fs.join("\n\n")}\n`;

describe("a spec diff across two modules of a chain", () => {
  it("is split when the one above is not built yet: the one below renders its part in its own codebase, then the one above starts from its code", async () => {
    writeFileSync(join(dir, "accounts.plain"), accounts(["- A :User: can register."]));
    await builtFrom("accounts");
    writeFileSync(join(dir, "app.plain"), onAccounts(["- Show the home page."]));
    const { call, queue } = setup();
    const diff =
      fileDiff("accounts.plain", accounts(["- A :User: can register."]), accounts(["- A :User: can register.", "- A :User: can log in."])) +
      fileDiff("app.plain", onAccounts(["- Show the home page."]), onAccounts(["- Show the home page to a visitor."]));

    const result = await call({ plain_file: "app.plain", diff });
    await queue.drain();

    expect(renderedIn).toEqual(["accounts", "app"]);
    // The part below: only its own file.
    expect(rendered[0]).toContain("+++ b/accounts.plain");
    expect(rendered[0]).not.toContain("app.plain");
    // The part above: nothing built there yet, so planned once the one below landed, from the code it starts from -
    // what that code implements already, its own "Python." among it, is not new work: only its own functional spec is.
    expect(rendered[1]).toContain("+++ b/app.plain");
    expect(rendered[1]).toContain("+- Show the home page to a visitor.");
    expect(rendered[1]).not.toContain("+- Python.");
    expect(rendered[1]).not.toContain("accounts.plain");
    expect(result.details.jobIds).toHaveLength(2);
    expect(result.content[0]!.text).toContain("split into a job for each");
  });

  it("is one render in the codebase above when that is built: the change below is made where its code now lives", async () => {
    writeFileSync(join(dir, "accounts.plain"), accounts(["- A :User: can register."]));
    writeFileSync(join(dir, "app.plain"), onAccounts(["- Show the home page."]));
    await builtFrom("accounts");
    await builtFrom("app");
    const { call, queue } = setup();
    const diff =
      fileDiff("accounts.plain", accounts(["- A :User: can register."]), accounts(["- A :User: can register.", "- A :User: can log in."])) +
      fileDiff("app.plain", onAccounts(["- Show the home page."]), onAccounts(["- Show the home page to a visitor."]));
    await call({ plain_file: "app.plain", diff });
    await queue.drain();
    expect(renderedIn).toEqual(["app"]);
    expect(rendered).toEqual([diff]);
  });
});

describe("a spec diff that only restructures the specs", () => {
  it("is recorded, not rendered: a definition moved to a common module, and no conformance job after it", async () => {
    const before = `***definitions***\n\n- :User: is a person.\n\n***implementation reqs***\n\n- Python.\n\n***test reqs***\n\n- pytest.\n\n***functional specs***\n\n- A :User: can register.\n`;
    writeFileSync(join(dir, "app.plain"), before);
    await builtFrom("app");
    const { call, queue, registry } = setup();
    const after = `---\nimport:\n  - common\n---\n\n***implementation reqs***\n\n- Python.\n\n***test reqs***\n\n- pytest.\n\n***functional specs***\n\n- A :User: can register.\n`;
    // Definitions only: not a module of its own, so it is checked as app reads it.
    const common = "***definitions***\n\n- :User: is a person.\n";
    const result = await call({ plain_file: "app.plain", diff: fileDiff("common.plain", null, common) + fileDiff("app.plain", before, after) });
    await queue.drain();

    expect(result.content[0]!.text).toContain("only laid out differently, so there is nothing to render");
    const job = registry.get(result.details.jobId)!;
    expect(job.summary).toBe("app.plain spec restructured - nothing to render");
    expect(queue.status().map((entry) => entry.what)).not.toContainEqual(expect.stringMatching(/conformance/));
  });
});

describe("a spec diff that moves specs into a module the code was not built on", () => {
  it("builds that module, then the codebase again from scratch on it - not a spec diff", async () => {
    writeFileSync(join(dir, "app.plain"), accounts(["- A :User: can register.", "- Show the home page."]));
    await builtFrom("app");
    const { call, queue, registry } = setup();
    const before = accounts(["- A :User: can register.", "- Show the home page."]);
    const after = `---\nrequires:\n  - accounts\n---\n\n***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n- Show the home page.\n`;
    const diff = fileDiff("accounts.plain", null, accounts(["- A :User: can register."])) + fileDiff("app.plain", before, after);
    // With exported concepts it would say which; here app only needs accounts' code.
    const result = await call({ plain_file: "app.plain", diff });
    await queue.drain();

    // Not rendered as spec diffs at all: one rebuild of app's chain - accounts first, then app from scratch on it.
    expect(renderedIn).toEqual([]);
    expect(rebuilt).toEqual([join(dir, "app.plain")]);
    expect(result.details.jobIds).toHaveLength(1);
    const rebuild = registry.get(result.details.jobId)!;
    expect(rebuild.summary).toBe("app.plain from scratch - it now requires accounts");
    expect(result.content[0]!.text).toContain("builds accounts and then app again from scratch on it");
  });
});
