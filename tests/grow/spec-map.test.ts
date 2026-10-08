import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFINITIONS, FUNCTIONAL_REQUIREMENTS, NON_FUNCTIONAL_REQUIREMENTS, TEST_REQUIREMENTS, type MarshalledPlainSource } from "../../src/plain/spec.ts";
import { createJobRegistry } from "../../src/grow/jobs.ts";
import { createWorkLoop, type JobRunner, type MapCodebase, type MapPlan, type MapPulse } from "../../src/grow/loop.ts";
import { recordHistory } from "../../src/grow/lineage.ts";
import { writeCodeRecord } from "../../src/grow/records.ts";
import { createSidePanel } from "../../src/grow/side-panel.ts";
import { createSpecMapSource, defaultMapFiles, importLabel, layOut, markSpecMap, pageItems, readSpecMap, type MapItem, type MapPage, type MarkedPage } from "../../src/grow/spec-map.ts";
import { createSpecMapState, focusOf, lineDiff, specMapHeader, specMapLines, wordDiff } from "../../src/grow/spec-map-view.ts";
import type { TranscriptStyle } from "../../src/grow/transcript-view.ts";
import { PLAIN_PAINT } from "../../src/grow/diff-view.ts";

let dir: string;
let cwd: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-spec-map-"));
  cwd = process.cwd();
  process.chdir(dir);
  writeFileSync(join(dir, "config.yaml"), "conformance-tests: false\n");
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

const item = (markdown: string) => ({ markdown });
const tree = (sections: Record<string, string[]>): MarshalledPlainSource => Object.fromEntries(Object.entries(sections).map(([key, items]) => [key, items.map(item)]));
const id = (text: string) => text;
/** A style that shows what is struck, added and removed as text. */
const style: TranscriptStyle = {
  heading: id,
  muted: id,
  accent: id,
  error: id,
  success: id,
  warning: id,
  added: (text) => `{+${text}+}`,
  removed: (text) => `[-${text.replace(/\x1b\[\d+m/g, "")}-]`,
};
const noPlan: MapPlan = { files: [], codebases: [] };

/** The page of one module built from `record`, its spec now `spec`. */
function page(spec: MarshalledPlainSource, record: MarshalledPlainSource | null, tested?: MarshalledPlainSource): MapPage {
  return { module: "app", plainFile: join(dir, "app.plain"), buildDir: join(dir, "code"), imports: [], items: pageItems({ module: "app", own: true, spec, record, tested: tested ?? null }) };
}

/** A pulse that grows the items given: from their record lines to their lines now. */
function pulseOf(items: MapItem[], number: number, running: boolean, title = `pulse ${number}`): MapPulse {
  const lines = (pick: (entry: MapItem) => string | undefined) => `["${FUNCTIONAL_REQUIREMENTS}"]\n${items.map(pick).filter((line) => line !== undefined).join("\n")}\n`;
  return { number, title, track: "code", running, rowId: running ? `job${number}` : `planned-app-${number}`, before: lines((entry) => entry.wasLine), after: lines((entry) => entry.line) };
}

const codebase = (first: MapPage, rest: Partial<MapCodebase> = {}): MapCodebase => ({ module: "app", plainFile: first.plainFile, buildDir: first.buildDir, pulses: [], conformance: true, ...rest });

