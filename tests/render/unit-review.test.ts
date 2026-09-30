import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What the stand-in reviewer answers, review after review; and every prompt it was given. */
const verdicts: Array<{ pass: boolean; problems: Array<{ file: string; test?: string; kind: string; what: string; blocking: boolean }> }> = [];
const reviewPrompts: string[] = [];
/** What the stand-in arbiter rules, weighing after weighing - by problem number - and every prompt it was given. */
const rulings: Array<Array<{ problem: number; uphold: boolean; why: string }> | undefined> = [];
const arbiterPrompts: string[] = [];

vi.mock("../../src/pi.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pi.ts")>();
  type Session = { tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> };
  return {
    ...actual,
    createExecutor: async (opts: { customTools: Session["tools"] }) => ({ tools: opts.customTools, dispose() {} }),
    ask: vi.fn(async (session: Session, prompt: string) => {
      const arbiter = session.tools.find((tool) => tool.name === "submit_ruling");
      if (arbiter !== undefined) {
        arbiterPrompts.push(prompt);
        const ruling = rulings.shift();
        if (ruling !== undefined) await arbiter.execute("id", { rulings: ruling });
        return "Ruled.";
      }
      reviewPrompts.push(prompt);
      const verdict = verdicts.shift() ?? { pass: true, problems: [] };
      await session.tools.find((tool) => tool.name === "submit_review")!.execute("id", verdict);
      return "Reviewed.";
    }),
  };
});

const { changedUnitTests, untilUnitTestsReviewed, UNIT_REVIEW_LIMIT, UNIT_REVIEW_ROUNDS } = await import("../../src/render/unit-review.ts");
const { digestFiles } = await import("../../src/render/codebase.ts");
const { readNotes, recordNote } = await import("../../src/render/notes.ts");
const { recordHistory } = await import("../../src/render/history.ts");
const { reviewedSpec } = await import("../../src/render/prompt.ts");

let root: string;
/** The module's code folder, with a history: the review is shown what the work wrote since its last commit. */
let dir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plainwright-unit-review-"));
  dir = join(root, "app", "code");
  mkdirSync(dir, { recursive: true });
  verdicts.length = 0;
  reviewPrompts.length = 0;
  rulings.length = 0;
  arbiterPrompts.length = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const weak = { file: "test_app.py", kind: "bad" as const, what: "only checks that register returns something - not the user it stores", blocking: true };
const better = { file: "test_app.py", kind: "bad" as const, what: "could check the error message too", blocking: false };

/** The stand-in coding agent: it takes each prompt, and - when it reflects - leaves the review's lesson in the notes. */
function loop(sent: string[], passing = true, reflects = true, fixes?: () => void) {
  writeFileSync(join(dir, "main.py"), "import app\n");
  recordHistory(dir, "render app fs 0");
  const atStart = digestFiles(dir);
  writeFileSync(join(dir, "app.py"), "def register(email): return {'email': email}\n");
  writeFileSync(join(dir, "test_app.py"), "def test_register(): assert register('a@b.c')\n");
  return untilUnitTestsReviewed({
    buildDir: dir,
    atStart,
    what: "functionality 1 of module `app`",
    spec: reviewedSpec({
      moduleName: "app",
      specifications: { definitions: [], "implementation reqs": [], "test reqs": [], "functional specs": ["- A visitor registers with an email; the user is stored with it."] } as never,
      frid: "1",
    }),
    label: "app 1",
    send: async (prompt) => {
      sent.push(prompt);
      if (prompt.includes("A review of the work found")) fixes?.();
      if (reflects && prompt.includes("leave the lesson")) recordNote(dir, "pitfalls", `Tests assert what register stores, never only that it returned (${sent.length})`, "app 1");
    },
    untilPassing: async () => passing,
    stage: () => {},
  });
}

