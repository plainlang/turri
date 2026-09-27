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
  build_and_run: long("mvn clean package, then java -jar target/app-exec.jar; it listens on 8080"),
  tests_reach_it: long("the script installs com.codeplain:app:1.0.0; the tests depend on it and start com.codeplain.Application with @SpringBootTest"),
  interfaces: [{ module: "backup", id, how: long("POST /api/backup with a JSON TaskRequest: ctx, auth, storage") }],
  environment: long("a storage service at http://localhost:6000, a fresh bucket per test"),
  plan: [{ module: "backup", id, tests: long("back up one entity and check the storage holds one object") }],
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plainwright-explorer-"));
  turns.length = 0;
  prompts.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const scope = { functionalities: [{ module: "version", frid: "1" }, { module: "backup", frid: "1" }], tested: { module: "backup", frid: "1" } };
const explore = (given = scope) =>
  exploreInvocation({ buildDir: dir, spec: { moduleName: "backup", text: "***functional specs***\n\n- Back it up." }, scope: given, label: "backup 1" });

describe("an exploration", () => {
  it("is whole only with how to build and run it, what it needs, and how the functionality under test is reached and tested", () => {
    const exploration = (id: string) => ({ ...whole(id), buildAndRun: whole(id).build_and_run, testsReachIt: whole(id).tests_reach_it, interfaces: whole(id).interfaces.map((i) => ({ module: i.module, frid: i.id, how: i.how })), plan: whole(id).plan.map((p) => ({ module: p.module, frid: p.id, tests: p.tests })) });
    expect(explorationProblems(exploration("1"), scope, "backup")).toEqual([]);
    const problems = explorationProblems(exploration("2"), scope, "backup");
    expect(problems.join("\n")).toMatch(/interfaces does not say how backup 1 is reached/);
    expect(problems.join("\n")).toMatch(/plan has no tests for backup 1/);
    expect(explorationProblems({ ...exploration("1"), buildAndRun: "java -jar target/app.jar" }, scope, "backup").join("\n")).toMatch(/build_and_run says too little/);
    // A spec change's: some of this module reached and planned - by ids that exist.
    expect(explorationProblems(exploration("1"), { functionalities: scope.functionalities }, "backup")).toEqual([]);
    expect(explorationProblems(exploration("3"), { functionalities: scope.functionalities }, "backup").join("\n")).toMatch(/backup 3 is not a functionality/);
  });
});

describe("the explorer", () => {
  it("is sent back when it hands over one line - as happened - and what it wrote is kept when it never completes it", async () => {
    // A full account written in the reply, then a thin one handed over, again and again.
    const thin = { build_and_run: "java -jar target/d365-version-api-1.0.0-exec.jar", interfaces: [], environment: "", plan: [] };
    turns.push(
      { reply: "### API Endpoints\n* Backup: `POST /api/backup` with a JSON TaskRequest body." },
      { reply: "", submit: thin },
      { reply: "", submit: thin },
      { reply: "", submit: thin },
    );
    const text = await explore();
    // Told first that nothing was handed over, then what the one line lacks.
    expect(prompts[1]).toContain("You have not called submit_exploration.");
    expect(prompts[2]).toContain("What you handed over is not complete");
    expect(prompts[2]).toContain("interfaces does not say how backup 1 is reached");
    expect(prompts[2]).toContain("plan has no tests for backup 1");
    expect(prompts).toHaveLength(4);
    // Nothing it found is lost: the account, and what it wrote as it worked.
    expect(text).toContain("java -jar target/d365-version-api-1.0.0-exec.jar");
    expect(text).toContain("## What the explorer wrote as it worked");
    expect(text).toContain("`POST /api/backup` with a JSON TaskRequest body");
  });

  it("stops asking once the account is whole, and hands over just the account", async () => {
    turns.push({ reply: "Looked around.", submit: whole("1") });
    const text = await explore();
    expect(prompts).toHaveLength(1);
    expect(text).toContain("## How to build and run it\n\nmvn clean package");
    expect(text).toContain("## How each functionality is reached\n\n### backup 1\n\nPOST /api/backup");
    expect(text).toContain("## Plan for the conformance tests\n\n### backup 1\n\nback up one entity");
    expect(text).not.toContain("What the explorer wrote as it worked");
  });

  it("is told the test author sees nothing but what it hands over, and to plan the tests from the spec", async () => {
    turns.push({ reply: "", submit: whole("1") });
    await explore();
    expect(prompts[0]).toContain("for the conformance tests of functionality backup 1");
    expect(prompts[0]).toContain("what you hand over with submit_exploration is all they get");
    expect(prompts[0]).toContain("the plan's expectations come from the");
  });

  it("counts entries it names in its own words for the functionality under test - as happened, 115 times", async () => {
    const own = whole("1");
    turns.push({
      reply: "",
      submit: {
        ...own,
        interfaces: [{ module: "d365_backup_module", id: "backup-api", how: own.interfaces[0]!.how }],
        plan: [{ id: "test-backup-functionality", tests: own.plan[0]!.tests }],
      },
    });
    const text = await explore();
    expect(prompts).toHaveLength(1);
    expect(text).toContain("### backup 1\n\nPOST /api/backup");
    expect(text).not.toContain("What the explorer wrote as it worked");
  });

  it("hands over three times at most, however incomplete - each hand-over ends its turn", async () => {
    const thin = { build_and_run: "java -jar app.jar", interfaces: [], environment: "", plan: [] };
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
    turns.push({ reply: "", submit: { ...own, plan: [{ module: "backup", id: "backup-tests", tests: own.plan[0]!.tests }] } }, { reply: "", submit: own });
    await explore({ functionalities: scope.functionalities });
    expect(prompts[1]).toContain("backup backup-tests is not a functionality: give module and id as the specification numbers them - backup 1.");
  });

  it("is given the conformance testing script, and must say how the tests it runs reach the software", async () => {
    const own = whole("1");
    turns.push({ reply: "", submit: { ...own, tests_reach_it: "" } }, { reply: "", submit: own });
    await exploreInvocation({
      buildDir: dir,
      spec: { moduleName: "backup", text: "***functional specs***\n\n- Back it up." },
      scope,
      testingScripts: [{ path: "test_scripts/run_conformance_tests.sh", runs: "<script> <build> <suite>", content: "mvn clean install -DskipTests\ncd $2 && mvn test" }],
      label: "backup 1",
    });
    expect(prompts[0]).toContain('<script path="test_scripts/run_conformance_tests.sh" run-as="<script> <build> <suite>">\nmvn clean install -DskipTests');
    expect(prompts[0]).toContain("tests_reach_it: how the conformance tests reach it");
    expect(prompts[1]).toContain("tests_reach_it says too little");
  });

  it("asked again, is shown its last account and the failure that keeps coming back", async () => {
    turns.push({ reply: "", submit: whole("1") });
    await exploreInvocation({
      buildDir: dir,
      spec: { moduleName: "backup", text: "- Back it up." },
      scope,
      question: { failure: "java.net.ConnectException: Connection refused", account: "java -jar app.jar" },
      label: "backup 1",
    });
    expect(prompts[0]).toContain("You are asked again.");
    expect(prompts[0]).toContain("<your last account>\njava -jar app.jar\n</your last account>");
    expect(prompts[0]).toContain("java.net.ConnectException: Connection refused");
  });
});