describe("the regeneration from the files", () => {
  it("marks each item built, new or changed against the code record, and keeps an item taken out as a ghost in its place", () => {
    const items = page(
      tree({ [FUNCTIONAL_REQUIREMENTS]: ["- A user can register.", "- A user can log in with a password.", "- A user can post a photo."] }),
      tree({ [FUNCTIONAL_REQUIREMENTS]: ["- A user can register.", "- A user can search for others.", "- A user can log in with a passphrase."] }),
    ).items;
    expect(items.map((entry) => [entry.state, entry.text])).toEqual([
      ["built", "- A user can register."],
      ["removed", "- A user can search for others."],
      ["changed", "- A user can log in with a password."],
      ["new", "- A user can post a photo."],
    ]);
    expect(items[2]!.was).toBe("- A user can log in with a passphrase.");
  });

  it("shows a spec taken out only while the code still has it - one never built is simply gone", () => {
    const items = page(tree({ [FUNCTIONAL_REQUIREMENTS]: ["- A user can register."] }), tree({ [FUNCTIONAL_REQUIREMENTS]: ["- A user can register."] })).items;
    expect(items.map((entry) => entry.state)).toEqual(["built"]);
  });

  it("gives test reqs no build mark, and marks functional specs whose conformance tests are written as they read now, for an earlier text, or taken out", () => {
    const items = page(
      tree({ [TEST_REQUIREMENTS]: ["- Use pytest."], [FUNCTIONAL_REQUIREMENTS]: ["- Say hello.", "- Say goodbye loudly.", "- Count to three."] }),
      tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Say hello.", "- Say goodbye quietly.", "- Shout."] }),
      tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Say hello.", "- Say goodbye quietly.", "- Shout."] }),
    ).items;
    expect(items.find((entry) => entry.section === TEST_REQUIREMENTS)?.state).toBe("test");
    expect(items.filter((entry) => entry.section === FUNCTIONAL_REQUIREMENTS).map((entry) => [entry.text, entry.tests])).toEqual([
      ["- Say hello.", "now"],
      ["- Say goodbye loudly.", "older"],
      ["- Shout.", "removed"],
      ["- Count to three.", undefined],
    ]);
  });

  it("lays the items out as the file has them: its sections in its order, its definitions in its order, then each imported file", () => {
    const items: MapItem[] = [
      { key: "1", section: DEFINITIONS, state: "built", text: "- :Zebra: is an animal.", acceptance: [] },
      { key: "2", section: DEFINITIONS, state: "built", text: "- :Apple: is a fruit.", acceptance: [] },
      { key: "3", section: NON_FUNCTIONAL_REQUIREMENTS, state: "built", text: "- Use Python 3.12.", acceptance: [] },
      { key: "4", section: FUNCTIONAL_REQUIREMENTS, state: "new", text: "- Eat an :Apple:.", acceptance: [] },
    ];
    const own = "***functional specs***\n\n- Eat an :Apple:.\n\n***definitions***\n\n- :Apple: is a fruit.\n\n- :Zebra: is an animal.\n";
    const lang = "***implementation reqs***\n\n- Use Python 3.12.\n";
    const laid = layOut(items, [{ text: own }, { label: "stdlib/lang/python", text: lang }]);
    expect(laid.map((entry) => [entry.text, entry.file])).toEqual([
      ["- Eat an :Apple:.", undefined],
      ["- :Apple: is a fruit.", undefined],
      ["- :Zebra: is an animal.", undefined],
      ["- Use Python 3.12.", "stdlib/lang/python"],
    ]);
  });

  it("names a standard library template by its import path, and a project's file from the project", () => {
    expect(importLabel("/opt/turri/stdlib/backend/python-fastapi.plain", "/work/app", "/opt/turri")).toBe("stdlib/backend/python-fastapi");
    expect(importLabel("/work/app/shared/common.plain", "/work/app")).toBe("shared/common");
  });

  it("reads a project before anything has run: what the code record has is built, the rest waits, and nobody has asked to build it", () => {
    writeFileSync(join(dir, "app.plain"), "***implementation reqs***\n\n- Use Python.\n\n***functional specs***\n\n- Say hello.\n\n- Say goodbye.\n");
    const code = join(dir, "plain_modules", "app", "code");
    writeCodeRecord(code, tree({ [NON_FUNCTIONAL_REQUIREMENTS]: ["- Use Python."], [FUNCTIONAL_REQUIREMENTS]: ["- Say hello."] }));
    const [only] = markSpecMap(readSpecMap([join(dir, "app.plain")]), noPlan);
    expect(only!.items.map((entry) => [entry.mark, entry.text])).toEqual([
      ["built", "- Use Python."],
      ["built", "- Say hello."],
      ["waiting", "- Say goodbye."],
    ]);
    expect(only!.status).toBe("not asked to build - regrow plans it");
  });

  it("has a page for each module of the requires chain, a module below read from the codebase built on it", () => {
    writeFileSync(join(dir, "base.plain"), "***definitions***\n\n- :Store: is a key-value store.\n\n***implementation reqs***\n\n- Use Python.\n\n***functional specs***\n\n- Put a value in the :Store:.\n");
    writeFileSync(join(dir, "top.plain"), "---\nrequires:\n  - base\n---\n\n***implementation reqs***\n\n- Serve it over HTTP.\n\n***functional specs***\n\n- Get a value back.\n");
    const code = join(dir, "plain_modules", "top", "code");
    writeCodeRecord(code, {
      [DEFINITIONS]: [{ markdown: "- :Store: is a key-value store.", module: "base" }],
      [NON_FUNCTIONAL_REQUIREMENTS]: [{ markdown: "- Use Python.", module: "base" }],
      "required functional specs": [{ markdown: "- Put a value in the :Store:.", module: "base", frid: "1" }],
    } as MarshalledPlainSource);
    writeFileSync(join(code, "main.py"), "");
    const pages = markSpecMap(readSpecMap([join(dir, "top.plain")]), noPlan);
    expect(pages.map((entry) => [entry.module, entry.buildDir, entry.items.map((each) => each.state)])).toEqual([
      ["base", code, ["built", "built", "built"]],
      ["top", code, ["new", "new"]],
    ]);
  });

  it("maps the project's module from config.yaml when nothing has been asked for, else the files no other one imports or requires", () => {
    writeFileSync(join(dir, "base.plain"), "***implementation reqs***\n\n- Use Python.\n\n***functional specs***\n\n- Do a thing.\n");
    writeFileSync(join(dir, "top.plain"), "---\nrequires:\n  - base\n---\n\n***implementation reqs***\n\n- Serve it over HTTP.\n\n***functional specs***\n\n- Do another.\n");
    expect(defaultMapFiles(dir)).toEqual([join(dir, "top.plain")]);
    writeFileSync(join(dir, "config.yaml"), "module: base.plain\n");
    expect(defaultMapFiles(dir)).toEqual([join(dir, "base.plain")]);
  });

  it("reads the files again only once a while has passed, or when asked to", () => {
    writeFileSync(join(dir, "app.plain"), "***implementation reqs***\n\n- Use Python.\n\n***functional specs***\n\n- Say hello.\n");
    let at = 0;
    const source = createSpecMapSource({ files: () => [join(dir, "app.plain")], plan: () => noPlan, every: 1000, now: () => at });
    const specs = () => source.read()[0]!.items.filter((entry) => entry.section === FUNCTIONAL_REQUIREMENTS);
    expect(specs()).toHaveLength(1);
    writeFileSync(join(dir, "app.plain"), "***implementation reqs***\n\n- Use Python.\n\n***functional specs***\n\n- Say hello.\n\n- Say goodbye.\n");
    at = 500;
    expect(specs()).toHaveLength(1);
    at = 1500;
    expect(specs()).toHaveLength(2);
    writeFileSync(join(dir, "app.plain"), "***implementation reqs***\n\n- Use Python.\n\n***functional specs***\n\n- Say hello.\n");
    source.refresh();
    expect(specs()).toHaveLength(1);
  });
});

