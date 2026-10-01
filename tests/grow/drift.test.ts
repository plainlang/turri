import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MarshalledPlainSource } from "../../src/plain/spec.ts";
import { codeTree, conformanceTarget, readRecord, RECORD_FILE, writeCodeRecord, writeTestsRecord } from "../../src/grow/records.ts";
import { casesOf, codeWork, conceptsUsed, conformanceWork, stillWanted } from "../../src/grow/drift.ts";

const spec = (markdown: string, tests: string[] = []) => ({ markdown, ...(tests.length > 0 ? { acceptance_tests: tests.map((test) => ({ markdown: test })) } : {}) });
const item = (markdown: string) => ({ markdown });

/** A small spec: two concepts, one using the other, and three functional specs. */
const shop = (overrides: Partial<Record<string, unknown>> = {}): MarshalledPlainSource =>
  ({
    definitions: [item("- :Price: is the net amount of an :Order:."), item("- :Order: is what a :Customer: buys."), item("- :Customer: is a person with an account.")],
    "implementation reqs": [item("- :Implementation: is Python.")],
    "test reqs": [item("- :ConformanceTests: use pytest.")],
    "functional specs": [
      spec("- A :Customer: signs up.", ["Signing up twice fails."]),
      spec("- A :Customer: places an :Order:."),
      spec("- The :Price: of an :Order: is shown.", ["A price of 10 shows as 10.00."]),
    ],
    ...overrides,
  }) as MarshalledPlainSource;

const fs = (tree: MarshalledPlainSource) => tree["functional specs"] as Array<{ markdown: string; frid?: string; acceptance_tests?: unknown }>;

describe("the code record", () => {
  it("holds the spec without its test reqs and without the acceptance tests under the functional specs", () => {
    const tree = codeTree(shop());
    expect(tree["test reqs"]).toBeUndefined();
    expect(fs(tree).every((entry) => entry.acceptance_tests === undefined)).toBe(true);
    expect(fs(tree).map((entry) => entry.markdown)).toEqual(fs(shop()).map((entry) => entry.markdown));
    expect(tree.definitions).toEqual(shop().definitions);
  });

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "turri-records-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is written as the code sees the spec, and read back from the file when there is no history", () => {
    writeCodeRecord(join(dir, "code"), shop());
    const written = JSON.parse(readFileSync(join(dir, "code", RECORD_FILE), "utf8")) as MarshalledPlainSource;
    expect(written["test reqs"]).toBeUndefined();
    expect(readRecord(join(dir, "code"))).toEqual(codeTree(shop()));
  });

  it("reads as nothing when there is none", () => {
    expect(readRecord(join(dir, "code"))).toBeNull();
  });

  it("keeps the tests record in the tests folder as it is given", () => {
    const target = conformanceTarget(codeTree(shop()), null, shop());
    writeTestsRecord(join(dir, "tests"), target);
    expect(readRecord(join(dir, "tests"))).toEqual(target);
  });
});

describe("the code work", () => {
  it("is everything the spec has when nothing is built - but not its test reqs or acceptance tests", () => {
    const work = codeWork(null, shop());
    expect(work.some((change) => change.section === "test reqs")).toBe(false);
    expect(work.filter((change) => change.section === "functional specs")).toHaveLength(3);
    expect(work.every((change) => !(change.after ?? "").includes("acceptance_tests"))).toBe(true);
  });

  it("is nothing once the code is built from the spec, whatever its test reqs and acceptance tests say", () => {
    const record = codeTree(shop());
    const changed = shop({ "test reqs": [item("- :ConformanceTests: use unittest.")] });
    fs(changed)[0]!.acceptance_tests = [{ markdown: "Signing up with no email fails." }];
    expect(codeWork(record, changed)).toEqual([]);
  });

  it("is the one functional spec changed, when only it changed", () => {
    const now = shop();
    fs(now)[1]!.markdown = "- A :Customer: places an :Order: of one or more items.";
    const work = codeWork(codeTree(shop()), now);
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({ section: "functional specs", kind: "change" });
  });
});

describe("the conformance work", () => {
  it("is every functional spec the code is built from, with its acceptance tests and the test reqs, when none is tested", () => {
    const work = conformanceWork(null, codeTree(shop()), shop());
    const specs = work.filter((change) => change.section === "functional specs");
    expect(specs).toHaveLength(3);
    expect(specs[0]!.after).toContain("Signing up twice fails.");
    expect(work.some((change) => change.section === "test reqs")).toBe(true);
  });

  it("holds only the functional specs chosen, each with its number", () => {
    const target = conformanceTarget(codeTree(shop()), null, shop(), (frid) => frid === "3");
    expect(fs(target).map((entry) => entry.frid)).toEqual(["3"]);
  });

  it("never goes ahead of the code: a functional spec not built yet has no conformance work", () => {
    const code = codeTree(shop({ "functional specs": fs(shop()).slice(0, 2) }));
    expect(fs(conformanceTarget(code, null, shop())).map((entry) => entry.frid)).toEqual(["1", "2"]);
  });

  it("waits for the code: a functional spec changed in the spec but not yet in the code keeps the tests it has", () => {
    const tested = conformanceTarget(codeTree(shop()), null, shop());
    const now = shop();
    fs(now)[1]!.markdown = "- A :Customer: places an :Order: of one or more items.";
    // The code record is still the old one: the change is not built.
    expect(conformanceWork(tested, codeTree(shop()), now)).toEqual([]);
    // Once the code lands, the tests follow.
    const work = conformanceWork(tested, codeTree(now), now);
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({ section: "functional specs", kind: "change" });
  });

  it("is an acceptance test changed alone, with no code work for it", () => {
    const tested = conformanceTarget(codeTree(shop()), null, shop());
    const now = shop();
    fs(now)[2]!.acceptance_tests = [{ markdown: "A price of 10 shows as 10.00 EUR." }];
    expect(codeWork(codeTree(shop()), now)).toEqual([]);
    expect(conformanceWork(tested, codeTree(shop()), now)).toHaveLength(1);
  });
});