describe("the unit test review", () => {
  it("reads the unit tests the work added or changed, not the code or tests it left alone", () => {
    writeFileSync(join(dir, "test_old.py"), "def test_old(): assert 1 == 1\n");
    const atStart = digestFiles(dir);
    writeFileSync(join(dir, "app.py"), "x = 1\n");
    writeFileSync(join(dir, "test_app.py"), "def test_x(): assert x == 1\n");
    expect(changedUnitTests(dir, atStart)).toEqual(["test_app.py"]);
  });

  it("sends a test that only checks that something came back to the coding agent, and passes once it tests what the spec says", async () => {
    verdicts.push({ pass: false, problems: [weak] }, { pass: true, problems: [] });
    const sent: string[] = [];
    const result = await loop(sent);
    expect(result).toEqual({ passed: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("BLOCKING · BAD · test_app.py: only checks that register returns something");
    expect(reviewPrompts[0]).toContain("<unit tests added or changed>\ntest_app.py\n</unit tests added or changed>");
    expect(reviewPrompts[0]).toContain("A visitor registers with an email");
    // The next review checks what the last one found, first.
    expect(reviewPrompts[1]).toContain("The review before this one sent the tests back with these problems");
  });

  it("shows the reviewer the spec as the coding agent had it, what is new in this work apart, and the code the work wrote - afresh each review", async () => {
    verdicts.push({ pass: false, problems: [weak] }, { pass: true, problems: [] });
    await loop([], true, true, () => writeFileSync(join(dir, "test_app.py"), "def test_register(): assert register('a@b.c') == {'email': 'a@b.c'}\n"));
    expect(reviewPrompts[0]).toContain("How to read what follows:");
    expect(reviewPrompts[0]).toContain(
      '<new in this work>\n<functionality module="app" id="1">\n- A visitor registers with an email; the user is stored with it.\n</functionality>',
    );
    expect(reviewPrompts[0]).toContain("<the code this work wrote - a diff of the code folder from where the work started>\ndiff --git a/app.py b/app.py");
    expect(reviewPrompts[0]).toContain("+def register(email): return {'email': email}");
    // The code it left alone is not in the diff.
    expect(reviewPrompts[0]).not.toContain("+import app");
    expect(reviewPrompts[0]).toContain("+def test_register(): assert register('a@b.c')\n");
    // The fix the coding agent made after the first review is what the second one reads.
    expect(reviewPrompts[1]).toContain("+def test_register(): assert register('a@b.c') == {'email': 'a@b.c'}");
  });

  it("reviews the code too - code that does not do what the spec says goes back to the coding agent to fix", async () => {
    verdicts.push(
      { pass: false, problems: [{ file: "app.py", test: "register", kind: "wrong_code", what: "stores nothing - the spec says the user is stored with the email", blocking: true }] },
      { pass: true, problems: [] },
    );
    const sent: string[] = [];
    expect(await loop(sent)).toEqual({ passed: true });
    expect(reviewPrompts[0]).toContain("Check that the code does what the specification states for this work:");
    expect(reviewPrompts[0]).toContain("When the work wrote no code at all, or none for a behaviour, that behaviour is not implemented: raise it.");
    expect(sent[0]).toContain("- BLOCKING · WRONG · app.py · register: stores nothing");
    expect(sent[0]).toContain("make the code WRONG names do what the specification says");
  });

  it("asks the coding agent for the lesson, as a rule for the agents after it - and asks once more when it left none", async () => {
    verdicts.push({ pass: false, problems: [weak] }, { pass: true, problems: [] });
    const sent: string[] = [];
    await loop(sent);
    expect(sent[0]).toContain("add to the pitfalls what this review taught");
    expect(readNotes(dir).pitfalls.join("\n")).toContain("Tests assert what register stores, never only that it returned");
    expect(sent).toHaveLength(1);

    verdicts.push({ pass: false, problems: [weak] }, { pass: true, problems: [] });
    const forgot: string[] = [];
    await loop(forgot, true, false);
    expect(forgot).toHaveLength(2);
    expect(forgot[1]).toContain("You worked on what the review found, but left no lesson in the notes");
  });

  it("has the arbiter weigh the third review that sends the tests back - and approve them when it finds the reviewer picky", async () => {
    for (let i = 0; i < UNIT_REVIEW_ROUNDS; i += 1) verdicts.push({ pass: false, problems: [better] });
    rulings.push([{ problem: 1, uphold: false, why: "a nitpick: the error is already tested" }]);
    const sent: string[] = [];
    const result = await loop(sent);
    expect(result.passed).toBe(true);
    expect(result.waived).toEqual([better]);
    // Two reviews went to the coding agent; the third went to the arbiter, which let it go.
    expect(sent).toHaveLength(UNIT_REVIEW_ROUNDS - 1);
    expect(arbiterPrompts).toHaveLength(1);
    expect(arbiterPrompts[0]).toContain("You are the arbiter");
    expect(arbiterPrompts[0]).toContain("1. BAD · test_app.py: could check the error message too");
    expect(arbiterPrompts[0]).toContain("review 2:");
    expect(arbiterPrompts[0]).not.toContain("review 3:");
    // The same spec and code the reviewer read.
    expect(arbiterPrompts[0]).toContain('<new in this work>\n<functionality module="app" id="1">');
    expect(arbiterPrompts[0]).toContain("+def register(email): return {'email': email}");
    expect(readNotes(dir).pitfalls.join("\n")).toContain("the arbiter let go what the unit test review raised: test_app.py: could check the error message too - a nitpick");
  });

  it("sends the coding agent only what the arbiter upholds - the reviewer is sometimes right", async () => {
    for (let i = 0; i < UNIT_REVIEW_ROUNDS; i += 1) verdicts.push({ pass: false, problems: [weak, better] });
    verdicts.push({ pass: true, problems: [] });
    rulings.push([
      { problem: 1, uphold: true, why: "register's stored user is the behaviour the spec states, and nothing tests it" },
      { problem: 2, uphold: false, why: "out of scope" },
    ]);
    const sent: string[] = [];
    const result = await loop(sent);
    expect(result.passed).toBe(true);
    expect(result.waived).toEqual([better]);
    const last = sent.filter((prompt) => prompt.includes("A review of the work found")).at(-1)!;
    expect(last).toContain("only checks that register returns something");
    expect(last).not.toContain("could check the error message too");
  });

  it("lets the review stand when the arbiter gives no ruling", async () => {
    for (let i = 0; i < UNIT_REVIEW_ROUNDS; i += 1) verdicts.push({ pass: false, problems: [weak] });
    verdicts.push({ pass: true, problems: [] });
    rulings.push(undefined);
    const sent: string[] = [];
    const result = await loop(sent);
    expect(result).toEqual({ passed: true });
    expect(sent.filter((prompt) => prompt.includes("A review of the work found"))).toHaveLength(UNIT_REVIEW_ROUNDS);
  });

  it("gives the reviewer the voice of the exacting developer, who raises everything and leaves the weighing to the arbiter", async () => {
    verdicts.push({ pass: true, problems: [] });
    await loop([]);
    expect(reviewPrompts[0]).toContain("You are the exacting reviewer: opinionated, thorough, and hard to satisfy.");
  });

  it("is an optimiser, not a gate: a behaviour still untested after its last review is let go, noted, and the work goes on", async () => {
    for (let i = 0; i < UNIT_REVIEW_LIMIT; i += 1) verdicts.push({ pass: false, problems: [weak] });
    for (let i = 0; i < UNIT_REVIEW_LIMIT; i += 1) rulings.push([{ problem: 1, uphold: true, why: "untested" }]);
    const sent: string[] = [];
    const result = await loop(sent);
    expect(UNIT_REVIEW_LIMIT).toBe(10);
    expect(result.passed).toBe(true);
    expect(result.waived).toEqual([weak]);
    expect(sent).toHaveLength(UNIT_REVIEW_LIMIT);
    expect(readNotes(dir).pitfalls.join("\n")).toContain(`the unit tests went on after ${UNIT_REVIEW_LIMIT} reviews`);
  });

  it("takes the reviewer's own words for a problem's kind - one wrong word never throws a valid review away", async () => {
    verdicts.push(
      {
        pass: false,
        problems: [
          { file: "test_app.py", kind: "weak_test" as never, what: "only checks something came back", blocking: true },
          { file: "test_app.py", kind: "missing test coverage" as never, what: "no test for a duplicate email", blocking: true },
        ],
      },
      { pass: true, problems: [] },
    );
    const sent: string[] = [];
    expect((await loop(sent)).passed).toBe(true);
    expect(sent[0]).toContain("BLOCKING · BAD · test_app.py: only checks something came back");
    expect(sent[0]).toContain("BLOCKING · MISSING · test_app.py: no test for a duplicate email");
  });

  it("stops when the unit tests no longer pass after the coding agent worked on them", async () => {
    verdicts.push({ pass: false, problems: [weak] });
    const result = await loop([], false);
    expect(result.passed).toBe(false);
  });
});