describe("the plan laid over the map", () => {
  const spec = tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Register.", "- Log in.", "- Follow someone.", "- Post a photo."] });
  const record = tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Register.", "- Search for others."] });

  it("marks the items of the running pulse growing and those planned with their pulse's number, the rest waiting", () => {
    const first = page(spec, record);
    const [login, follow] = [first.items.find((entry) => entry.text === "- Log in.")!, first.items.find((entry) => entry.text === "- Follow someone.")!];
    const [marked] = markSpecMap([first], { files: [], codebases: [codebase(first, { pulses: [pulseOf([login], 3, true), pulseOf([follow], 4, false)] })] });
    expect(marked!.items.map((entry) => [entry.text, entry.mark, entry.pulse?.number])).toEqual([
      ["- Register.", "built", undefined],
      ["- Search for others.", "waiting", undefined],
      ["- Log in.", "growing", 3],
      ["- Follow someone.", "planned", 4],
      ["- Post a photo.", "waiting", undefined],
    ]);
    expect(marked!.status).toBe("pulse 3 of 4 growing");
  });

  it("marks a ghost with the pulse that takes it out", () => {
    const first = page(spec, record);
    const search = first.items.find((entry) => entry.state === "removed")!;
    const [marked] = markSpecMap([first], { files: [], codebases: [codebase(first, { pulses: [pulseOf([search], 5, false)] })] });
    expect(marked!.items.find((entry) => entry.state === "removed")).toMatchObject({ mark: "planned", pulse: { number: 5 } });
  });

  it("marks what differs and has no pulse as being planned while the planner runs", () => {
    const first = page(spec, record);
    const [marked] = markSpecMap([first], { files: [], codebases: [codebase(first, { planning: "code" })] });
    expect(marked!.items.filter((entry) => entry.state !== "built").every((entry) => entry.mark === "planning")).toBe(true);
    expect(marked!.status).toBe("planning");
  });

  it("marks the items of a pulse that did not land stuck and rolled back, the rest waiting, and says the module is halted", () => {
    const first = page(spec, record);
    const login = first.items.find((entry) => entry.text === "- Log in.")!;
    const failed = pulseOf([login], 3, false);
    const [marked] = markSpecMap([first], {
      files: [],
      codebases: [codebase(first, { stuck: { why: `pulse abc ("log in") did not land - it runs again once the spec changes`, pulse: { number: 3, before: failed.before, after: failed.after } } })],
    });
    expect(marked!.items.find((entry) => entry.text === "- Log in.")).toMatchObject({ mark: "stuck", rolledBack: 3 });
    expect(marked!.items.find((entry) => entry.text === "- Follow someone.")!.mark).toBe("waiting");
    expect(marked!).toMatchObject({ status: "halted - pulse 3 didn't land", stuck: true });
  });

  it("marks every item that differs stuck when the planner found no plan", () => {
    const first = page(spec, record);
    const [marked] = markSpecMap([first], { files: [], codebases: [codebase(first, { stuck: { why: "the planner found no way to cut the work into pulses that hold together" } })] });
    expect(marked!.items.filter((entry) => entry.state !== "built").every((entry) => entry.mark === "stuck")).toBe(true);
    expect(marked!.status).toBe("the planner couldn't cut it into pulses");
  });

  it("spins beside each functional spec a running conformance pulse writes tests for - its acceptance tests changed too", () => {
    const first = page(tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Register.", "- Log in."] }), tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Register.", "- Log in."] }));
    const spec = (markdown: string, frid: string, tests: string[]) => JSON.stringify({ acceptance_tests: tests.map((test) => ({ markdown: test })), frid, markdown });
    const conformance = (before: string[], after: string[], extra = ""): MapPulse => ({
      number: 2, title: "conformance", track: "conformance", running: true, rowId: "job2",
      before: `["${DEFINITIONS}"]\n${extra}["${FUNCTIONAL_REQUIREMENTS}"]\n${before.join("\n")}\n`,
      after: `["${DEFINITIONS}"]\n["${FUNCTIONAL_REQUIREMENTS}"]\n${after.join("\n")}\n`,
    });
    // Log in's acceptance tests changed, its text did not: its tests are written again.
    const changed = conformance([spec("- Register.", "1", []), spec("- Log in.", "2", ["- Wrong password gives 401."])], [spec("- Register.", "1", []), spec("- Log in.", "2", ["- Wrong password gives 403."])]);
    let [marked] = markSpecMap([first], { files: [], codebases: [codebase(first, { pulses: [changed] })] });
    expect(marked!.items.map((entry) => [entry.text, entry.testing === true])).toEqual([["- Register.", false], ["- Log in.", true]]);
    // The count is of all the module's pulses; what the running one does comes after it.
    expect(marked!.status).toBe("pulse 2 of 2 growing · conformance tests");
    // Only a definition changed: every one is tested again.
    const definitions = conformance([spec("- Register.", "1", []), spec("- Log in.", "2", [])], [spec("- Register.", "1", []), spec("- Log in.", "2", [])], `{"markdown":"- :User: is a person."}\n`);
    [marked] = markSpecMap([first], { files: [], codebases: [codebase(first, { pulses: [definitions] })] });
    expect(marked!.items.every((entry) => entry.testing === true)).toBe(true);
  });

  it("numbers beside each functional spec the conformance pulse planned to write its tests - planned from trees, or scheduled ahead of its code", () => {
    const first = page(
      tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Register.", "- Log in.\n  - With a password.", "- Log out."] }),
      tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Register.", "- Log in.\n  - With a password.", "- Log out."] }),
    );
    const spec = (markdown: string, frid: string) => JSON.stringify({ acceptance_tests: [], frid, markdown });
    const planned: MapPulse = {
      number: 4, title: "fs 1", track: "conformance", running: false, rowId: "planned-app-1",
      before: `["${FUNCTIONAL_REQUIREMENTS}"]\n`,
      after: `["${FUNCTIONAL_REQUIREMENTS}"]\n${spec("- Register.", "1")}\n`,
    };
    // Scheduled by bind before its code is built: no trees, its functional specs named by their first line.
    const scheduled: MapPulse = { number: 12, title: "Log in.", track: "conformance", running: false, rowId: "planned-app-2", before: "", after: "", specs: ["Log in."] };
    const [marked] = markSpecMap([first], { files: [], codebases: [codebase(first, { pulses: [planned, scheduled] })] });
    expect(marked!.items.map((entry) => [entry.text.split("\n")[0], entry.testsPulse?.number])).toEqual([["- Register.", 4], ["- Log in.", 12], ["- Log out.", undefined]]);
    const lines = specMapLines([marked!], createSpecMapState(), 100, style).lines;
    // Dimmed in the tests' column, as a planned mark is - a number past 9 taking the space before the bar.
    expect(lines.find((line) => line.includes("- Register."))).toMatch(/✓ 4 │ - Register\./);
    expect(lines.find((line) => line.includes("- Log in."))).toMatch(/✓ 12│ - Log in\./);
  });

  it("marks a test req from the conformance track: followed by the tests, being written for, or not yet - none where nothing is tested", () => {
    const spec = tree({ [TEST_REQUIREMENTS]: ["- Use pytest.", "- Run against the sandbox."], [FUNCTIONAL_REQUIREMENTS]: ["- Say hello."] });
    const record = tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Say hello."] });
    const reqs = (marked: MarkedPage) => marked.items.filter((entry) => entry.section === TEST_REQUIREMENTS).map((entry) => entry.mark);
    // No conformance test written anywhere: test reqs carry no mark.
    expect(reqs(markSpecMap([page(spec, record)], noPlan)[0]!)).toEqual(["none", "none"]);
    // The tests follow the first; the second waits for its conformance pulse - and, running, spins.
    const tested = tree({ [TEST_REQUIREMENTS]: ["- Use pytest."], [FUNCTIONAL_REQUIREMENTS]: ["- Say hello."] });
    const first = page(spec, record, tested);
    expect(reqs(markSpecMap([first], noPlan)[0]!)).toEqual(["built", "waiting"]);
    const pulse: MapPulse = {
      number: 3, title: "conformance", track: "conformance", running: true, rowId: "job3",
      before: `["${TEST_REQUIREMENTS}"]\n{"markdown":"- Use pytest."}\n`,
      after: `["${TEST_REQUIREMENTS}"]\n{"markdown":"- Use pytest."}\n{"markdown":"- Run against the sandbox."}\n`,
    };
    expect(reqs(markSpecMap([first], { files: [], codebases: [codebase(first, { pulses: [pulse] })] })[0]!)).toEqual(["built", "growing"]);
  });

  it("shows test reqs only where conformance tests are on - by the config, or asked for this session", () => {
    const spec = tree({ [TEST_REQUIREMENTS]: ["- Use pytest."], [FUNCTIONAL_REQUIREMENTS]: ["- Say hello."] });
    const off = { ...page(spec, null), conformance: false };
    const testReqs = (marked: MarkedPage) => marked.items.filter((entry) => entry.section === TEST_REQUIREMENTS).length;
    expect(testReqs(markSpecMap([off], noPlan)[0]!)).toBe(0);
    // The loop's word wins: bind turned them on for this session.
    expect(testReqs(markSpecMap([off], { files: [], codebases: [codebase(off, { conformance: true })] })[0]!)).toBe(1);
    expect(testReqs(markSpecMap([page(spec, null)], { files: [], codebases: [codebase(page(spec, null), { conformance: false })] })[0]!)).toBe(0);
  });

  it("says what a module waits for", () => {
    const first = page(spec, record);
    const [marked] = markSpecMap([first], { files: [], codebases: [codebase(first, { waitsFor: "base" })] });
    expect(marked!.status).toBe("waits for base");
  });
});

