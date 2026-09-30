import { describe, expect, it } from "vitest";
import { groupProblems, planChunks, placeProblems, MAX_LINES_PER_JOB, type ChunkAgents, type GroupAnswer, type PlaceAnswer } from "../../src/render/chunk-plan.ts";
import { checkDraft, netChanges, stepsOf, type MasterInput } from "../../src/render/queue-master.ts";

const item = (markdown: string) => ({ markdown });
const tree = (sections: { definitions?: string[]; impl?: string[]; tests?: string[]; specs?: string[] }) =>
  ({
    ...(sections.definitions ? { definitions: sections.definitions.map(item) } : {}),
    ...(sections.impl ? { "implementation reqs": sections.impl.map(item) } : {}),
    ...(sections.tests ? { "test reqs": sections.tests.map(item) } : {}),
    ...(sections.specs ? { "functional specs": sections.specs.map(item) } : {}),
  }) as never;

function input(base: object, current: object): MasterInput {
  return { base: base as never, previous: base as never, current: current as never, queued: [], specFile: "app.plain", specText: "", conformanceAvailable: true };
}

/** Stand-in agents: they answer as told, and record what they were shown. */
function agents(group?: GroupAnswer, place?: PlaceAnswer): ChunkAgents & { shown: { specs?: unknown; place?: unknown } } {
  const shown: { specs?: unknown; place?: unknown } = {};
  return {
    shown,
    group: async (specs) => ((shown.specs = specs), group),
    place: async (given) => ((shown.place = given), place),
  };
}

/** What each job of a plan adds, as text - its changes, read back from the steps. */
function jobs(plan: Awaited<ReturnType<typeof planChunks>>, from: MasterInput) {
  return stepsOf(from, plan).map((job) => ({ title: job.title, diff: job.step.textDiff }));
}

const DEFS = [
  "- :Handle: is a public user name.",
  "- :User: is a student, with a :Handle:.",
  "- :Comment: is a text a :User: writes.",
  "- :Kudos: is a like a :User: gives.",
];
const SPECS = ["- A visitor registers a :User:.", "- A :User: signs in.", "- A :User: writes a :Comment:.", "- A :User: deletes their :Comment:.", "- A :User: gives :Kudos:."];

describe("cutting the queue's work into jobs", () => {
  it("groups the functional specs the agent groups, each with the definitions it uses - through the definitions they use - once", async () => {
    const from = input({}, tree({ definitions: DEFS, impl: ["- :Implementation: is Python."], specs: SPECS }));
    const chosen = agents(
      { groups: [{ specs: [1, 2], title: "Accounts" }, { specs: [3, 4], title: "Comments" }, { specs: [5], title: "Kudos" }] },
      { implementationReqs: [{ req: 1, to: "all" }], testReqs: [] },
    );
    const plan = await planChunks(from, chosen);
    expect(checkDraft(from, plan)).toEqual([]);
    const [accounts, comments, kudos] = jobs(plan, from);
    expect(plan.map((job) => job.title)).toEqual(["Accounts", "Comments", "Kudos"]);
    // Accounts brings User and, through it, Handle - and the req that is about everything.
    expect(accounts!.diff).toContain("+- :User: is a student");
    expect(accounts!.diff).toContain("+- :Handle: is a public user name.");
    expect(accounts!.diff).toContain("+- :Implementation: is Python.");
    expect(accounts!.diff).not.toContain(":Comment: is");
    // Comments has User built already: only Comment comes with it.
    expect(comments!.diff).toContain("+- :Comment: is a text");
    expect(comments!.diff).not.toContain("+- :User: is");
    expect(kudos!.diff).toContain("+- :Kudos: is a like");
    expect(kudos!.diff).not.toContain("+- :Comment: is");
  });

  it("places each req where the agent says - with a group, with the first when it is about everything - and test reqs for that group's conformance", async () => {
    const from = input({}, tree({ definitions: DEFS, impl: ["- :Implementation: is Python.", "- Passwords are hashed with bcrypt.", "- Comments are stored in SQLite."], tests: ["- Comments are tested through the API."], specs: SPECS }));
    const chosen = agents(
      { groups: [{ specs: [1, 2], title: "Accounts" }, { specs: [3, 4], title: "Comments" }, { specs: [5], title: "Kudos" }] },
      { implementationReqs: [{ req: 1, to: "all" }, { req: 2, to: 1 }, { req: 3, to: 2 }], testReqs: [{ req: 1, to: 2 }] },
    );
    const plan = await planChunks(from, chosen);
    const [accounts, comments] = jobs(plan, from);
    expect(accounts!.diff).toContain("bcrypt");
    expect(accounts!.diff).not.toContain("SQLite");
    expect(comments!.diff).toContain("SQLite");
    expect(comments!.diff).toContain("tested through the API");
    // The placement agent was shown each group with its specs and definitions.
    expect((chosen.shown.place as { groups: Array<{ title: string; definitions: string[] }> }).groups[1]).toMatchObject({ title: "Comments", definitions: ["- :Comment: is a text a :User: writes."] });
  });

  it("falls back to a functional spec a job - every req with the first - when an answer does not hold", async () => {
    const from = input({}, tree({ definitions: DEFS, impl: ["- :Implementation: is Python."], specs: SPECS }));
    // 1 and 3 together skip 2: not next to each other.
    const plan = await planChunks(from, agents({ groups: [{ specs: [1, 3], title: "Bad" }, { specs: [2], title: "x" }, { specs: [4, 5], title: "y" }] }));
    expect(plan).toHaveLength(5);
    expect(checkDraft(from, plan)).toEqual([]);
    expect(jobs(plan, from)[0]!.diff).toContain("+- :Implementation: is Python.");
    // And with no agent at all, the same.
    expect(await planChunks(from)).toHaveLength(5);
  });

  it("puts what is built already, changed, first - then the new work", async () => {
    const base = tree({ definitions: DEFS.slice(0, 2), impl: ["- :Implementation: is Python."], specs: SPECS.slice(0, 2) });
    const current = tree({ definitions: DEFS.slice(0, 3), impl: ["- :Implementation: is Python 3.12."], specs: [SPECS[0]!, "- A :User: signs in with their :Handle:.", SPECS[2]!] });
    const from = input(base, current);
    const plan = await planChunks(from);
    const [built, comments] = jobs(plan, from);
    expect(plan[0]!.title).toBe("Changes to what is built");
    expect(built!.diff).toContain("Python 3.12");
    expect(built!.diff).toContain("signs in with their :Handle:");
    expect(built!.diff).not.toContain("+- :Comment:");
    expect(comments!.diff).toContain("+- :Comment: is a text");
  });

  it("splits a group too big to render well, a functional spec a job", async () => {
    const long = (n: number) => `- A :User: does thing ${n}.\n${Array.from({ length: 70 }, (_, line) => `  - detail ${line}`).join("\n")}`;
    const from = input({}, tree({ definitions: DEFS.slice(0, 2), specs: [long(1), long(2)] }));
    const plan = await planChunks(from, agents({ groups: [{ specs: [1, 2], title: "Both" }] }));
    expect(plan).toHaveLength(2);
    expect(MAX_LINES_PER_JOB).toBe(120);
  });

  it("keeps a queued job's id on the job that carries its own change", async () => {
    const base = tree({ specs: [SPECS[0]!] });
    const one = tree({ specs: SPECS.slice(0, 2) });
    const two = tree({ specs: SPECS.slice(0, 3) });
    const from: MasterInput = { ...input(base, two), queued: [{ jobId: "aaaa1111", title: "sign in", tree: one, textDiff: "" }, { jobId: "bbbb2222", title: "comments", tree: two, textDiff: "" }] };
    const plan = await planChunks({ ...from, current: tree({ definitions: DEFS.slice(0, 3), specs: SPECS.slice(0, 3) }) as never });
    expect(plan.map((job) => job.jobId)).toEqual(["aaaa1111", "bbbb2222"]);
  });
});

