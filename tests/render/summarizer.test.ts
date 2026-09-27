import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Every session made, with its sandbox; and what the stubbed summarizer answers. */
const made: Array<{ label?: string; system?: string; tools: string[] }> = [];
const prompts: string[] = [];
type StubSession = { tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> };
vi.mock("../../src/pi.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pi.ts")>();
  return {
    ...actual,
    createExecutor: async (opts: { customTools: StubSession["tools"]; label?: string; system?: string; tools: string[] }) => {
      made.push({ label: opts.label, system: opts.system, tools: opts.tools });
      return { tools: opts.customTools, dispose() {} };
    },
    ask: async (session: StubSession, prompt: string) => {
      prompts.push(prompt);
      await session.tools.find((tool) => tool.name === "submit_summary")!.execute("id", {
        summary: "4 tests errored before running: the app's context did not start.",
        failures: [
          {
            test: "ListingControllerConformanceTest.testRootsSuccess",
            error: "No qualifying bean of type 'com.codeplain.dynamics365.executor.TimeoutHandler'",
            context: "Caused by: functionExecutor -> httpClient -> batchClient",
            hint: "FunctionExecutor (executor/FunctionExecutor.java:14) needs a TimeoutHandler bean; there is none.",
          },
        ],
      });
      return "Done.";
    },
  };
});

const { summarizeFailure } = await import("../../src/render/conformance-agents.ts");
const { turnLimited, RUNS_PER_TURN } = await import("../../src/render/conformance.ts");

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plainwright-summarizer-"));
  for (const dir of ["code", "tests", "logs"]) mkdirSync(join(root, dir));
  made.length = 0;
  prompts.length = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the failure summarizer", () => {
  const run = (log?: string) => ({ command: "run_conformance_tests.sh", exitCode: 1, output: "BUILD FAILURE", timeoutMs: 1, ...(log ? { log } : {}) });
  const summarize = (log?: string) =>
    summarizeFailure({ run: run(log), logsDir: join(root, "logs"), buildDir: join(root, "code"), conformanceDir: join(root, "tests"), label: "app 1" });

  it("reads the whole log, the code and the tests, and hands over what failed and why - for whoever fixes it", async () => {
    const summary = (await summarize(join(root, "logs", "run.log")))!;
    expect(summary).toContain("4 tests errored before running");
    expect(summary).toContain("### ListingControllerConformanceTest.testRootsSuccess\nerror: No qualifying bean of type 'com.codeplain.dynamics365.executor.TimeoutHandler'");
    expect(summary).toContain("where to look: FunctionExecutor (executor/FunctionExecutor.java:14) needs a TimeoutHandler bean");
    // Read only: the log, the code and the tests - no shell, nothing written.
    expect(made[0]!.system).toContain(`read \`${join(root, "logs")}\`, \`${join(root, "code")}\`, \`${join(root, "tests")}\`, and write nothing`);
    expect(made[0]!.system).toContain("You have no shell.");
    expect(prompts[0]).toContain(`all of it is in ${join(root, "logs", "run.log")}`);
    // It goes to the tests' author too: the code is pointed at, never pasted.
    expect(prompts[0]).toContain("Never paste");
  });

  it("is not asked for a failure short enough to be shown whole", async () => {
    expect(await summarize()).toBeUndefined();
    expect(made).toHaveLength(0);
  });
});

describe("the conformance suite, run by an agent", () => {
  it("can be run three times a turn: the third ends the turn, a fourth is not run, and a new turn starts the count again", async () => {
    let ran = 0;
    const tool = { name: "run_conformance_tests", execute: async () => (ran += 1, { content: [{ type: "text", text: "exit 1" }] }) };
    const limited = turnLimited(tool as never, RUNS_PER_TURN);
    const call = () => (limited.tool.execute as unknown as () => Promise<{ content: Array<{ text: string }>; terminate?: boolean }>)();
    expect((await call()).terminate).toBeUndefined();
    expect((await call()).terminate).toBeUndefined();
    const third = await call();
    expect(third.terminate).toBe(true);
    expect(third.content.at(-1)!.text).toContain("your turn ends here");
    const fourth = await call();
    expect(fourth.content[0]!.text).toMatch(/^Not run: that is 3 runs this turn/);
    expect(ran).toBe(3);
    limited.newTurn();
    await call();
    expect(ran).toBe(4);
  });
});