describe("the regeneration drawn", () => {
  it("strikes a ghost through, word-diffs a changed first line, and shows only the sub-bullet that changed under a changed item", () => {
    const first = page(
      tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Register a user.\n  - The response is 201.\n  - Emails are lowercased.", "- Log in."] }),
      tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Register a user.\n  - The response is 200.\n  - Emails are lowercased.", "- Search for users by name."] }),
    );
    const [marked] = markSpecMap([first], noPlan);
    const { lines } = specMapLines([marked!], createSpecMapState(), 100, style);
    const text = lines.join("\n");
    expect(text).toContain("- Register a user.");
    expect(text).toContain("  - The response is [-200.-]{+201.+}");
    expect(text).not.toContain("Emails are lowercased");
    expect(text).toContain("[-- Search for users by name.-]");
    expect(lines.find((line) => line.includes("Search for users"))).toMatch(/^ +− /);
  });

  it("opens an item to where it stands - regrown, and for a functionality bound - its marks in words, then its text and acceptance tests", () => {
    const first = page(
      tree({ [DEFINITIONS]: ["- :User: is a person."], [FUNCTIONAL_REQUIREMENTS]: ["- A :User: can register.\n  - The response is 201.", "- A :User: can log in."] }),
      tree({ [DEFINITIONS]: ["- :User: is a person."], [FUNCTIONAL_REQUIREMENTS]: ["- A :User: can log in."] }),
      tree({ [FUNCTIONAL_REQUIREMENTS]: ["- A :User: can log in."] }),
    );
    const register = first.items.find((entry) => entry.text.startsWith("- A :User: can register"))!;
    const [marked] = markSpecMap([first], { files: [], codebases: [codebase(first, { pulses: [pulseOf([register], 2, false, "registration")] })] });
    const state = createSpecMapState();
    for (const entry of marked!.items) state.open.add(`${marked!.plainFile}\n${entry.key}`);
    const lines = specMapLines([marked!], state, 120, style).lines;
    const text = lines.join("\n");
    // Each line with the mark it explains: the code's, then the conformance tests'.
    expect(text).toContain("│ ✓ regrown - the code is built from it as it reads now");
    expect(text).toContain("│ 2 not regrown yet - to be regrown in pulse 2");
    expect(text).toContain("│ · not bound - no conformance tests for it yet");
    expect(text).toContain("│ ◆ bound - its conformance tests pass: the code is shown, end to end, to do what it says");
    // A definition is not bound: only what the code has of it.
    const user = lines.findIndex((line) => line.includes(":User: is a person."));
    expect(lines[user + 1]).toContain("✓ regrown");
    expect(lines[user + 2]).not.toContain("bound");
    // Not the spec's own text: dimmed, the mark beside it in its own colour.
    const dimmed = specMapLines([marked!], state, 120, { ...style, muted: (t: string) => `<dim>${t}</dim>` }).lines.join("\n");
    expect(dimmed).toContain("│ ✓ <dim>regrown - the code is built from it as it reads now</dim>");
    expect(dimmed).toContain("<dim>not bound - no conformance tests for it yet</dim>");
    // Then its text and acceptance tests, as before.
    expect(text).toContain("  - The response is 201.");
    expect(text).not.toContain("used by");
  });

  it("groups what a module is built from under it - the files it imports, the modules it requires - each closed until opened", () => {
    const items: MapItem[] = [
      { key: "a", section: FUNCTIONAL_REQUIREMENTS, state: "built", text: "- Say hello.", acceptance: [] },
      { key: "b", section: NON_FUNCTIONAL_REQUIREMENTS, state: "built", text: "- Use Python 3.12.", acceptance: [], file: "stdlib/lang/python" },
      { key: "c", section: NON_FUNCTIONAL_REQUIREMENTS, state: "changed", text: "- Use FastAPI.", was: "- Use Flask.", acceptance: [], file: "stdlib/backend/python-fastapi" },
    ];
    const top: MapPage = { module: "top", plainFile: join(dir, "top.plain"), buildDir: "", imports: ["stdlib/lang/python", "stdlib/backend/python-fastapi"], items, requires: "base" };
    const base: MapPage = { module: "base", plainFile: join(dir, "base.plain"), buildDir: "", imports: [], items: [{ key: "d", section: FUNCTIONAL_REQUIREMENTS, state: "built", text: "- Store a value.", acceptance: [] }] };
    const marked = markSpecMap([base, top], { files: [], codebases: [codebase(base)] });
    const state = createSpecMapState();
    const text = specMapLines(marked, state, 100, style).lines.join("\n");
    // The module asked for is open; the one it requires is under it, not at the top.
    expect(text.indexOf("▾ top.plain")).toBeLessThan(text.indexOf("base.plain"));
    expect(text).toContain("imported (2)");
    expect(text).toContain("▸ from stdlib/lang/python · 1 req · all built");
    expect(text).toContain("▸ from stdlib/backend/python-fastapi · 1 req · 1 changing");
    expect(text).not.toContain("Use FastAPI");
    expect(text).toContain("required (1)");
    expect(text).toContain("▸ base.plain");
    expect(text).not.toContain("- Store a value.");
    // Opened, an import block shows its items, word by word where they changed.
    state.imports.set(`${top.plainFile}\nstdlib/backend/python-fastapi`, true);
    expect(specMapLines(marked, state, 100, style).lines.join("\n")).toContain("- Use [-Flask.-]{+FastAPI.+}");
  });

  it("nests the requires chain as it is written - each module under the one that requires it - opened down to the module in focus", () => {
    const module = (name: string, requires?: string): MapPage => ({
      module: name,
      plainFile: join(dir, `${name}.plain`),
      buildDir: join(dir, name),
      imports: [],
      items: [{ key: name, section: FUNCTIONAL_REQUIREMENTS, state: "new", text: `- ${name} works.`, acceptance: [] }],
      ...(requires !== undefined ? { requires } : {}),
    });
    const pages = [module("version_api"), module("function_executor", "version_api"), module("http_client", "function_executor")];
    // The bottom of the chain is being planned: the modules above it open, so it can be seen.
    const marked = markSpecMap(pages, { files: [], codebases: [{ ...codebase(pages[0]!), planning: "code" }] });
    const lines = specMapLines(marked, createSpecMapState(), 120, style).lines;
    const at = (text: string) => lines.findIndex((line) => line.includes(text));
    const indent = (text: string) => /^\W*?(\s*)[▸▾]/.exec(lines[at(text)]!)?.[1]?.length ?? -1;
    // Each a level deeper than the one that requires it - version_api under function_executor, not beside it.
    expect(lines.filter((line) => line.includes("required (")).length).toBe(2);
    expect(at("▾ http_client.plain")).toBeLessThan(at("▾ function_executor.plain"));
    expect(at("▾ function_executor.plain")).toBeLessThan(at("version_api.plain"));
    expect(indent("function_executor.plain")).toBeGreaterThan(indent("http_client.plain"));
    expect(indent("version_api.plain")).toBeGreaterThan(indent("function_executor.plain"));
    expect(lines.join("\n")).toContain("- version_api works.");
  });

  it("heads the map with the module the cursor is in, its count and status, and has a row for each module - only the one in focus open", () => {
    const base = markSpecMap([{ ...page(tree({ [FUNCTIONAL_REQUIREMENTS]: ["- One."] }), tree({ [FUNCTIONAL_REQUIREMENTS]: ["- One."] })), module: "base", plainFile: join(dir, "base.plain") }], noPlan)[0]!;
    const top = markSpecMap([{ ...page(tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Two.", "- Three."] }), tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Two."] })), module: "top", plainFile: join(dir, "top.plain") }], noPlan)[0]!;
    const head = specMapHeader(top, 160, style);
    expect(head).toContain("regen  top.plain");
    expect(head).toContain("1 of 2 functionalities built · not asked to build - regrow plans it");
    // Nothing asked for, nothing growing: the first module is in focus.
    const text = specMapLines([base, top], createSpecMapState(), 160, style).lines.join("\n");
    expect(text).toContain("▾ base.plain");
    expect(text).toContain("- One.");
    expect(text).toContain("▸ top.plain");
    expect(text).toContain("1/2 built · not asked to build - regrow plans it");
    expect(text).not.toContain("- Two.");
  });

  it("opens the module growing now, and the one asked for, before the others", () => {
    const base = { ...page(tree({ [FUNCTIONAL_REQUIREMENTS]: ["- One."] }), null), module: "base", plainFile: join(dir, "base.plain") };
    const top = { ...page(tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Two."] }), null), module: "top", plainFile: join(dir, "top.plain") };
    // The chain's codebase is asked for: the module at its top is in focus.
    const asked = markSpecMap([base, top], { files: [], codebases: [codebase(base)] });
    expect(focusOf(asked)?.module).toBe("top");
    // A pulse grows the module below: that one is.
    const one = base.items[0]!;
    const growing = markSpecMap([base, top], { files: [], codebases: [codebase(base, { pulses: [pulseOf([one], 1, true)] })] });
    expect(focusOf(growing)?.module).toBe("base");
  });

  it("highlights the spec as plyn does - its section headings, concepts and literals - the words a diff keeps too", () => {
    const paint = { ...PLAIN_PAINT, syntax: (role: string, text: string) => `<${role}>${text}</${role}>` };
    const first = page(
      tree({ [FUNCTIONAL_REQUIREMENTS]: ["- A :User: can log in via `POST /auth/login`.", "- A :User: can sign out via `POST /auth/logout`."] }),
      tree({ [FUNCTIONAL_REQUIREMENTS]: ["- A :User: can log in via `POST /auth/login`.", "- A :User: can log out via `POST /auth/logout`."] }),
    );
    const [marked] = markSpecMap([first], noPlan);
    const text = specMapLines([marked!], createSpecMapState(), 300, { ...style, diff: paint }).lines.join("\n");
    expect(text).toContain("<section>***functional specs***</section>");
    expect(text).toContain("<bullet>-</bullet> A <concept>:User:</concept> can log in via <literal>`POST /auth/login`</literal>.");
    expect(text).toContain("A <concept>:User:</concept> can [-log-]{+sign+} out via <literal>`POST /auth/logout`</literal>.");
  });

  it("diffs a line word by word and an item line by line", () => {
    expect(wordDiff("3 to 30 characters", "3 to 20 characters", style)).toBe("3 to [-30-]{+20+} characters");
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual([{ was: "a", now: "a" }, { was: "b", now: "B" }, { was: "c", now: "c" }]);
  });
});

