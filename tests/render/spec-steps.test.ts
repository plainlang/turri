import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyChanges,
  changesBetween,
  describeChange,
  makeStep,
  parseTree,
  sameSpec,
  serializeTree,
  type SpecStep,
} from "../../src/render/spec-steps.ts";
import type { MarshalledPlainSource } from "../../src/plain/spec.ts";

const item = (markdown: string, extra: object = {}) => ({ markdown, ...extra });
const tree = (sections: Record<string, string[]>): MarshalledPlainSource =>
  Object.fromEntries(Object.entries(sections).map(([key, items]) => [key, items.map((text) => item(text))]));
const changesOf = (a: MarshalledPlainSource, b: MarshalledPlainSource) => changesBetween(serializeTree(a), serializeTree(b));

/** Steps from `from` to `to`, cut from the changes in the order and sizes `cut` gives - each step the ones before it and its own, applied to `from`. */
function stepsOf(from: MarshalledPlainSource, to: MarshalledPlainSource, cut: (ids: string[]) => string[][] = (ids) => ids.map((id) => [id])): SpecStep[] {
  const base = serializeTree(from);
  const changes = changesBetween(base, serializeTree(to));
  const byId = new Map(changes.map((change) => [change.id, change]));
  const steps: SpecStep[] = [];
  const sofar = [];
  let previous = base;
  for (const [index, ids] of cut(changes.map((change) => change.id)).entries()) {
    const picked = ids.map((id) => byId.get(id)!);
    sofar.push(...picked);
    const next = applyChanges(base, sofar);
    steps.push(makeStep(`step ${index + 1}`, "", picked, previous, next, "spec.plain"));
    previous = next;
  }
  return steps;
}

describe("a tree written out", () => {
  it("has one line per item, keys sorted, every section named even when empty", () => {
    const text = serializeTree({ "functional specs": [{ markdown: "- One.", acceptance_tests: [{ markdown: "- It works." }] }] });
    expect(text).toBe(
      [
        '["definitions"]',
        '["implementation reqs"]',
        '["test reqs"]',
        '["functional specs"]',
        '{"acceptance_tests":[{"markdown":"- It works."}],"markdown":"- One."}',
        '["required functional specs"]',
        "",
      ].join("\n"),
    );
  });

  it("reads back as the tree it was, and the same tree always writes the same", () => {
    const original = {
      definitions: [item("- :User: is a person.")],
      "functional specs": [item("- One.\n  - With detail.", { linked_resources: [{ text: "api", target: "api.yaml" }] })],
    };
    const reordered = { "functional specs": [{ linked_resources: [{ target: "api.yaml", text: "api" }], markdown: "- One.\n  - With detail." }], definitions: original.definitions };
    expect(parseTree(serializeTree(original))).toEqual(original);
    expect(serializeTree(reordered)).toBe(serializeTree(original));
  });
});

