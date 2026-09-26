import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rendered: string[] = [];
vi.mock("../src/render/spec-change.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/render/spec-change.ts")>();
  return {
    ...actual,
    renderSpecDiff: async (options: { diff: string; plainFile: string }) => {
      rendered.push(options.diff);
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

function setup() {
  const queue = createRenderQueue({ registry: createJobRegistry(), cwd: dir });
  const { tools, pace } = createSpecDiffTools({ queue, cwd: dir });
  const call = (params: object) => tools[0]!.execute("id", params as never, undefined, undefined, {} as never);
  return { queue, pace, call };
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "plainwright-diff-tool-")));
  cwd = process.cwd();
  process.chdir(dir);
  rendered.length = 0;
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