describe("the side panel's two views", () => {
  const job = (id: string) => ({ id, kind: "regrow", summary: "app.plain log in", module: "app", status: "running" as const, sequence: 1, queuedAt: 0, startedAt: Date.now(), waitingOn: [], tail: "", activity: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, agents: [], transcript: [] });

  it("opens on regen, and p goes to the pulse growing the item under the cursor and back to the item", () => {
    const first = page(tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Register.", "- Log in."] }), tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Register."] }));
    const login = first.items.find((entry) => entry.text === "- Log in.")!;
    const marked = markSpecMap([first], { files: [], codebases: [codebase(first, { pulses: [pulseOf([login], 1, true)] })] });
    const panel = createSidePanel({ jobs: () => [job("job1")], map: () => marked, rows: () => 20, style, back() {}, close() {}, key: "ctrl+h" });
    expect(panel.render(100)[0]).toContain("regen");
    panel.handleInput("\x1b[B");
    panel.handleInput("\x1b[B");
    panel.handleInput("p");
    const pulses = panel.render(100);
    expect(pulses[0]).toContain("Pulses");
    expect(pulses.find((line) => line.startsWith("›"))).toContain("app regrow");
    panel.handleInput("p");
    const map = panel.render(100);
    expect(map.find((line) => line.startsWith("›"))).toContain("- Log in.");
  });

  it("shows what failed when the map cannot be drawn, rather than throwing - a frame that throws freezes the screen", () => {
    const panel = createSidePanel({ jobs: () => [], map: () => { throw new Error("the plan could not be read"); }, rows: () => 20, style, back() {}, close() {}, key: "ctrl+h" });
    const lines = panel.render(100);
    expect(lines).toHaveLength(20);
    expect(lines[2]).toContain("could not be drawn: Error: the plan could not be read");
    panel.handleInput("p");
    expect(panel.render(100)[0]).toContain("Pulses");
  });

  it("reads a plan that fails as a page saying so", () => {
    writeFileSync(join(dir, "app.plain"), "***implementation reqs***\n\n- Use Python.\n\n***functional specs***\n\n- Say hello.\n");
    const source = createSpecMapSource({ files: () => [join(dir, "app.plain")], plan: () => { throw new Error("no plan"); } });
    expect(source.read()[0]).toMatchObject({ status: "the map could not be read: no plan", stuck: true });
  });

  it("opens and closes a module with enter and the arrow keys, and heads the map with the module the cursor is in", () => {
    const base = { ...page(tree({ [FUNCTIONAL_REQUIREMENTS]: ["- One."] }), null), module: "base", plainFile: join(dir, "base.plain") };
    const top = { ...page(tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Two."] }), null), module: "top", plainFile: join(dir, "top.plain") };
    const marked = markSpecMap([base, top], noPlan);
    const panel = createSidePanel({ jobs: () => [], map: () => marked, rows: () => 20, style, back() {}, close() {}, key: "ctrl+h" });
    expect(panel.render(100)[0]).toContain("base.plain");
    expect(panel.render(100).join("\n")).not.toContain("- Two.");
    // Down past base's item onto top's row: the top line follows, and enter opens it.
    panel.handleInput("\x1b[B");
    panel.handleInput("\x1b[B");
    expect(panel.render(100)[0]).toContain("top.plain");
    panel.handleInput("\r");
    expect(panel.render(100).join("\n")).toContain("- Two.");
    // ← on an item goes up to its module; ← again closes it.
    panel.handleInput("\x1b[B");
    panel.handleInput("\x1b[D");
    panel.handleInput("\x1b[D");
    expect(panel.render(100).join("\n")).not.toContain("- Two.");
  });
});

