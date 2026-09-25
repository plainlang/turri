import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyChanges,
  changesBetween,
  describeChange,
  onlyAppendsFunctionalSpecs,
  parseTree,
  planPrompt,
  planSpecSteps,
  serializeTree,
  type PlannedStep,
  type PlanRequest,
  type Planner,
} from "../../src/render/spec-steps.ts";
import type { MarshalledPlainSource } from "../../src/plain/spec.ts";

const item = (markdown: string, extra: object = {}) => ({ markdown, ...extra });
const tree = (sections: Record<string, string[]>): MarshalledPlainSource =>
  Object.fromEntries(Object.entries(sections).map(([key, items]) => [key, items.map((text) => item(text))]));
const changesOf = (a: MarshalledPlainSource, b: MarshalledPlainSource) => changesBetween(serializeTree(a), serializeTree(b));

/** A planner that takes every change, one step each, in the order given. */
const oneEach: Planner = async (request) => request.changes.map((change) => ({ title: change.id, reason: "", changes: [change.id] }));

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

describe("a change that only adds functional specs at the end", () => {
  const from = {
    definitions: [item("- :User: is a person.")],
    "implementation reqs": [item("- Python.")],
    "functional specs": [item("- A :User: can sign up.", { acceptance_tests: [item("- It returns 201.")] }), item("- A :User: can log in.")],
  };
  const withSpecs = (...specs: object[]) => ({ ...from, "functional specs": [...from["functional specs"], ...specs] });

  it("is one when every new spec comes after the ones there were, and nothing else changed", () => {
    expect(onlyAppendsFunctionalSpecs(from, withSpecs(item("- A :User: can log out.")))).toBe(true);
    expect(onlyAppendsFunctionalSpecs(from, withSpecs(item("- A :User: can log out."), item("- A :User: can delete their account.")))).toBe(true);
    // From nothing built: every spec is new.
    expect(onlyAppendsFunctionalSpecs({ ...from, "functional specs": [] }, from)).toBe(true);
    expect(onlyAppendsFunctionalSpecs({ definitions: from.definitions, "implementation reqs": from["implementation reqs"] }, from)).toBe(true);
    // The same items, keys in another order, are the same items.
    const reordered = { "functional specs": [{ acceptance_tests: [item("- It returns 201.")], markdown: "- A :User: can sign up." }, item("- A :User: can log in."), item("- A :User: can log out.")], "implementation reqs": from["implementation reqs"], definitions: from.definitions };
    expect(onlyAppendsFunctionalSpecs(from, reordered)).toBe(true);
  });

  it("is not one when nothing was added", () => {
    expect(onlyAppendsFunctionalSpecs(from, from)).toBe(false);
    expect(onlyAppendsFunctionalSpecs(from, { ...from, "functional specs": [from["functional specs"][0]!] })).toBe(false);
  });

  it("is not one when a spec is inserted before the end, or one there was changes, moves or goes", () => {
    const [first, second] = from["functional specs"];
    const extra = item("- A :User: can log out.");
    expect(onlyAppendsFunctionalSpecs(from, { ...from, "functional specs": [first!, extra, second!] })).toBe(false);
    expect(onlyAppendsFunctionalSpecs(from, { ...from, "functional specs": [first!, item("- A :User: can log in, with a key."), extra] })).toBe(false);
    expect(onlyAppendsFunctionalSpecs(from, { ...from, "functional specs": [second!, first!, extra] })).toBe(false);
    expect(onlyAppendsFunctionalSpecs(from, { ...from, "functional specs": [second!, extra, item("- More.")] })).toBe(false);
    // An acceptance test is part of its spec.
    expect(onlyAppendsFunctionalSpecs(from, { ...from, "functional specs": [item("- A :User: can sign up.", { acceptance_tests: [item("- It returns 200.")] }), second!, extra] })).toBe(false);
  });

  it("is not one when anything but the functional specs changed too", () => {
    const extra = item("- A :User: can see their :Streak:.");
    expect(onlyAppendsFunctionalSpecs(from, { ...withSpecs(extra), definitions: [...from.definitions, item("- :Streak: is days in a row.")] })).toBe(false);
    expect(onlyAppendsFunctionalSpecs(from, { ...withSpecs(item("- A :User: can log out.")), "implementation reqs": [item("- Python 3.12.")] })).toBe(false);
    expect(onlyAppendsFunctionalSpecs(from, { ...withSpecs(item("- A :User: can log out.")), "test reqs": [item("- Tests run fresh.")] })).toBe(false);
    expect(onlyAppendsFunctionalSpecs(from, { ...withSpecs(item("- A :User: can log out.")), "required functional specs": [item("- Base one.")] })).toBe(false);
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
        const planner: Planner = async (request) => {
          const ids = request.changes.map((change) => change.id).sort(() => next() - 0.5);
          const steps: PlannedStep[] = [];
          while (ids.length > 0) steps.push({ title: `step ${steps.length + 1}`, reason: "", changes: ids.splice(0, 1 + Math.floor(next() * 3)) });
          return steps;
        };
        const result = await planSpecSteps(from, to, { planner });
        expect(result.steps.at(-1)?.after ?? serializeTree(from)).toBe(serializeTree(to));
        expect(result.rounds.length).toBeLessThanOrEqual(1);
        let current = serializeTree(from);
        for (const step of result.steps) {
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

describe("planning the steps", () => {
  const from = tree({ definitions: ["- :User: is a person."], "functional specs": ["- A :User: can sign up.", "- A :User: can log in."] });
  const to = tree({
    definitions: ["- :User: is a person.", "- :Streak: is days in a row."],
    "test reqs": ["- Conformance tests run against a fresh database."],
    "functional specs": ["- A :User: can sign up.", "- A :User: can log in, with a valid password.", "- A :User: can see their :Streak:."],
  });

  it("asks nothing when there is nothing to do", async () => {
    let asked = 0;
    const result = await planSpecSteps(from, from, { planner: async () => ((asked += 1), []) });
    expect(asked).toBe(0);
    expect(result.steps).toEqual([]);
  });

  it("builds each step's spec and diff from the changes it takes", async () => {
    const planner: Planner = async (request) => {
      const id = (match: (text: string) => boolean) => request.changes.find((change) => match(change.after ?? ""))!.id;
      return [
        { title: "Log in needs a valid password", reason: "a fix", changes: [id((t) => t.includes("valid password"))] },
        { title: "Study streak", reason: "concept with its feature", changes: [id((t) => t.includes(":Streak: is")), id((t) => t.includes("see their"))] },
        { title: "Fresh database", reason: "tests only", changes: [id((t) => t.includes("fresh database"))] },
      ];
    };
    const result = await planSpecSteps(from, to, { planner });
    expect(result.steps.map((step) => [step.title, step.sections])).toEqual([
      ["Log in needs a valid password", ["functional specs"]],
      ["Study streak", ["definitions", "functional specs"]],
      ["Fresh database", ["test reqs"]],
    ]);
    // The first step's spec has the fix and nothing else of the change.
    expect(result.steps[0]!.tree["functional specs"]).toEqual(tree({ x: ["- A :User: can sign up.", "- A :User: can log in, with a valid password."] }).x);
    expect(result.steps[0]!.tree.definitions).toEqual(from.definitions);
    expect(result.steps[0]!.diff).toContain('-{"markdown":"- A :User: can log in."}');
    expect(result.steps[0]!.diff).toContain('+{"markdown":"- A :User: can log in, with a valid password."}');
    expect(result.steps[2]!.after).toBe(serializeTree(to));
    expect(result.rounds).toEqual([{ round: 1, asked: 4, placed: 4, problems: [] }]);
  });

  it("asks again about what the agent left out, from where its steps got to, until it all adds up", async () => {
    const requests: PlanRequest[] = [];
    const planner: Planner = async (request) => {
      requests.push(request);
      const [first, second] = request.changes;
      if (request.round === 1) {
        // One change placed, one used twice, an id that does not exist - and the rest left out.
        return [
          { title: "First", reason: "", changes: [first!.id] },
          { title: "Again", reason: "", changes: [first!.id, "c99"] },
          { title: "Second", reason: "", changes: [second!.id] },
        ];
      }
      return request.changes.map((change) => ({ title: change.id, reason: "", changes: [change.id] }));
    };
    const result = await planSpecSteps(from, to, { planner });

    expect(requests).toHaveLength(2);
    expect(result.rounds[0]).toMatchObject({ round: 1, asked: 4, placed: 2 });
    expect(result.rounds[0]!.problems).toEqual([
      '"Again" names c1, which an earlier step already takes.',
      '"Again" names c99, which is not one of the changes.',
      '"Again" takes no change of its own, so it was left out.',
      "No step takes c3, c4.",
    ]);
    // Round 2 starts from the spec the first round's steps leave, and asks only about what is left.
    expect(requests[1]!.current).toBe(result.steps[1]!.after);
    expect(requests[1]!.changes).toHaveLength(2);
    expect(requests[1]!.planned.map((step) => step.title)).toEqual(["First", "Second"]);
    expect(requests[1]!.feedback).toContain("No step takes c3, c4.");
    expect(result.steps.map((step) => step.title)).toEqual(["First", "Second", "c1", "c2"]);
    expect(result.steps.at(-1)!.after).toBe(serializeTree(to));
  });

  it("puts whatever is still unplaced when the rounds run out into one last step", async () => {
    const result = await planSpecSteps(from, to, { planner: async () => [], maxRounds: 2 });
    expect(result.rounds.map((round) => round.placed)).toEqual([0, 0]);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ fallback: true, after: serializeTree(to) });
    expect(result.steps[0]!.changes).toHaveLength(4);
  });

  it("shows the agent every change by id, and in a later round what is already planned", async () => {
    const changes = changesOf(from, to);
    const first = planPrompt({ current: serializeTree(from), target: serializeTree(to), changes, planned: [], round: 1 });
    expect(first).toContain("c1: add to definitions, as item 2");
    expect(first).toContain("c3: change the text of item 2 of functional specs");
    expect(first).toContain("    - A :User: can log in, with a valid password.");
    expect(first).toContain("***test reqs***");
    const later = planPrompt({ current: serializeTree(from), target: serializeTree(to), changes, planned: [{ title: "First", reason: "" }], round: 2, feedback: "No step takes c3." });
    expect(later).toContain("This is round 2");
    expect(later).toContain("1. First");
    expect(later).toContain("No step takes c3.");
  });

  describe("each step holding together", () => {
    const idOf = (request: PlanRequest, text: string) => request.changes.find((change) => (change.after ?? change.before ?? "").includes(text))!.id;

    it("sends back a step that uses a concept before a step defines it - and keeps the good steps before it", async () => {
      const requests: PlanRequest[] = [];
      const planner: Planner = async (request) => {
        requests.push(request);
        if (request.round === 1) {
          return [
            { title: "Login fix", reason: "", changes: [idOf(request, "valid password")] },
            { title: "Streak endpoint", reason: "", changes: [idOf(request, "see their")] },
            { title: "Streak concept", reason: "", changes: [idOf(request, ":Streak: is")] },
            { title: "Fresh database", reason: "", changes: [idOf(request, "fresh database")] },
          ];
        }
        return [
          { title: "Study streak", reason: "", changes: [idOf(request, ":Streak: is"), idOf(request, "see their")] },
          { title: "Fresh database", reason: "", changes: [idOf(request, "fresh database")] },
        ];
      };
      const result = await planSpecSteps(from, to, { planner });

      expect(result.rounds[0]).toMatchObject({ round: 1, asked: 4, placed: 1 });
      expect(result.rounds[0]!.problems).toEqual([
        expect.stringMatching(/^"Streak endpoint" leaves the specification inconsistent, so it and the 2 steps after it were not taken:\n  - Syntax error: Concept :Streak: is not defined/),
      ]);
      // Round 2 starts where the good step left off, and is told why.
      expect(requests[1]!.current).toBe(result.steps[0]!.after);
      expect(requests[1]!.feedback).toContain("Concept :Streak: is not defined");
      expect(result.steps.map((step) => step.title)).toEqual(["Login fix", "Study streak", "Fresh database"]);
      expect(result.steps.at(-1)!.after).toBe(serializeTree(to));
    });

    it("sends back a step that takes a definition away while a spec still uses it", async () => {
      const withExport = tree({ definitions: ["- :User: is a person.", "- :Export: is a CSV file."], "functional specs": ["- A :User: can sign up.", "- A :User: can download an :Export:."] });
      const without = tree({ definitions: ["- :User: is a person."], "functional specs": ["- A :User: can sign up."] });
      const planner: Planner = async (request) =>
        request.round === 1
          ? [
              { title: "Drop the concept", reason: "", changes: [idOf(request, ":Export: is")] },
              { title: "Drop the feature", reason: "", changes: [idOf(request, "download")] },
            ]
          : [{ title: "Drop export", reason: "", changes: request.changes.map((change) => change.id) }];
      const result = await planSpecSteps(withExport, without, { planner });
      expect(result.rounds[0]!.problems[0]).toMatch(/^"Drop the concept" leaves the specification inconsistent, so it and the 1 step after it were not taken/);
      expect(result.steps.map((step) => step.title)).toEqual(["Drop export"]);
    });

    it("does not blame a step for what is wrong at either end", async () => {
      // A concept the spec already uses without defining, before and after: no step's doing.
      const broken = tree({ definitions: ["- :User: is a person."], "functional specs": ["- A :User: can sign up.", "- A :Ghost: haunts."] });
      const fixed = tree({ definitions: ["- :User: is a person."], "functional specs": ["- A :User: can sign up, with an email.", "- A :Ghost: haunts."] });
      const result = await planSpecSteps(broken, fixed, { planner: oneEach });
      expect(result.rounds[0]!.problems).toEqual([]);
      expect(result.steps).toHaveLength(1);
    });
  });

  it("one step per change is a valid plan", async () => {
    const result = await planSpecSteps(from, to, { planner: oneEach });
    expect(result.steps).toHaveLength(4);
    expect(result.steps.at(-1)!.after).toBe(serializeTree(to));
  });
});