describe("the changes between two trees", () => {
  it("adding a spec at the end changes nothing before it", () => {
    const changes = changesOf(tree({ "functional specs": ["- One.", "- Two."] }), tree({ "functional specs": ["- One.", "- Two.", "- Three."] }));
    expect(changes.map(({ kind, section, position }) => ({ kind, section, position }))).toEqual([
      { kind: "add", section: "functional specs", position: 3 },
    ]);
  });

  it("a spec inserted in the middle is one addition, and the specs after it are untouched", () => {
    const changes = changesOf(
      tree({ "functional specs": ["- One.", "- Two.", "- Three."] }),
      tree({ "functional specs": ["- One.", "- One and a half.", "- Two.", "- Three."] }),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "add", position: 2, after: '{"markdown":"- One and a half."}' });
  });

  it("a spec changed in place is a change, with what it was and what it becomes", () => {
    const changes = changesOf(tree({ "functional specs": ["- One.", "- Two."] }), tree({ "functional specs": ["- One.", "- Two, reworded."] }));
    expect(changes).toEqual([
      expect.objectContaining({ kind: "change", section: "functional specs", position: 2, before: '{"markdown":"- Two."}', after: '{"markdown":"- Two, reworded."}' }),
    ]);
  });

  it("an acceptance test changed is a change to the spec it belongs to, and says so", () => {
    const before = { "functional specs": [item("- One.", { acceptance_tests: [item("- A.")] })] };
    const after = { "functional specs": [item("- One.", { acceptance_tests: [item("- B.")] })] };
    const changes = changesOf(before, after);
    expect(changes.map((change) => change.kind)).toEqual(["change"]);
    expect(describeChange(changes[0]!)).toContain("c1: change the acceptance tests of item 1 of functional specs");
  });

  it("pairs a removed item with an added one only when they are alike - and keeps what is left over in its place", () => {
    const changes = changesOf(
      tree({ definitions: ["- :A: is the first thing.", "- :B: is the second thing.", "- :Z: is last."] }),
      tree({ definitions: ["- :A: is the first thing, renamed.", "- :B: is the second thing, renamed.", "- :C: is new.", "- :Z: is last."] }),
    );
    expect(changes.map((change) => change.kind)).toEqual(["change", "change", "add"]);
    const fewer = changesOf(
      tree({ definitions: ["- :A: is the first thing.", "- :B: is the second thing.", "- :Z: is last."] }),
      tree({ definitions: ["- :A: is the first thing, renamed.", "- :Z: is last."] }),
    );
    expect(fewer.map((change) => change.kind)).toEqual(["change", "remove"]);
  });

  it("a spec taken out and a different one put where it was are two changes, not one", () => {
    const from = serializeTree(tree({ "functional specs": ["- A user can sign up.", "- A user can search for other users by handle.", "- A user can log out."] }));
    const to = serializeTree(tree({ "functional specs": ["- A user can sign up.", "- A user can see their study streak.", "- A user can log out."] }));
    const changes = changesBetween(from, to);
    expect(changes.map(({ kind, position }) => [kind, position])).toEqual([["remove", 2], ["add", 2]]);
    // Either one on its own leaves the rest where it was: the new spec lands in front of log out.
    const [removal, addition] = changes;
    expect(parseTree(applyChanges(from, [addition!]))["functional specs"]).toEqual(
      tree({ x: ["- A user can sign up.", "- A user can search for other users by handle.", "- A user can see their study streak.", "- A user can log out."] }).x,
    );
    expect(parseTree(applyChanges(from, [removal!]))["functional specs"]).toEqual(tree({ x: ["- A user can sign up.", "- A user can log out."] }).x);
  });

  it("an addition between two changed items lands between them", () => {
    const from = serializeTree(tree({ "functional specs": ["- A user can sign up with an email.", "- A user can log in with a password."] }));
    const to = serializeTree(
      tree({ "functional specs": ["- A user can sign up with an email or a phone.", "- An admin can ban a user.", "- A user can log in with a password or a key."] }),
    );
    const changes = changesBetween(from, to);
    expect(changes.map(({ kind, position }) => [kind, position])).toEqual([["change", 1], ["change", 2], ["add", 2]]);
    const addition = changes.find((change) => change.kind === "add")!;
    expect(parseTree(applyChanges(from, [addition]))["functional specs"]).toEqual(
      tree({ x: ["- A user can sign up with an email.", "- An admin can ban a user.", "- A user can log in with a password."] }).x,
    );
    expect(applyChanges(from, changes)).toBe(to);
  });

  it("tells the sections apart", () => {
    const changes = changesOf(
      tree({ definitions: ["- :A: x."], "test reqs": [], "functional specs": ["- One."] }),
      tree({ definitions: ["- :A: x.", "- :B: x."], "test reqs": ["- Tests run fresh."], "functional specs": ["- One, changed."] }),
    );
    expect(changes.map(({ kind, section }) => `${kind} ${section}`)).toEqual(["add definitions", "add test reqs", "change functional specs"]);
  });

  it("applied all together, give the target; any selection applies on its own", () => {
    const from = serializeTree(tree({ definitions: ["- :A: x."], "functional specs": ["- One.", "- Two.", "- Three."] }));
    const to = serializeTree(tree({ definitions: ["- :A: x.", "- :B: y."], "functional specs": ["- Zero.", "- One.", "- Three, changed."] }));
    const changes = changesBetween(from, to);
    expect(applyChanges(from, changes)).toBe(to);
    expect(applyChanges(from, [])).toBe(from);
    // The definition alone: the functional specs as they were.
    const definition = changes.find((change) => change.section === "definitions")!;
    expect(parseTree(applyChanges(from, [definition]))["functional specs"]).toEqual(tree({ x: ["- One.", "- Two.", "- Three."] }).x);
  });
});