describe("the work loop's plan for the map", () => {
  it("numbers the module's pulses - the running one, then each planned one after it - with the trees each goes between", async () => {
    writeFileSync(join(dir, "app.plain"), "***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n- Say hello.\n\n- Say goodbye.\n");
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => (release = resolve));
    const run: JobRunner = async (job) => {
      await hold;
      mkdirSync(job.buildDir, { recursive: true });
      writeCodeRecord(job.buildDir, job.spec.tree);
      recordHistory(job.buildDir, job.planned.title);
      return { landed: true, report: "landed" };
    };
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false, run });
    await loop.bringUp("app.plain");
    // Planned from what the running one will land: the next look plans the rest.
    await loop.bringUp("app.plain");
    const plan = loop.mapPlan();
    expect(plan.files).toEqual([join(dir, "app.plain")]);
    const [only] = plan.codebases;
    expect(only!.pulses.map((pulse) => [pulse.number, pulse.title, pulse.running])).toEqual([
      [1, "Say hello.", true],
      [2, "Say goodbye.", false],
    ]);
    // The rows the pulse list shows them as.
    expect(only!.pulses[0]!.rowId).toBe(registry.list()[0]!.id);
    expect(loop.planned().map((row) => row.id)).toContain(only!.pulses[1]!.rowId);

    const [marked] = markSpecMap(readSpecMap(plan.files), plan);
    expect(marked!.items.filter((entry) => entry.section === FUNCTIONAL_REQUIREMENTS).map((entry) => [entry.text, entry.mark])).toEqual([
      ["- Say hello.", "growing"],
      ["- Say goodbye.", "planned"],
    ]);
    release();
    await loop.drain();
    const [done] = markSpecMap(readSpecMap(plan.files), loop.mapPlan());
    expect(done!.items.every((entry) => entry.mark === "built")).toBe(true);
    expect(done!.status).toBe("all built");
  });

  it("keeps a pulse that did not land with the halt, for the map to mark its items", async () => {
    writeFileSync(join(dir, "app.plain"), "***implementation reqs***\n\n- Use Python.\n\n***functional specs***\n\n- Say hello.\n");
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: async () => ({ landed: false, report: "did not pass" }) });
    await loop.bringUp("app.plain");
    await loop.drain();
    const plan = loop.mapPlan();
    expect(plan.codebases[0]!.stuck).toMatchObject({ pulse: { number: 1 } });
    const [marked] = markSpecMap(readSpecMap(plan.files), plan);
    expect(marked!.items.find((entry) => entry.text === "- Say hello.")).toMatchObject({ mark: "stuck", rolledBack: 1 });
    expect(marked!.status).toBe("halted - pulse 1 didn't land");
  });
});

