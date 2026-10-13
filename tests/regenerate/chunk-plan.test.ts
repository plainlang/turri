import { describe, expect, it } from "vitest";
import { groupProblems, planChunks, placeProblems, MAX_LINES_PER_JOB, type ChunkAgents, type GroupAnswer, type PlaceAnswer } from "../../src/regenerate/chunk-plan.ts";
import { checkDraft, netChanges, stepsOf, type PlanInput } from "../../src/regenerate/chunk-plan.ts";

const item = (markdown: string) => ({ markdown });
const tree = (sections: { definitions?: string[]; impl?: string[]; tests?: string[]; specs?: string[] }) =>
  ({
    ...(sections.definitions ? { definitions: sections.definitions.map(item) } : {}),
    ...(sections.impl ? { "implementation reqs": sections.impl.map(item) } : {}),
    ...(sections.tests ? { "test reqs": sections.tests.map(item) } : {}),
    ...(sections.specs ? { "functional specs": sections.specs.map(item) } : {}),
  }) as never;

function input(base: object, current: object): PlanInput {
  return { base: base as never, current: current as never, specFile: "app.plain", specText: "" };
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
function jobs(plan: Awaited<ReturnType<typeof planChunks>>, from: PlanInput) {
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

  it("groups functional specs grown again as it groups new ones - those next to each other in one job - apart from the changes to what is built", async () => {
    const built = tree({ definitions: DEFS, specs: SPECS });
    const marked = { ...built, "functional specs": SPECS.map((markdown, index) => (index === 1 || index === 2 ? { markdown, regenerate_again: true } : { markdown })) } as never;
    const from = input(marked, built);
    const chosen = agents({ groups: [{ specs: [1, 2], title: "Signing in and comments, again" }] });
    const plan = await planChunks({ ...from, moduleName: "app" }, chosen);
    expect(checkDraft(from, plan)).toEqual([]);
    expect(plan).toEqual([expect.objectContaining({ title: "Signing in and comments, again", reason: "functional specs regenerated again" })]);
    // Each by a number to answer with, and which it is: its module, and its id there.
    expect(chosen.shown.specs).toEqual([
      { number: 1, text: SPECS[1], id: "2", module: "app", again: true },
      { number: 2, text: SPECS[2], id: "3", module: "app", again: true },
    ]);
  });

  it("groups the functional specs of a module below grown again here too - next to each other only within their module", async () => {
    const below = (frid: string, markdown: string) => ({ markdown, module: "base", frid });
    const built = { "required functional specs": [below("1", "- Base one."), below("2", "- Base two.")], "functional specs": [{ markdown: "- App one." }] } as never;
    const marked = {
      "required functional specs": [{ ...below("1", "- Base one."), regenerate_again: true }, { ...below("2", "- Base two."), regenerate_again: true }],
      "functional specs": [{ markdown: "- App one.", regenerate_again: true }],
    } as never;
    const from = { ...input(marked, built), moduleName: "app" };
    const chosen = agents({ groups: [{ specs: [1, 2], title: "Base, again" }, { specs: [3], title: "App, again" }] });
    const plan = await planChunks(from, chosen);
    expect(checkDraft(from, plan)).toEqual([]);
    expect(plan.map((job) => job.title)).toEqual(["Base, again", "App, again"]);
    expect(chosen.shown.specs).toEqual([
      { number: 1, text: "- Base one.", id: "1", module: "base", again: true },
      { number: 2, text: "- Base two.", id: "2", module: "base", again: true },
      { number: 3, text: "- App one.", id: "1", module: "app", again: true },
    ]);
    // Base 2 and app 1 are numbered one after the other, but are of two modules: never together.
    expect(groupProblems(chosen.shown.specs as never, { groups: [{ specs: [1], title: "a" }, { specs: [2, 3], title: "b" }] }).join("\n")).toContain("in the same module");
  });

  it("splits a group too big to render well, a functional spec a job", async () => {
    const long = (n: number) => `- A :User: does thing ${n}.\n${Array.from({ length: 70 }, (_, line) => `  - detail ${line}`).join("\n")}`;
    const from = input({}, tree({ definitions: DEFS.slice(0, 2), specs: [long(1), long(2)] }));
    const notes: string[] = [];
    const plan = await planChunks(from, agents({ groups: [{ specs: [1, 2], title: "Both" }] }), notes);
    expect(plan).toHaveLength(2);
    expect(MAX_LINES_PER_JOB).toBe(120);
    expect(notes).toEqual([`"Both" is past ${MAX_LINES_PER_JOB} lines with its definitions and reqs - split into 2 pulses`]);
  });

  it("splits a group too big into as few pulses as fit - its functional specs kept together in runs, not one a pulse", async () => {
    // Four of 40 lines: two fit in 120 with their definitions, three do not.
    const mid = (n: number) => `- A :User: does thing ${n}.\n${Array.from({ length: 39 }, (_, line) => `  - detail ${line}`).join("\n")}`;
    const from = input({}, tree({ definitions: DEFS.slice(0, 2), specs: [mid(1), mid(2), mid(3), mid(4)] }));
    const notes: string[] = [];
    const plan = await planChunks({ ...from, limits: { specs: 4, lines: 120 } }, agents({ groups: [{ specs: [1, 2, 3, 4], title: "All of it" }] }), notes);
    expect(plan.map((job) => job.title)).toEqual(["All of it (1 of 2)", "All of it (2 of 2)"]);
    expect(notes).toEqual(['"All of it" is past 120 lines with its definitions and reqs - split into 2 pulses']);
    expect(checkDraft(from, plan)).toEqual([]);
  });

  it("takes how big a pulse may be from its limits - more functional specs, more lines - the defaults unset", async () => {
    const specs5 = [1, 2, 3, 4, 5].map((number) => ({ number, text: `- spec ${number}` }));
    const five = { groups: [{ specs: [1, 2, 3, 4, 5], title: "one feature" }] };
    expect(groupProblems(specs5, five).join("\n")).toContain("at most 3");
    expect(groupProblems(specs5, five, 5)).toEqual([]);
    // Two of 70 lines: past 120 - but not past 200.
    const long = (n: number) => `- A :User: does thing ${n}.\n${Array.from({ length: 70 }, (_, line) => `  - detail ${line}`).join("\n")}`;
    const from = input({}, tree({ definitions: DEFS.slice(0, 2), specs: [long(1), long(2)] }));
    expect(await planChunks({ ...from, limits: { specs: 3, lines: 200 } }, agents({ groups: [{ specs: [1, 2], title: "Both" }] }))).toHaveLength(1);
  });

  it("asks the grouping agent for fewer, fuller pulses - one feature together, a spec alone only when independent", async () => {
    const { groupPrompt } = await import("../../src/regenerate/chunk-plan.ts");
    const prompt = groupPrompt([{ number: 1, text: "- spec 1" }], undefined, 5);
    expect(prompt).toContain("fewer, fuller jobs: each job costs a\ncoding session, a test run and a review. So group by default");
    expect(prompt).toContain("up to 5");
    expect(prompt).toContain("Keep a functional spec alone only when it is truly\nindependent");
    expect(prompt).not.toContain("better small than wide");
  });

  it("notes what the plan did not do as asked - the wishes an agent did not follow, and an answer that did not hold, with why", async () => {
    const from = input({}, tree({ definitions: DEFS, impl: ["- :Implementation: is Python."], specs: SPECS }));
    const notes: string[] = [];
    await planChunks(
      from,
      agents(
        { groups: [{ specs: [1, 2, 3, 4], title: "Everything" }, { specs: [5], title: "Kudos" }], notes: "Kudos alone: it is past the comments." },
        { implementationReqs: [{ req: 1, to: "all" }], testReqs: [], notes: "Python with the first: it is about everything." },
      ),
      notes,
    );
    expect(notes).toEqual([
      "the grouping: Kudos alone: it is past the comments.",
      'the grouping did not hold ("Everything" has 4 functional specs - at most 3.) - a functional spec a pulse',
      "the placement: Python with the first: it is about everything.",
    ]);
    // A plan that holds, and followed every wish, has nothing to say.
    const quiet: string[] = [];
    await planChunks(from, agents({ groups: SPECS.map((_, index) => ({ specs: [index + 1], title: `${index + 1}` })) }, { implementationReqs: [{ req: 1, to: "all" }], testReqs: [] }), quiet);
    expect(quiet).toEqual([]);
  });

  it("puts what is about everything in a job of its own for the code when the first job is too big - never for the conformance tests, whose every job tests a functional spec", async () => {
    const long = `- A :User: does a big thing.\n${Array.from({ length: 130 }, (_, line) => `  - detail ${line}`).join("\n")}`;
    const current = tree({ definitions: DEFS.slice(0, 2), impl: ["- :Implementation: is Python 3.12.", "- :Implementation: uses FastAPI."], specs: [long, "- A :User: signs in."] });
    const place: PlaceAnswer = { implementationReqs: [{ req: 1, to: "all" }, { req: 2, to: "all" }], testReqs: [] };
    const code = await planChunks(input({}, current), agents(undefined, place));
    expect(code[0]!.title).toBe("What the whole of it is built with");

    const from = { ...input({}, current), track: "conformance" as const };
    const conformance = await planChunks(from, agents(undefined, place));
    expect(checkDraft(from, conformance)).toEqual([]);
    expect(conformance.map((job) => job.title)).not.toContain("What the whole of it is built with");
    const steps = stepsOf(from, conformance);
    for (const job of steps) expect(job.step.changes.some((change) => change.section === "functional specs")).toBe(true);
    // The reqs go with the first functional spec's tests.
    expect(steps[0]!.step.textDiff).toContain("+- :Implementation: is Python 3.12.");
    expect(steps[0]!.step.textDiff).toContain("+- A :User: does a big thing.");
  });

  /** Agents that count how often they are asked: the conformance tests are grouped without them. */
  const counted = () => {
    const asked = { group: 0, place: 0 };
    const given: ChunkAgents = {
      group: async () => ((asked.group += 1), undefined),
      place: async () => ((asked.place += 1), undefined),
    };
    return { asked, given };
  };
  const manyReqs = (count: number, what: string) => Array.from({ length: count }, (_, n) => `- :Implementation: ${what} rule ${n + 1}, which runs on\n  over a second line.`);

  it("never puts two groups the conformance tests were asked for in - conform for 1-3, then for 4-6 - in one job", async () => {
    const six = [...SPECS, "- A :User: reports a :Comment:."];
    const current = { definitions: DEFS.map(item), "functional specs": six.map((markdown, index) => ({ markdown, frid: String(index + 1) })) } as never;
    const from = { ...input({}, current), track: "conformance" as const, groups: [["1", "2", "3"], ["4", "5", "6"]] };
    const plan = await planChunks(from, counted().given);
    expect(checkDraft(from, plan)).toEqual([]);
    expect(plan).toHaveLength(2);
    const [first, second] = stepsOf(from, plan);
    expect(first!.step.textDiff).toContain("+- A :User: writes a :Comment:.");
    expect(first!.step.textDiff).not.toContain("deletes their");
    expect(second!.step.textDiff).toContain("+- A :User: deletes their :Comment:.");
    expect(second!.step.textDiff).toContain("+- A :User: reports a :Comment:.");
    // Without groups: one job, as before.
    expect(await planChunks({ ...from, groups: undefined }, counted().given)).toHaveLength(1);
  });

  it("writes the conformance tests of every functional spec in one job, asking no agent - however many reqs come with them, as the test reqs a module imports once cut five functional specs into five", async () => {
    const current = tree({ definitions: DEFS, impl: manyReqs(30, "build"), tests: manyReqs(30, "test"), specs: SPECS });
    const from = { ...input({}, current), track: "conformance" as const };
    const { asked, given } = counted();
    const plan = await planChunks(from, given);
    expect(asked).toEqual({ group: 0, place: 0 });
    expect(plan).toHaveLength(1);
    expect(checkDraft(from, plan)).toEqual([]);
    const [all] = jobs(plan, from);
    for (const spec of SPECS) expect(all!.diff).toContain(`+${spec}`);
  });

  it("rewrites the tests of functional specs that changed in the same job as it writes those of new ones", async () => {
    const base = tree({ definitions: DEFS, specs: SPECS.slice(0, 3) });
    const current = tree({ definitions: DEFS, specs: ["- A visitor registers a :User: with a :Handle:.", ...SPECS.slice(1)] });
    const from = { ...input(base, current), track: "conformance" as const };
    const plan = await planChunks(from, counted().given);
    expect(plan).toHaveLength(1);
    expect(checkDraft(from, plan)).toEqual([]);
    const [all] = jobs(plan, from);
    expect(all!.diff).toContain("+- A visitor registers a :User: with a :Handle:.");
    expect(all!.diff).toContain("+- A :User: gives :Kudos:.");
  });

  it("writes them a job a functional spec when the person asked for that", async () => {
    const from = { ...input({}, tree({ definitions: DEFS, specs: SPECS })), track: "conformance" as const, separately: true };
    const plan = await planChunks(from, counted().given);
    expect(plan).toHaveLength(SPECS.length);
    expect(checkDraft(from, plan)).toEqual([]);
    expect(jobs(plan, from)[2]!.diff).toContain("+- A :User: writes a :Comment:.");
  });

  it("begins another conformance job only where the next functional spec would take the job's functional specs and the definitions they bring past the guardrail", async () => {
    // Each functional spec 50 lines: two of them and their definitions fit in 120, a third does not.
    const long = SPECS.map((spec) => `${spec}\n${Array.from({ length: 49 }, (_, line) => `  - detail ${line}`).join("\n")}`);
    const from = { ...input({}, tree({ definitions: DEFS, tests: manyReqs(30, "test"), specs: long })), track: "conformance" as const };
    const plan = await planChunks(from, counted().given);
    expect(checkDraft(from, plan)).toEqual([]);
    const cut = jobs(plan, from).map((job) => SPECS.filter((spec) => job.diff.includes(`+${spec}`)).length);
    expect(cut).toEqual([2, 2, 1]);
  });

  /** A functional spec of `lines` lines, using `concept`. */
  const sized = (lines: number, concept: string) => [`- A :User: does ${concept}.`, ...Array.from({ length: lines - 1 }, (_, line) => `  - detail ${line}`)].join("\n");

  it("counts the definitions a conformance job's functional specs bring against the guardrail", async () => {
    // Two functional specs of 59 lines: 118 alone - but each brings a definition of two lines, and 122 is past it.
    const definitions = ["- :A: is a letter.\n  - It is the first.", "- :B: is a letter.\n  - It is the second.", "- :User: is a person."];
    const from = { ...input({}, tree({ definitions, specs: [sized(59, ":A:"), sized(59, ":B:")] })), track: "conformance" as const };
    expect(await planChunks(from, counted().given)).toHaveLength(2);
  });

  it("keeps a conformance job of exactly as many lines as the guardrail allows in one", async () => {
    // 59 + 59 lines of functional specs and two one-line definitions: 120.
    const from = { ...input({}, tree({ definitions: ["- :A: is a letter.", "- :User: is a person."], specs: [sized(59, ":A:"), sized(59, ":A:")] })), track: "conformance" as const };
    expect(await planChunks(from, counted().given)).toHaveLength(1);
  });

  it("leaves conformance work that touches no functional spec as it is - the test reqs changed, say", async () => {
    const base = tree({ tests: ["- :ConformanceTests: use pytest."], specs: ["- A :User: signs in."] });
    const from = { ...input(base, tree({ tests: ["- :ConformanceTests: use pytest, one file each."], specs: ["- A :User: signs in."] })), track: "conformance" as const };
    const plan = await planChunks(from, agents());
    expect(plan).toHaveLength(1);
    expect(checkDraft(from, plan)).toEqual([]);
  });
});

