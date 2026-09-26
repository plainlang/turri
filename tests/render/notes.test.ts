import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyNotesChanges,
  createNotesTool,
  formatNotes,
  NOTES_FILE,
  notesForSession,
  parseNotes,
  readNotes,
  withNotes,
} from "../../src/render/notes.ts";
import { confinedTools } from "../../src/render/confine.ts";
import { copyRequiredCode } from "../../src/render/requires.ts";
import { listFiles } from "../../src/render/testing.ts";

let root: string;
let code: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "plainwright-notes-")));
  code = join(root, "plain_modules", "app", "code");
  mkdirSync(code, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const start = {
  where: ["Entry point: app/main.py"],
  run: ["Unit tests: .venv/bin/pytest"],
  assumptions: ["Dates are stored as UTC ISO strings"],
  pitfalls: [],
};

describe("updating the notes", () => {
  it("adds, changes and removes single lines, and keeps the rest", () => {
    const { notes, problems } = applyNotesChanges(start, [
      { section: "where", action: "add", text: "Routes: app/routes/*.py" },
      { section: "assumptions", action: "change", replaces: "Dates are stored", text: "Dates are stored as Unix seconds" },
      { section: "run", action: "remove", text: "Unit tests: .venv/bin/pytest" },
      { section: "pitfalls", action: "add", text: "pytest needs PYTHONPATH=." },
    ]);
    expect(problems).toEqual([]);
    expect(notes).toEqual({
      where: ["Entry point: app/main.py", "Routes: app/routes/*.py"],
      run: [],
      assumptions: ["Dates are stored as Unix seconds"],
      pitfalls: ["pytest needs PYTHONPATH=."],
    });
  });

  it("refuses to change or remove a line that is not there, and shows what is", () => {
    const { problems } = applyNotesChanges(start, [
      { section: "assumptions", action: "remove", text: "IDs are UUIDs" },
      { section: "where", action: "change", text: "anything" },
    ]);
    expect(problems[0]).toContain('Assumptions has no line "IDs are UUIDs". Its lines now:\n  - Dates are stored as UTC ISO strings');
    expect(problems[1]).toContain("has to name the line it replaces");
  });

  it("does not add the same line twice", () => {
    const { notes } = applyNotesChanges(start, [{ section: "where", action: "add", text: "Entry point: app/main.py" }]);
    expect(notes.where).toEqual(["Entry point: app/main.py"]);
  });

  it("stamps every line it adds or changes with the step that wrote it, and matches lines without it", () => {
    const first = applyNotesChanges(start, [{ section: "pitfalls", action: "add", text: "httpclient5 is not transitive" }], "http_client 1");
    expect(first.notes.pitfalls).toEqual(["[http_client 1] httpclient5 is not transitive"]);
    const { notes, problems } = applyNotesChanges(
      first.notes,
      [
        { section: "pitfalls", action: "change", replaces: "httpclient5 is not", text: "httpclient5 has to be declared in pom.xml" },
        { section: "pitfalls", action: "add", text: "[http_client 1] httpclient5 has to be declared in pom.xml" },
      ],
      "auth 2",
    );
    expect(problems).toEqual([]);
    expect(notes.pitfalls).toEqual(["[auth 2] httpclient5 has to be declared in pom.xml"]);
  });

  it("refuses a line that says there is nothing to say, and keeps one that says something", () => {
    const { notes, problems } = applyNotesChanges(
      start,
      [
        { section: "pitfalls", action: "add", text: "None specifically for this functionality." },
        { section: "assumptions", action: "add", text: "No new assumptions" },
        { section: "assumptions", action: "add", text: "None of the endpoints need auth" },
      ],
      "auth 2",
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("is not a note");
    expect(notes.assumptions).toContain("[auth 2] None of the endpoints need auth");
    expect(notes.pitfalls).toEqual([]);
  });

  it("reads back what it writes", () => {
    expect(parseNotes(formatNotes(start))).toEqual(start);
  });
});

describe("a note about running the tests", () => {
  it("is refused when it tells the next agent to run the testing scripts itself", () => {
    const { problems } = applyNotesChanges(parseNotes(""), [
      { section: "run", action: "add", text: "Run `./test_scripts/run_unittests_python.sh .` to run the unit tests." },
      { section: "run", action: "add", text: "Unit tests: call run_unit_tests; a single file with `pytest tests/test_app.py`." },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("run_unit_tests and run_conformance_tests are how the tests are run");
  });
});

describe("the update_notes tool", () => {
  const call = (tool: ReturnType<typeof createNotesTool>, changes: unknown[]) =>
    (tool as any).execute("id", { changes }, undefined, undefined, {} as never);

  it("saves the notes beside the code, and says it was used", async () => {
    let used = false;
    const tool = createNotesTool(code, () => (used = true));
    await call(tool, [{ section: "assumptions", action: "add", text: "A missing name greets World" }]);
    expect(used).toBe(true);
    expect(readNotes(code).assumptions).toEqual(["A missing name greets World"]);
    expect(readFileSync(join(code, NOTES_FILE), "utf8")).toContain("## Assumptions\n\n- A missing name greets World");
  });

  it("saves nothing when a change cannot be applied", async () => {
    const tool = createNotesTool(code, () => {});
    await expect(call(tool, [{ section: "where", action: "remove", text: "nope" }])).rejects.toThrow(/Nothing saved/);
    expect(existsSync(join(code, NOTES_FILE))).toBe(false);
  });

  it("is asked for until the agent calls it, and not once it has", async () => {
    const asked: string[] = [];
    const session = notesForSession(code);
    expect(
      await session.ensureWritten(async (prompt) => {
        asked.push(prompt);
        if (asked.length === 2) await call(session.tool, [{ section: "where", action: "add", text: "x" }]);
      }),
    ).toBe(true);
    expect(asked).toHaveLength(2);
    expect(await session.ensureWritten(async (prompt) => asked.push(prompt))).toBe(true);
    expect(asked).toHaveLength(2);
  });

  it("gives up after asking three times, and says the agent left none", async () => {
    const asked: string[] = [];
    expect(await notesForSession(code).ensureWritten(async (prompt) => asked.push(prompt))).toBe(false);
    expect(asked).toHaveLength(3);
  });

  it("undoes notes written as a file, and says so", async () => {
    writeFileSync(join(code, NOTES_FILE), formatNotes(start));
    const asked: string[] = [];
    const session = notesForSession(code);
    // Written by the shell, not the tool: a rewrite that drops what was there.
    writeFileSync(join(code, NOTES_FILE), "# my notes\n\n- everything is fine\n");
    await session.ensureWritten(async (prompt) => {
      asked.push(prompt);
      await call(session.tool, [{ section: "pitfalls", action: "add", text: "mvn needs -q" }]);
    });
    expect(asked[0]).toContain(`You changed ${NOTES_FILE} directly, and that was undone`);
    expect(readNotes(code)).toEqual({ ...start, pitfalls: ["mvn needs -q"] });
  });

  it("stamps the lines with when they were written and the step the agent is", async () => {
    const session = notesForSession(code, "d365_auth 3 conformance");
    await call(session.tool, [{ section: "run", action: "add", text: "mvn -q test" }]);
    expect(readNotes(code).run).toEqual([expect.stringMatching(/^\[\d{4}-\d\d-\d\d \d\d:\d\d · d365_auth 3 conformance\] mvn -q test$/)]);
  });

  it("builds on the notes update_notes left, not on a file written in between", async () => {
    const session = notesForSession(code);
    await call(session.tool, [{ section: "where", action: "add", text: "Entry: Main.java" }]);
    writeFileSync(join(code, NOTES_FILE), "- rewritten\n");
    await call(session.tool, [{ section: "run", action: "add", text: "mvn test" }]);
    expect(readNotes(code)).toEqual({ where: ["Entry: Main.java"], run: ["mvn test"], assumptions: [], pitfalls: [] });
  });

  it("cannot be bypassed with the file tools", async () => {
    const fence = confinedTools({ workdir: code });
    const run = (name: string, params: object) =>
      (fence.tools.find((tool) => tool.name === name) as any).execute("id", params, undefined, undefined, {} as never);
    await expect(run("write", { path: NOTES_FILE, content: "- mine\n" })).rejects.toThrow(/Call update_notes/);
    writeFileSync(join(code, NOTES_FILE), formatNotes(start));
    await expect(run("edit", { path: join(code, NOTES_FILE), edits: [{ oldText: "Entry", newText: "Exit" }] })).rejects.toThrow(
      /Call update_notes/,
    );
    expect(readNotes(code)).toEqual(start);
  });
});

describe("what an agent is given when it starts", () => {
  it("leads with the notes, and asks it to update them - stubborn on the specs, flexible on the assumptions", () => {
    writeFileSync(join(code, NOTES_FILE), formatNotes(start));
    const prompt = withNotes("Implement functionality 2.", code);
    expect(prompt.indexOf("<notes from earlier agents>")).toBeLessThan(prompt.indexOf("Implement functionality 2."));
    expect(prompt).toContain("- Dates are stored as UTC ISO strings");
    expect(prompt).toContain("call update_notes");
    expect(prompt).toContain("Stubborn on the specification, flexible on the assumptions");
  });

  it("says so when there are none yet", () => {
    expect(withNotes("Implement functionality 1.", code)).toContain("No earlier agent has left notes on this codebase yet.");
  });
});

describe("the notes, beside the code", () => {
  it("are not code: not listed, not shown in the codebase", () => {
    writeFileSync(join(code, "app.py"), "print('hi')\n");
    writeFileSync(join(code, NOTES_FILE), formatNotes(start));
    expect(listFiles(code)).toEqual(["app.py"]);
  });

  it("come up with the code to a module that requires this one", () => {
    writeFileSync(join(code, "app.py"), "print('hi')\n");
    writeFileSync(join(code, NOTES_FILE), formatNotes(start));
    const next = join(root, "plain_modules", "next", "code");
    copyRequiredCode(code, next, "next");
    expect(readNotes(next)).toEqual(start);
  });
});
