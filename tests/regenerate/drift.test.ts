import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MarshalledPlainSource } from "../../src/plain/spec.ts";
import { codeTree, conformanceTarget, notBuilt, readRecord, RECORD_FILE, writeCodeRecord, writeTestsRecord } from "../../src/regenerate/records.ts";
import { casesOf, codeWork, conceptsUsed, conformanceWork, stillWanted, whyNotWanted } from "../../src/regenerate/drift.ts";
import { REGENERATE_AGAIN } from "../../src/regenerate/records.ts";

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

  it("reads a record of the layout before, taking its own functional specs up to the first whose unit tests did not pass", () => {
    const entry = (frid: string, spec: string, unitTests: string, module = "shop") => ({ module, frid, spec, unitTests });
    const stored = {
      version: 2,
      module: "shop",
      definitions: ["- :Customer: is a person."],
      "functional specs": [entry("2", "- A :Customer: signs in.", "passed"), entry("1", "- A :Customer: signs up.", "passed"), entry("3", "- A :Customer: pays.", "failed"), entry("4", "- A :Customer: leaves.", "passed"), entry("1", "- Accounts are kept.", "passed", "base")],
    };
    mkdirSync(join(dir, "code"), { recursive: true });
    writeFileSync(join(dir, "code", RECORD_FILE), JSON.stringify(stored));
    const tree = readRecord(join(dir, "code"))!;
    expect(fs(tree).map((one) => one.markdown)).toEqual(["- A :Customer: signs up.", "- A :Customer: signs in."]);
    expect(tree["required functional specs"]).toEqual([{ markdown: "- Accounts are kept.", module: "base", frid: "1" }]);
    expect(tree.definitions).toEqual([item("- :Customer: is a person.")]);
  });

  it("reads the first layout of all, a snapshot a functionality, up to the first whose unit tests did not pass", () => {
    const snapshot = (frid: string, specs: string[], unitTests: string) => ({ frid, unitTests, specifications: { "functional specs": specs, definitions: ["- :Customer: is a person."] } });
    const stored = { module: "shop", functionalities: { b: snapshot("2", ["- A :Customer: signs up.", "- A :Customer: signs in."], "passed"), a: snapshot("1", ["- A :Customer: signs up."], "passed"), c: snapshot("3", ["- x", "- y", "- A :Customer: pays."], "") } };
    mkdirSync(join(dir, "code"), { recursive: true });
    writeFileSync(join(dir, "code", RECORD_FILE), JSON.stringify(stored));
    const tree = readRecord(join(dir, "code"))!;
    expect(fs(tree).map((one) => one.markdown)).toEqual(["- A :Customer: signs up.", "- A :Customer: signs in."]);
    expect(tree.definitions).toEqual([item("- :Customer: is a person.")]);
  });

  it("reads a record that is no tree - not JSON, a list, nothing - as no record", () => {
    for (const text of ["not json", "[1, 2]", "null"]) {
      mkdirSync(join(dir, "code"), { recursive: true });
      writeFileSync(join(dir, "code", RECORD_FILE), text);
      expect(readRecord(join(dir, "code")), text).toBeNull();
    }
  });

  it("keeps the tests record in the tests folder as it is given", () => {
    const target = conformanceTarget(codeTree(shop()), null, shop());
    writeTestsRecord(join(dir, "tests"), target);
    expect(readRecord(join(dir, "tests"))).toEqual(target);
  });
});