describe("the checks a plan is held to", () => {
  const specs = [1, 2, 3, 4].map((number) => ({ number, text: `- spec ${number}` }));
  it("hold every new functional spec once, in order, next to each other, at most three a job", () => {
    expect(groupProblems(specs, { groups: [{ specs: [1, 2], title: "a" }, { specs: [3, 4], title: "b" }] })).toEqual([]);
    expect(groupProblems(specs, { groups: [{ specs: [1, 2, 3, 4], title: "all" }] }).join("\n")).toContain("at most 3");
    expect(groupProblems(specs, { groups: [{ specs: [2, 1], title: "a" }, { specs: [3, 4], title: "b" }] }).join("\n")).toContain("in the order");
    expect(groupProblems(specs, { groups: [{ specs: [1, 2], title: "a" }] }).join("\n")).toContain("every new functional spec once");
  });

  it("place every req once, where there is such a job", () => {
    const given = { groups: [{ number: 1, title: "a", specs: [], definitions: [] }], built: false, implementationReqs: [{ number: 1, text: "x" }, { number: 2, text: "y" }], testReqs: [] };
    expect(placeProblems(given, { implementationReqs: [{ req: 1, to: 1 }, { req: 2, to: "all" }], testReqs: [] })).toEqual([]);
    expect(placeProblems(given, { implementationReqs: [{ req: 1, to: 1 }], testReqs: [] }).join("\n")).toContain("implementation req 2 is not placed");
    expect(placeProblems(given, { implementationReqs: [{ req: 1, to: 2 }, { req: 2, to: "built" }], testReqs: [] })).toHaveLength(2);
  });
});

// The net changes a plan is made of are the queue master's: every one is in exactly one job.
describe("a plan and the work", () => {
  it("covers every change from what is built to the spec now", async () => {
    const from = input({}, tree({ definitions: DEFS, impl: ["- :Implementation: is Python."], specs: SPECS }));
    const plan = await planChunks(from);
    expect(plan.flatMap((job) => job.changes).sort()).toEqual(netChanges(from.base, from.current).map((change) => change.id).sort());
  });
});

describe("what a module built on another starts from", () => {
  it("is that module's functional specs, inherited, and every definition and req of its own spec that code implements word for word", async () => {
    const { inheritedTree } = await import("../../src/render/state.ts");
    const source = tree({ definitions: ["- :User: is a person."], impl: ["- :Implementation: is Python.", "- Uses SQLite."], specs: ["- A :User: registers."] });
    const spec = tree({ definitions: ["- :User: is a person.", "- :Page: is a screen."], impl: ["- :Implementation: is Python.", "- Uses Flask."], specs: ["- Show a :Page:."] });
    expect(inheritedTree(source, "base", spec)).toEqual({
      definitions: [{ markdown: "- :User: is a person." }],
      "implementation reqs": [{ markdown: "- :Implementation: is Python." }],
      "required functional specs": [{ markdown: "- A :User: registers.", module: "base", frid: "1" }],
    });
  });
});
