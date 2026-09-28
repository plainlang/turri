import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What the stand-in reviewer answers, review after review; and every prompt it was given. */
const verdicts: Array<{ pass: boolean; problems: Array<{ file: string; kind: "missing" | "bad"; what: string; blocking: boolean }> }> = [];
const reviewPrompts: string[] = [];

vi.mock("../../src/pi.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pi.ts")>();
  type Session = { tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> };
  return {
    ...actual,
    createExecutor: async (opts: { customTools: Session["tools"] }) => ({ tools: opts.customTools, dispose() {} }),
    ask: vi.fn(async (session: Session, prompt: string) => {
      reviewPrompts.push(prompt);
      const verdict = verdicts.shift() ?? { pass: true, problems: [] };
      await session.tools.find((tool) => tool.name === "submit_review")!.execute("id", verdict);
      return "Reviewed.";
    }),
  };
});

const { changedUnitTests, untilUnitTestsReviewed, UNIT_REVIEW_LIMIT, UNIT_REVIEW_ROUNDS } = await import("../../src/render/unit-review.ts");
const { digestFiles } = await import("../../src/render/codebase.ts");
const { readNotes } = await import("../../src/render/notes.ts");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plainwright-unit-review-"));
  verdicts.length = 0;
  reviewPrompts.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const weak = { file: "test_app.py", kind: "bad" as const, what: "only checks that register returns something - not the user it stores", blocking: true };
const better = { file: "test_app.py", kind: "bad" as const, what: "could check the error message too", blocking: false };

function loop(sent: string[], passing = true) {
  const atStart = digestFiles(dir);
  writeFileSync(join(dir, "app.py"), "def register(email): return {'email': email}\n");
  writeFileSync(join(dir, "test_app.py"), "def test_register(): assert register('a@b.c')\n");
  return untilUnitTestsReviewed({
    buildDir: dir,
    atStart,
    what: "functionality 1",
    specText: "***functional specs***\n\n- A visitor registers with an email; the user is stored with it.\n",
    label: "app 1",
    send: async (prompt) => void sent.push(prompt),
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

  it("lets go of what only makes good tests better after a few reviews - and keeps it in the notes", async () => {
    for (let i = 0; i < UNIT_REVIEW_ROUNDS; i += 1) verdicts.push({ pass: false, problems: [better] });
    const sent: string[] = [];
    const result = await loop(sent);
    expect(result.passed).toBe(true);
    expect(result.waived).toEqual([better]);
    expect(sent).toHaveLength(UNIT_REVIEW_ROUNDS - 1);
    expect(readNotes(dir).pitfalls.join("\n")).toContain("the unit tests were optimised as far as");
  });

  it("never lets go of a behaviour left untested: it stops the work after its last review", async () => {
    for (let i = 0; i < UNIT_REVIEW_LIMIT; i += 1) verdicts.push({ pass: false, problems: [weak] });
    const result = await loop([]);
    expect(result.passed).toBe(false);
    expect(result.problems).toEqual([weak]);
  });

  it("stops when the unit tests no longer pass after the coding agent worked on them", async () => {
    verdicts.push({ pass: false, problems: [weak] });
    const result = await loop([], false);
    expect(result.passed).toBe(false);
  });
});