describe("a job's cases", () => {
  it("is fresh and adds every functional spec, for a first build of a module that requires none", () => {
    const cases = casesOf({}, codeWork(null, shop()), { fresh: true });
    expect(cases.fresh).toBe(true);
    expect(cases.add.map((entry) => entry.frid)).toEqual(["1", "2", "3"]);
    expect(cases.mechanical).toBe(false);
  });

  it("adds a functional spec appended to what is built", () => {
    const built = codeTree(shop());
    const now = shop({ "functional specs": [...fs(shop()), spec("- A :Customer: cancels an :Order:.")] });
    const cases = casesOf(built, codeWork(built, now));
    expect(cases.add).toEqual([{ frid: "4", text: "A :Customer: cancels an :Order:." }]);
    expect(cases.patch).toEqual([]);
  });

  it("deletes a functional spec taken out, numbered as it was", () => {
    const built = codeTree(shop());
    const now = shop({ "functional specs": [fs(shop())[0]!, fs(shop())[2]!] });
    const cases = casesOf(built, codeWork(built, now));
    expect(cases.delete).toEqual([{ frid: "2", text: "A :Customer: places an :Order:." }]);
  });

  it("patches every functional spec that uses a concept whose definition changed, directly or through another concept", () => {
    const built = codeTree(shop());
    const now = shop({ definitions: [item("- :Price: is the net amount of an :Order:."), item("- :Order: is what a :Customer: buys, with at least one item."), item("- :Customer: is a person with an account.")] });
    const priceOnly = (tree: MarshalledPlainSource) => ({ ...tree, "functional specs": [...fs(tree).slice(0, 2), spec("- The :Price: is shown.")] }) as MarshalledPlainSource;
    const cases = casesOf(priceOnly(built), codeWork(priceOnly(built), priceOnly(now)));
    // 2 names :Order:; 3 names only :Price:, whose definition names :Order:. 1 names only :Customer:.
    expect(cases.patch.map((entry) => entry.frid)).toEqual(["2", "3"]);
    expect(cases.mechanical).toBe(false);
  });

  it("is mechanical when only an implementation req changed", () => {
    const built = codeTree(shop());
    const now = shop({ "implementation reqs": [item("- :Implementation: is Python 3.13.")] });
    const cases = casesOf(built, codeWork(built, now));
    expect(cases).toMatchObject({ add: [], patch: [], delete: [], mechanical: true });
  });

  it("is mechanical for the conformance tests when only the test reqs changed", () => {
    const tested = conformanceTarget(codeTree(shop()), null, shop());
    const now = shop({ "test reqs": [item("- :ConformanceTests: use pytest, one file per functional spec.")] });
    const cases = casesOf(tested, conformanceWork(tested, codeTree(shop()), now));
    expect(cases.mechanical).toBe(true);
  });

  it("patches a functional spec's conformance tests when only its acceptance tests changed, by its number", () => {
    const tested = conformanceTarget(codeTree(shop()), null, shop());
    const now = shop();
    fs(now)[2]!.acceptance_tests = [{ markdown: "A price of 10 shows as 10.00 EUR." }];
    const cases = casesOf(tested, conformanceWork(tested, codeTree(shop()), now));
    expect(cases.patch.map((entry) => entry.frid)).toEqual(["3"]);
  });

  it("follows concepts through their definitions, and stops at a cycle", () => {
    const definitions = [item("- :A: is part of a :B:."), item("- :B: holds an :A:."), item("- :C: is on its own.")];
    expect([...conceptsUsed("- Every :A: is shown.", definitions)].sort()).toEqual([":A:", ":B:"]);
  });
});

describe("the stop rule", () => {
  it("lets a running job finish while the spec still wants everything it makes", () => {
    const built = codeTree(shop({ "functional specs": fs(shop()).slice(0, 2) }));
    const running = codeWork(built, shop());
    const now = shop({ "functional specs": [...fs(shop()), spec("- A :Customer: cancels an :Order:.")] });
    expect(stillWanted(running, codeWork(built, now))).toBe(true);
  });

  it("stops a running job once the spec no longer wants something it makes", () => {
    const built = codeTree(shop({ "functional specs": fs(shop()).slice(0, 2) }));
    const running = codeWork(built, shop());
    const now = shop();
    fs(now)[2]!.markdown = "- The :Price: of an :Order: is shown, with tax.";
    expect(stillWanted(running, codeWork(built, now))).toBe(false);
  });
});
