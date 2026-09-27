import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The judge, stubbed to give the verdicts queued in `verdicts`, one per turn. */
const verdicts: Array<Record<string, unknown>> = [];
const prompts: string[] = [];
type StubSession = { tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> };
vi.mock("../../src/pi.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pi.ts")>();
  return {
    ...actual,
    createExecutor: async (opts: { customTools: StubSession["tools"] }) => ({ tools: opts.customTools, dispose() {} }),
    ask: async (session: StubSession, prompt: string) => {
      prompts.push(prompt);
      const next = verdicts.shift();
      if (next !== undefined) await session.tools.find((tool) => tool.name === "submit_verdict")!.execute("id", next);
      return "Done.";
    },
  };
});

const { conflictKey, judgeFailure, specConflictProblem } = await import("../../src/render/conformance-agents.ts");

describe("a spec conflict", () => {
  // Module app requires base: its codebase, and its conformance suite, hold base's functionalities too.
  const app = (frid: string) => ({ module: "app", frid });
  const base = (frid: string) => ({ module: "base", frid });
  const scope = { functionalities: [base("1"), base("2"), app("1"), app("2"), app("3")], tested: app("3") };

  it("names exactly two functionalities, each by its module and an id that exists there", () => {
    expect(specConflictProblem(undefined, scope)).toMatch(/exactly two functionalities/);
    expect(specConflictProblem([app("3")], scope)).toMatch(/exactly two functionalities/);
    expect(specConflictProblem([app("3"), app("3")], scope)).toMatch(/exactly two functionalities/);
    expect(specConflictProblem([app("1"), app("2"), app("3")], scope)).toMatch(/exactly two functionalities/);
    expect(specConflictProblem([app("3"), app("9")], scope)).toMatch(/There is no functionality app 9/);
    // Functionality 1 of app is not functionality 1 of base.
    expect(specConflictProblem([app("3"), { module: "other", frid: "1" }], scope)).toMatch(/There is no functionality other 1/);
    expect(specConflictProblem([app("2"), app("3")], scope)).toBeUndefined();
  });

  it("can cross modules: this module's functionality and one of a module it requires", () => {
    expect(specConflictProblem([base("1"), app("3")], scope)).toBeUndefined();
  });

  it("raised while testing a functionality, must include that one - two earlier ones were for their own run", () => {
    expect(specConflictProblem([app("1"), app("2")], scope)).toMatch(/Only a conflict with functionality app 3/);
    expect(specConflictProblem([base("1"), base("2")], scope)).toMatch(/Only a conflict with functionality app 3/);
    // A spec diff's run tests no one functionality: any two will do.
    expect(specConflictProblem([base("1"), app("2")], { functionalities: scope.functionalities })).toBeUndefined();
  });

  it("is the same conflict however its two functionalities are named", () => {
    expect(conflictKey([app("3"), base("1")])).toBe(conflictKey([base("1"), app("3")]));
    expect(conflictKey([app("10"), app("9")])).toBe("app 9 & app 10");
  });
});

describe("the judge", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plainwright-judge-"));
    verdicts.length = 0;
    prompts.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const judge = (tested?: string) =>
    judgeFailure({
      buildDir: dir,
      conformanceDir: dir,
      spec: { moduleName: "app", text: "***functional specs***\n\n- One.\n\n- Two." },
      run: { command: "run_conformance_tests.sh", exitCode: 1, output: "FAILED", timeoutMs: 1000 },
      invocation: "python3 app.py",
      scope: { functionalities: ["1", "2", "3"].map((frid) => ({ module: "app", frid })), tested: tested && { module: "app", frid: tested } },
      notes: "",
      label: "app 3",
    });

  it("is asked again when its spec conflict cannot be raised, and told why", async () => {
    const at = (id: string) => ({ module: "app", id });
    verdicts.push({ culprit: "spec", functionalities: [at("1"), at("2")], reason: "x" }, { culprit: "spec", functionalities: [at("2"), at("3")], reason: "y" });
    expect(await judge("3")).toEqual({ culprit: "spec", functionalities: [{ module: "app", frid: "2" }, { module: "app", frid: "3" }], reason: "y" });
    expect(prompts[1]).toContain("That spec conflict cannot be raised: Only a conflict with functionality app 3");
  });

  it("falls back to the tests when it gives no conflict that can be raised", async () => {
    const one = { culprit: "spec", functionalities: [{ module: "app", id: "1" }], reason: "x" };
    verdicts.push(one, one, one);
    expect((await judge("3")).culprit).toBe("tests");
  });

  it("is told to prefer the tests when both could be wrong, and how a spec conflict counts", async () => {
    verdicts.push({ culprit: "tests", reason: "z" });
    await judge("3");
    expect(prompts[0]).toContain("When the code and the tests could both be what is wrong, choose tests.");
    expect(prompts[0]).toContain("One of them must be app 3, the one under test");
    expect(prompts[0]).toContain("They can be in different modules");
    expect(prompts[0]).toContain("raised 3 times, for the same two functionalities");
  });
});