describe("what is not built yet, for the conformance tests", () => {
  const built = codeTree(shop());

  it("is nothing for functional specs the code record has as the spec has them", () => {
    expect(notBuilt(built, shop(), ["1", "2", "3"])).toEqual([]);
  });

  it("is a functional spec the code record does not have, or has built from other text", () => {
    const now = shop({ "functional specs": [...fs(shop()), spec("- A :Customer: cancels an :Order:.")] });
    fs(now)[1]!.markdown = "- A :Customer: places an :Order: and pays for it.";
    expect(notBuilt(built, now, ["1", "2", "3", "4"])).toEqual(["2", "4"]);
    expect(notBuilt(null, shop(), ["1"])).toEqual(["1"]);
  });

  it("reads the functional specs of what conformance tests are written for by their number, not their place", () => {
    const tested = { "functional specs": [{ markdown: "- The :Price: of an :Order: is shown.", frid: "3" }] } as MarshalledPlainSource;
    expect(notBuilt(built, tested, ["3"])).toEqual([]);
    expect(notBuilt(built, tested, ["1"])).toEqual(["1"]);
  });

  it("ignores space around a functional spec's text", () => {
    const now = shop();
    fs(now)[0]!.markdown = "  - A :Customer: signs up.  ";
    expect(notBuilt(built, now, ["1"])).toEqual([]);
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

  it("grows again a functional spec marked to - not a change to it, whatever else changed in its text - and nothing else", () => {
    const built = codeTree(shop());
    const marked = { ...built, "functional specs": fs(built).map((entry, index) => (index === 1 ? { ...entry, [REGENERATE_AGAIN]: true } : entry)) } as MarshalledPlainSource;
    const cases = casesOf(marked, codeWork(marked, shop()));
    expect(cases).toMatchObject({ add: [], patch: [], delete: [], mechanical: false });
    expect(cases.again.map((entry) => entry.frid)).toEqual(["2"]);
    // Grown again as it reads now: its text changed as well, it is still grown again, not patched.
    const reworded = { ...shop(), "functional specs": fs(shop()).map((entry, index) => (index === 1 ? { ...entry, markdown: `${entry.markdown} Twice.` } : entry)) } as MarshalledPlainSource;
    expect(casesOf(marked, codeWork(marked, reworded)).again.map((entry) => entry.frid)).toEqual(["2"]);
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

  it("gives every functional spec it touches the module whose codebase it is", () => {
    const built = codeTree(shop());
    const now = shop({ "functional specs": [...fs(shop()), spec("- A :Customer: cancels an :Order:.")] });
    expect(casesOf(built, codeWork(built, now), { module: "shop" }).add).toEqual([{ frid: "4", text: "A :Customer: cancels an :Order:.", module: "shop" }]);
  });

  it("numbers a functional spec by its own number when it has one", () => {
    const now = { "functional specs": [{ markdown: "- Say hello.", frid: "7" }] } as MarshalledPlainSource;
    expect(casesOf({}, codeWork(null, now)).add.map((entry) => entry.frid)).toEqual(["7"]);
  });

  it("grows again a functional spec of a module below marked to, by that module and its number", () => {
    const required = (marked: boolean) =>
      ({ "required functional specs": [{ module: "base", frid: "2", markdown: "- A :Customer: signs in.", ...(marked ? { [REGENERATE_AGAIN]: true } : {}) }] }) as MarshalledPlainSource;
    const cases = casesOf(required(true), codeWork(required(true), required(false)), { module: "shop" });
    expect(cases.again).toEqual([{ frid: "2", text: "A :Customer: signs in.", module: "base" }]);
  });

  it("patches a functional spec once when it changed and a concept it uses did too, all of them in order", () => {
    const built = codeTree(shop());
    const now = shop({
      definitions: [item("- :Price: is the net amount of an :Order:."), item("- :Order: is what a :Customer: buys."), item("- :Customer: is a person with a verified account.")],
    });
    fs(now)[2]!.markdown = "- The :Price: of an :Order: is shown, with tax.";
    // 3 changed itself; 1, 2 and 3 use :Customer: - 3 through :Price: and :Order:.
    expect(casesOf(built, codeWork(built, now)).patch.map((entry) => entry.frid)).toEqual(["1", "2", "3"]);
  });

  it("patches a functional spec that uses any one of the concepts redefined, not only one that uses them all", () => {
    const built = codeTree(shop());
    const now = shop({
      definitions: [item("- :Price: is the gross amount of an :Order:."), item("- :Order: is what a :Customer: buys."), item("- :Customer: is a person with a verified account.")],
    });
    // 1 uses :Customer: alone, not :Price:.
    expect(casesOf(built, codeWork(built, now)).patch.map((entry) => entry.frid)).toContain("1");
  });

  it("patches its own functional spec for a concept redefined, though one of a module below with that number is grown again", () => {
    const tree = (marked: boolean, customer: string) =>
      ({
        definitions: [item(`- :Customer: is ${customer}.`)],
        "functional specs": [item("- A :Customer: signs up."), item("- A :Customer: signs in.")],
        "required functional specs": [{ module: "base", frid: "2", markdown: "- Accounts are kept.", ...(marked ? { [REGENERATE_AGAIN]: true } : {}) }],
      }) as MarshalledPlainSource;
    const cases = casesOf(tree(true, "a person"), codeWork(tree(true, "a person"), tree(false, "a person with an account")), { module: "shop" });
    expect(cases.again).toEqual([{ frid: "2", text: "Accounts are kept.", module: "base" }]);
    expect(cases.patch.map((entry) => entry.frid)).toEqual(["1", "2"]);
  });

  it("is not mechanical when it only takes a functional spec out", () => {
    const built = codeTree(shop());
    const now = shop({ "functional specs": fs(shop()).slice(0, 2) });
    expect(casesOf(built, codeWork(built, now)).mechanical).toBe(false);
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

  /** A change, as the stop rule compares them. */
  const made = (section: string, kind: "add" | "remove" | "change", before?: string, after?: string, position = 1) =>
    ({ id: `${section}-${position}`, section, kind, position, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) }) as never;
  const line = (markdown: string, extra: object = {}) => JSON.stringify({ markdown, ...extra });

  it("wants a change only once: a job that makes it twice, where the spec makes it once, is stopped", () => {
    const add = made("functional specs", "add", undefined, line("- Say hello."));
    expect(stillWanted([add, add], [add])).toBe(false);
    expect(stillWanted([add], [add, add])).toBe(true);
  });

  it("tells changes apart by their section, their kind and their text before and after alike", () => {
    const mine = made("definitions", "change", line("- :A: is a letter."), line("- :A: is a capital letter."));
    expect(stillWanted([mine], [mine])).toBe(true);
    expect(stillWanted([mine], [made("implementation reqs", "change", line("- :A: is a letter."), line("- :A: is a capital letter."))])).toBe(false);
    expect(stillWanted([mine], [made("definitions", "add", line("- :A: is a letter."), line("- :A: is a capital letter."))])).toBe(false);
    expect(stillWanted([mine], [made("definitions", "change", line("- :A: is a vowel."), line("- :A: is a capital letter."))])).toBe(false);
    expect(stillWanted([mine], [made("definitions", "change", line("- :A: is a letter."), line("- :A: is a small letter."))])).toBe(false);
  });

  it("says why it is stopped: the items that read otherwise now, by section and place, or the files that hold something else", () => {
    const mine = made("functional specs", "add", undefined, line("- Say hello."), 3);
    const other = made("functional specs", "add", undefined, line("- Say hello loudly."), 3);
    expect(whyNotWanted([mine], [other])).toBe("functional specs 3 reads otherwise now");
    const two = [mine, made("definitions", "change", line("- :A: is a letter."), line("- :A: is a vowel."), 1)];
    expect(whyNotWanted(two, [other])).toBe("functional specs 3, definitions 1 read otherwise now");
    const linked = (digest: string) => line("- :Api: is the API.", { linked_resources: [{ target: "api.yaml", digest }] });
    const resource = made("definitions", "change", line("- :Api: is the API."), linked("aaa"), 2);
    expect(whyNotWanted([resource], [made("definitions", "change", line("- :Api: is the API."), linked("bbb"), 2)])).toBe("api.yaml holds something else now");
    expect(whyNotWanted([mine], [mine])).toBe("the spec it was building from changed");
  });

  it("stops a running job once the spec no longer wants something it makes", () => {
    const built = codeTree(shop({ "functional specs": fs(shop()).slice(0, 2) }));
    const running = codeWork(built, shop());
    const now = shop();
    fs(now)[2]!.markdown = "- The :Price: of an :Order: is shown, with tax.";
    expect(stillWanted(running, codeWork(built, now))).toBe(false);
  });
});
