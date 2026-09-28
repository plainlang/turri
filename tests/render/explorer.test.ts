import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The explorer, stubbed: each turn writes a reply and hands over the next exploration queued, if any. */
const turns: Array<{ reply: string; submit?: Record<string, unknown> }> = [];
const prompts: string[] = [];
type StubSession = { tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> };
vi.mock("../../src/pi.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pi.ts")>();
  return {
    ...actual,
    createExecutor: async (opts: { customTools: StubSession["tools"] }) => ({ tools: opts.customTools, dispose() {} }),
    ask: async (session: StubSession, prompt: string) => {
      prompts.push(prompt);
      const turn = turns.shift() ?? { reply: "" };
      if (turn.submit !== undefined) await session.tools.find((tool) => tool.name === "submit_exploration")!.execute("id", turn.submit);
      return turn.reply;
    },
  };
});

const { exploreInvocation, explorationProblems } = await import("../../src/render/conformance-agents.ts");

const long = (what: string) => `${what}, said in full so it is enough for someone who never sees the code.`;
const whole = (id: string) => ({
  build_and_run: long("npm ci && npm run build, then node dist/server.js; it listens on 8080"),
  tests_reach_it: long("the script builds orders-app 1.0.0 from package.json; the tests import it and start dist/server.js themselves"),
  interfaces: [{ module: "orders", id, how: long("POST /api/orders with a JSON order: items, customer") }],
  environment: long("a storage service at http://localhost:6000, a fresh bucket per test"),
  plan: [{ module: "orders", id, tests: long("place one order and check it is listed once") }],
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plainwright-explorer-"));
  turns.length = 0;
  prompts.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const scope = { functionalities: [{ module: "version", frid: "1" }, { module: "orders", frid: "1" }], tested: { module: "orders", frid: "1" } };
const explore = (given = scope) =>
  exploreInvocation({ buildDir: dir, spec: { moduleName: "orders", text: "***functional specs***\n\n- Take an order." }, scope: given, label: "orders 1" });

describe("an exploration", () => {
  it("is whole only with how to build and run it, what it needs, and how the functionality under test is reached and tested", () => {
    const exploration = (id: string) => ({ ...whole(id), buildAndRun: whole(id).build_and_run, testsReachIt: whole(id).tests_reach_it, interfaces: whole(id).interfaces.map((i) => ({ module: i.module, frid: i.id, how: i.how })), plan: whole(id).plan.map((p) => ({ module: p.module, frid: p.id, tests: p.tests })) });
    expect(explorationProblems(exploration("1"), scope, "orders")).toEqual([]);
    const problems = explorationProblems(exploration("2"), scope, "orders");
    expect(problems.join("\n")).toMatch(/interfaces does not say how orders 1 is reached/);
    expect(problems.join("\n")).toMatch(/plan has no tests for orders 1/);
    expect(explorationProblems({ ...exploration("1"), buildAndRun: "node dist/server.js" }, scope, "orders").join("\n")).toMatch(/build_and_run says too little/);
    // A spec change's: some of this module reached and planned - by ids that exist.
    expect(explorationProblems(exploration("1"), { functionalities: scope.functionalities }, "orders")).toEqual([]);
    expect(explorationProblems(exploration("3"), { functionalities: scope.functionalities }, "orders").join("\n")).toMatch(/orders 3 is not a functionality/);
  });

  it("plans every acceptance test, by number - a plan that leaves one out is sent back", () => {
    const withPlan = (tests: string) => ({ ...whole("1"), buildAndRun: whole("1").build_and_run, testsReachIt: whole("1").tests_reach_it, interfaces: whole("1").interfaces.map((i) => ({ module: i.module, frid: i.id, how: i.how })), plan: [{ module: "orders", frid: "1", tests }] });
    const acceptance = [{ module: "orders", frid: "1", count: 2 }];
    const problems = explorationProblems(withPlan(long("place one order and check it is listed once")), scope, "orders", acceptance);
    expect(problems.join("\n")).toMatch(/plan does not carry out acceptance test 1, acceptance test 2 of orders 1: name each "acceptance test N"/);
    expect(explorationProblems(withPlan(long("Acceptance test 1: POST /api/orders, assert one object. Acceptance test 2: place two, cancel one, list again.")), scope, "orders", acceptance)).toEqual([]);
  });
});

describe("the explorer", () => {
  it("is sent back when it hands over one line - as happened - and what it wrote is kept when it never completes it", async () => {
    // A full account written in the reply, then a thin one handed over, again and again.
    const thin = { build_and_run: "node dist/orders-app-1.0.0.js", interfaces: [], environment: "", plan: [] };
    turns.push(
      { reply: "### API Endpoints\n* Orders: `POST /api/orders` with a JSON order body." },
      { reply: "", submit: thin },
      { reply: "", submit: thin },
      { reply: "", submit: thin },
    );
    const text = await explore();
    // Told first that nothing was handed over, then what the one line lacks.
    expect(prompts[1]).toContain("You have not called submit_exploration.");
    expect(prompts[2]).toContain("What you handed over is not complete");
    expect(prompts[2]).toContain("interfaces does not say how orders 1 is reached");
    expect(prompts[2]).toContain("plan has no tests for orders 1");
    expect(prompts).toHaveLength(4);
    // Nothing it found is lost: the account, and what it wrote as it worked.
    expect(text).toContain("node dist/orders-app-1.0.0.js");
    expect(text).toContain("## What the explorer wrote as it worked");
    expect(text).toContain("`POST /api/orders` with a JSON order body");
  });

  it("stops asking once the account is whole, and hands over just the account", async () => {
    turns.push({ reply: "Looked around.", submit: whole("1") });
    const text = await explore();
    expect(prompts).toHaveLength(1);
    expect(text).toContain("## How to build and run it\n\nnpm ci && npm run build");
    expect(text).toContain("## How each functionality is reached\n\n### orders 1\n\nPOST /api/orders");
    expect(text).toContain("## Plan for the conformance tests\n\n### orders 1\n\nplace one order");
    expect(text).not.toContain("What the explorer wrote as it worked");
  });

  it("is told the test author does not see its replies, only what it hands over, and to plan the tests from the spec", async () => {
    turns.push({ reply: "", submit: whole("1") });
    await explore();
    expect(prompts[0]).toContain("for the conformance tests of functionality orders 1");
    expect(prompts[0]).toContain("what you hand over with\nsubmit_exploration is what they start from");
    expect(prompts[0]).toContain("the plan's expectations come from the");
  });

  it("counts entries it names in its own words for the functionality under test - as happened, 115 times", async () => {
    const own = whole("1");
    turns.push({
      reply: "",
      submit: {
        ...own,
        interfaces: [{ module: "orders_module", id: "orders-api", how: own.interfaces[0]!.how }],
        plan: [{ id: "test-orders-functionality", tests: own.plan[0]!.tests }],
      },
    });
    const text = await explore();
    expect(prompts).toHaveLength(1);
    expect(text).toContain("### orders 1\n\nPOST /api/orders");
    expect(text).not.toContain("What the explorer wrote as it worked");
  });

  it("hands over three times at most, however incomplete - each hand-over ends its turn", async () => {
    const thin = { build_and_run: "node server.js", interfaces: [], environment: "", plan: [] };
    for (let n = 0; n < 6; n += 1) turns.push({ reply: `turn ${n}`, submit: thin });
    await explore();
    expect(prompts).toHaveLength(3);
  });

  it("is sent back when it pastes the code instead of the interface", async () => {
    const own = whole("1");
    turns.push({ reply: "", submit: { ...own, other: "x".repeat(13_000) } }, { reply: "", submit: own });
    await explore();
    expect(prompts[1]).toMatch(/characters - keep it under 12000\. Hand over the interface, not the code/);
  });

  it("in a spec diff's run, is told which ids exist when it makes one up", async () => {
    const own = whole("1");
    turns.push({ reply: "", submit: { ...own, plan: [{ module: "orders", id: "orders-tests", tests: own.plan[0]!.tests }] } }, { reply: "", submit: own });
    await explore({ functionalities: scope.functionalities });
    expect(prompts[1]).toContain("orders orders-tests is not a functionality: give module and id as the specification numbers them - orders 1.");
  });

  it("is given the conformance testing script, and must say how the tests it runs reach the software", async () => {
    const own = whole("1");
    turns.push({ reply: "", submit: { ...own, tests_reach_it: "" } }, { reply: "", submit: own });
    await exploreInvocation({
      buildDir: dir,
      spec: { moduleName: "orders", text: "***functional specs***\n\n- Take an order." },
      scope,
      testingScripts: [{ path: "test_scripts/run_conformance_tests.sh", runs: "<script> <build> <suite>", content: "npm ci && npm run build\ncd $2 && npm test" }],
      label: "orders 1",
    });
    expect(prompts[0]).toContain('<script path="test_scripts/run_conformance_tests.sh" run-as="<script> <build> <suite>">\nnpm ci && npm run build');
    expect(prompts[0]).toContain("tests_reach_it: how the conformance tests reach it");
    expect(prompts[1]).toContain("tests_reach_it says too little");
  });

  it("asked again, is shown its last account and the failure that keeps coming back", async () => {
    turns.push({ reply: "", submit: whole("1") });
    await exploreInvocation({
      buildDir: dir,
      spec: { moduleName: "orders", text: "- Take an order." },
      scope,
      question: { failure: "Error: connect ECONNREFUSED 127.0.0.1:8080", account: "node server.js" },
      label: "orders 1",
    });
    expect(prompts[0]).toContain("You are asked again.");
    expect(prompts[0]).toContain("<your last account>\nnode server.js\n</your last account>");
    expect(prompts[0]).toContain("Error: connect ECONNREFUSED 127.0.0.1:8080");
  });
});