describe("the checks a plan is held to", () => {
  const specs = [1, 2, 3, 4].map((number) => ({ number, text: `- spec ${number}` }));
  it("hold every new functional spec once, in order, next to each other, at most three a job", () => {
    expect(groupProblems(specs, { groups: [{ specs: [1, 2], title: "a" }, { specs: [3, 4], title: "b" }] })).toEqual([]);
    expect(groupProblems(specs, { groups: [{ specs: [1, 2, 3, 4], title: "all" }] }).join("\n")).toContain("at most 3");
    expect(groupProblems(specs, { groups: [{ specs: [2, 1], title: "a" }, { specs: [3, 4], title: "b" }] }).join("\n")).toContain("in the order");
    expect(groupProblems(specs, { groups: [{ specs: [1, 2], title: "a" }] }).join("\n")).toContain("every new functional spec once");
    expect(groupProblems(specs, { groups: [] }).join("\n")).toContain("They hold none.");
  });

  it("take three functional specs in a job, and want every group to have one and a title", () => {
    expect(groupProblems(specs, { groups: [{ specs: [1, 2, 3], title: "a" }, { specs: [4], title: "b" }] })).toEqual([]);
    expect(groupProblems(specs, { groups: [{ specs: [1, 2, 3, 4], title: "a" }, { specs: [], title: "empty" }] }).join("\n")).toContain('"empty" has no functional spec.');
    expect(groupProblems(specs, { groups: [{ specs: [1, 2], title: " " }, { specs: [3, 4], title: "b" }] }).join("\n")).toContain("Every group needs a title.");
  });

  it("never put functional specs of two modules in one job, numbered one after the other as they are", () => {
    const across = [
      { number: 1, text: "- base 1", id: "1", module: "base" },
      { number: 2, text: "- app 2", id: "2", module: "app" },
    ];
    expect(groupProblems(across, { groups: [{ specs: [1, 2], title: "a" }] }).join("\n")).toContain("only functional specs next to each other in the same module");
    // Next to each other in the spec, but not by number in their module.
    const gap = [
      { number: 1, text: "- app 1", id: "1", module: "app" },
      { number: 2, text: "- app 3", id: "3", module: "app" },
    ];
    expect(groupProblems(gap, { groups: [{ specs: [1, 2], title: "a" }] })).toHaveLength(1);
  });

  it("place every req once, where there is such a job", () => {
    const given = { groups: [{ number: 1, title: "a", specs: [], definitions: [] }], built: false, implementationReqs: [{ number: 1, text: "x" }, { number: 2, text: "y" }], testReqs: [] };
    expect(placeProblems(given, { implementationReqs: [{ req: 1, to: 1 }, { req: 2, to: "all" }], testReqs: [] })).toEqual([]);
    expect(placeProblems(given, { implementationReqs: [{ req: 1, to: 1 }], testReqs: [] }).join("\n")).toContain("implementation req 2 is not placed");
    expect(placeProblems(given, { implementationReqs: [{ req: 1, to: 2 }, { req: 2, to: "built" }], testReqs: [] })).toHaveLength(2);
  });

  it("refuse a req there is not, one placed twice, and a place that is no job", () => {
    const given = { groups: [{ number: 1, title: "a", specs: [], definitions: [] }, { number: 2, title: "b", specs: [], definitions: [] }], built: true, implementationReqs: [{ number: 1, text: "x" }], testReqs: [{ number: 1, text: "t" }] };
    const placed = (implementationReqs: PlaceAnswer["implementationReqs"]) => placeProblems(given, { implementationReqs, testReqs: [{ req: 1, to: 2 }] });
    expect(placed([{ req: 1, to: "built" }])).toEqual([]);
    expect(placed([{ req: 1, to: 1 }, { req: 3, to: 1 }]).join("\n")).toContain("There is no implementation req 3.");
    expect(placed([{ req: 1, to: 1 }, { req: 1, to: 2 }]).join("\n")).toContain("implementation req 1 is placed 2 times: once.");
    for (const to of [0, 3, 1.5]) expect(placed([{ req: 1, to }]).join("\n"), String(to)).toContain(`implementation req 1 goes to ${to}, which is no job`);
  });
});