/** A small, seeded random generator: the same cases on every run. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

function randomTree(next: () => number, words: string[]): MarshalledPlainSource {
  const pick = () => words[Math.floor(next() * words.length)]!;
  const section = (n: number) => Array.from({ length: Math.floor(next() * n) }, () => item(`- ${pick()} ${pick()}.`));
  return { definitions: section(5), "implementation reqs": section(4), "test reqs": section(3), "functional specs": section(8) };
}

function edited(next: () => number, from: MarshalledPlainSource): MarshalledPlainSource {
  const copy = JSON.parse(JSON.stringify(from)) as Record<string, Array<{ markdown: string }>>;
  for (const key of Object.keys(copy)) {
    const items = copy[key]!;
    for (let edit = Math.floor(next() * 4); edit > 0; edit -= 1) {
      const at = Math.floor(next() * (items.length + 1));
      const roll = next();
      if (roll < 0.4) items.splice(at, 0, item(`- new ${Math.floor(next() * 1000)}.`));
      else if (roll < 0.7 && items.length > 0) items.splice(Math.min(at, items.length - 1), 1);
      else if (items.length > 0) items[Math.min(at, items.length - 1)]!.markdown += " Changed.";
    }
  }
  return copy;
}

describe("any two trees", () => {
  it("are taken one to the other by every step in order - whatever the steps, whatever their order - and each step is a diff git applies", async () => {
    const next = random(7);
    const words = ["user", "order", "export", "login", "streak", "profile", "search"];
    const dir = mkdtempSync(join(tmpdir(), "plainwright-spec-steps-apply-"));
    try {
      for (let run = 0; run < 60; run += 1) {
        const from = randomTree(next, words);
        const to = edited(next, from);
        // Changes shuffled, cut into steps of random sizes.
        const steps = stepsOf(from, to, (ids) => {
          const shuffled = [...ids].sort(() => next() - 0.5);
          const cut: string[][] = [];
          while (shuffled.length > 0) cut.push(shuffled.splice(0, 1 + Math.floor(next() * 3)));
          return cut;
        });
        expect(steps.at(-1)?.after ?? serializeTree(from)).toBe(serializeTree(to));
        let current = serializeTree(from);
        for (const step of steps) {
          expect(step.before).toBe(current);
          writeFileSync(join(dir, "spec.before"), current);
          writeFileSync(join(dir, "step.diff"), step.diff.replaceAll("spec.after", "spec.before"));
          const applied = spawnSync("git", ["apply", "--unidiff-zero", "step.diff"], { cwd: dir, encoding: "utf8" });
          expect(applied.stderr).toBe("");
          expect(readFileSync(join(dir, "spec.before"), "utf8")).toBe(step.after);
          expect(serializeTree(step.tree)).toBe(step.after);
          current = step.after;
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a spec change as ***plain text", () => {
  it("has only the module's own sections, and only those with something in them - never the functional specs it inherits", async () => {
    const { plainText, diffSpecText, serializeTree } = await import("../../src/render/spec-steps.ts");
    const before = serializeTree({
      "functional specs": [{ markdown: "- A :User: can sign up." }],
      "required functional specs": [{ markdown: "- The base can boot." }],
    } as never);
    const after = serializeTree({
      "implementation reqs": [{ markdown: "- Python." }],
      "functional specs": [{ markdown: "- A :User: can sign up." }],
      "required functional specs": [{ markdown: "- The base can boot, fast." }],
    } as never);
    expect(plainText(before)).toBe("***functional specs***\n\n- A :User: can sign up.");
    const diff = diffSpecText(before, after, "app.plain");
    expect(diff).toContain("+***implementation reqs***");
    expect(diff).toContain("+- Python.");
    expect(diff).not.toContain("required functional specs");
    expect(diff).not.toContain("***definitions***");
    expect(diff).not.toContain("The base can boot");
  });
});

describe("a spec change laid out as the module's file", () => {
  const FILE = [
    "---",
    "description: An app.",
    "---",
    "",
    "***definitions***",
    "",
    "- :User: is a person.",
    "",
    "- :Profile: is what others see of a :User:.",
    "",
    "- :Token: is a bearer token.",
    "",
    "***implementation reqs***",
    "",
    "- :Implementation: is in Python.",
    "- :Implementation: uses FastAPI.",
    "",
    "***functional specs***",
    "",
    "- A :User: can sign up.",
    "",
    "- A :User: can log in and gets a :Token:.",
    "",
  ].join("\n");

  it("writes the spec back as the file has it: preamble, the file's order of definitions, its spacing", async () => {
    const { plainFileParser } = await import("../../src/plain/parser.ts");
    const { layoutOf, plainText, serializeTree } = await import("../../src/render/spec-steps.ts");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "plainwright-layout-"));
    writeFileSync(join(dir, "app.plain"), FILE);
    const [, tree] = plainFileParser(join(dir, "app.plain"), [dir]);
    expect(plainText(serializeTree(tree), layoutOf(FILE))).toBe(FILE.trimEnd());
  });

  it("numbers a step's lines as the file's, so its hunks point where the change is in the file", async () => {
    const { layoutOf, diffSpecText, serializeTree } = await import("../../src/render/spec-steps.ts");
    const before = serializeTree({
      definitions: [{ markdown: "- :User: is a person." }, { markdown: "- :Profile: is what others see of a :User:." }],
      "implementation reqs": [{ markdown: "- :Implementation: is in Python." }, { markdown: "- :Implementation: uses FastAPI." }],
      "functional specs": [{ markdown: "- A :User: can sign up." }],
    } as never);
    const after = serializeTree({
      // The parser's order - by what uses what - not the file's.
      definitions: [{ markdown: "- :User: is a person." }, { markdown: "- :Token: is a bearer token." }, { markdown: "- :Profile: is what others see of a :User:." }],
      "implementation reqs": [{ markdown: "- :Implementation: is in Python." }, { markdown: "- :Implementation: uses FastAPI." }],
      "functional specs": [{ markdown: "- A :User: can sign up." }, { markdown: "- A :User: can log in and gets a :Token:." }],
    } as never);
    const diff = diffSpecText(before, after, "app.plain", layoutOf(FILE));
    // :Token: after :Profile:, as in the file, on the file's line 11.
    expect(diff).toContain(" - :Profile: is what others see of a :User:.\n \n+- :Token: is a bearer token.\n");
    // Shaped as a spec diff written in the interview: no index line, nothing after a hunk's range.
    expect(diff).not.toMatch(/^index /m);
    expect(diff).toMatch(/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@$/m);
    expect(diff).not.toMatch(/^@@ .* @@ ./m);
    expect(diff).toContain("+- A :User: can log in and gets a :Token:.");
    // Three lines of context before it: :Token: goes in at the file's line 11.
    expect(diff).toContain("@@ -8,6 +8,8 @@\n");
  });
});

describe("a restructuring of the specs", () => {
  const built = {
    definitions: [item("- :User: is a person."), item("- :Session: is a sign-in.")],
    "implementation reqs": [item("- Python.")],
    "functional specs": [item("- A :User: can register."), item("- A :User: can log in.")],
  } as MarshalledPlainSource;

  it("is the same spec - definitions moved to a common module, and so read in another order", () => {
    const moved = { ...built, definitions: [item("- :Session: is a sign-in."), item("- :User: is a person.")] } as MarshalledPlainSource;
    expect(sameSpec(built, moved)).toBe(true);
  });

  it("is the same spec when functional specs move to the module the code already holds them from", () => {
    const own = { ...built, "functional specs": [item("- A :User: can register."), item("- A :User: can log in.")], "required functional specs": [item("- Say hello.", { module: "base", frid: "1" })] } as MarshalledPlainSource;
    const movedDown = { ...built, "functional specs": [item("- A :User: can log in.")], "required functional specs": [item("- Say hello.", { module: "base", frid: "1" }), item("- A :User: can register.", { module: "base", frid: "2" })] } as MarshalledPlainSource;
    expect(sameSpec(own, movedDown)).toBe(true);
  });

  it("is not the same spec when a module is required that the code was not built on, or anything reads differently", () => {
    const onNew = { ...built, "functional specs": [item("- A :User: can log in.")], "required functional specs": [item("- A :User: can register.", { module: "accounts", frid: "1" })] } as MarshalledPlainSource;
    expect(sameSpec(built, onNew)).toBe(false);
    expect(sameSpec(built, { ...built, definitions: [item("- :User: is a student."), item("- :Session: is a sign-in.")] } as MarshalledPlainSource)).toBe(false);
    // Functional specs in another order are another spec: each is built on the ones before it.
    expect(sameSpec(built, { ...built, "functional specs": [item("- A :User: can log in."), item("- A :User: can register.")] } as MarshalledPlainSource)).toBe(false);
  });
});

describe("a spec diff of a spec in a folder of the project", () => {
  it("is taken by the path it has from where plainwright runs - plain/hubspot.plain - folders and all", async () => {
    const { diffSpecText, serializeTree } = await import("../../src/render/spec-steps.ts");
    const before = serializeTree({ "functional specs": [{ markdown: "- One." }] } as never);
    const after = serializeTree({ "functional specs": [{ markdown: "- One." }, { markdown: "- Two." }] } as never);
    const diff = diffSpecText(before, after, "plain/hubspot.plain");
    expect(diff).toContain("--- a/plain/hubspot.plain\n+++ b/plain/hubspot.plain");
    expect(diff).toContain("+- Two.");
  });
});