describe("the check on a plan", () => {
  // Two concepts, the second used by the second functional spec only.
  const from = input({}, tree({ definitions: ["- :User: is a person.", "- :Comment: is a text a :User: writes."], specs: ["- A :User: signs in.", "- A :User: writes a :Comment:."] }));
  const ids = netChanges(from.base, from.current).map((change) => change.id);
  const [user, comment, signIn, write] = ids;
  const job = (title: string, changes: string[]) => ({ title, reason: "r", changes });

  it("holds for every change in exactly one job, each leaving a spec that holds together", () => {
    expect(ids).toHaveLength(4);
    expect(checkDraft(from, [job("sign in", [user!, signIn!]), job("comments", [comment!, write!])])).toEqual([]);
  });

  it("refuses a job that makes no change, one that names no change there is, and a change in two jobs", () => {
    expect(checkDraft(from, [job("all", ids), job("empty", [])]).join("\n")).toContain('"empty" makes no change');
    expect(checkDraft(from, [job("all", [...ids, "nope"])]).join("\n")).toContain("names nope, which is not one of the changes");
    expect(checkDraft(from, [job("all", ids), job("again", [write!])]).join("\n")).toContain(`${write} is in more than one job`);
  });

  it("refuses a plan that leaves a change out", () => {
    expect(checkDraft(from, [job("most", [user!, comment!, signIn!])]).join("\n")).toContain(`No job makes ${write}`);
  });

  it("refuses a job that uses what only a later job defines", () => {
    const problems = checkDraft(from, [job("sign in", [signIn!]), job("the rest", [user!, comment!, write!])]);
    expect(problems.join("\n")).toContain('After "sign in" the spec does not hold together');
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
