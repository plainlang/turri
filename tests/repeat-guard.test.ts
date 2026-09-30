import { describe, expect, it } from "vitest";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { guardRepeats, REPEATS_ALLOWED, REPEATS_BEFORE_STOP } from "../src/pi.ts";

/** An ls that counts what it really ran, and a session that says when it was stopped. */
function setUp() {
  const ran: string[] = [];
  const ls = { name: "ls", execute: async (_id: string, params: { path: string }) => (ran.push(params.path), { content: [{ type: "text", text: "package.json" }] }) };
  let aborted = 0;
  const session = { abort: async () => void (aborted += 1) } as unknown as AgentSession;
  const [tool] = guardRepeats([ls as unknown as ToolDefinition], () => session);
  const call = (path: string) => (tool!.execute as unknown as (id: string, params: { path: string }) => Promise<unknown>)("id", { path });
  return { ran, call, aborted: () => aborted };
}

describe("an agent going round in a circle", () => {
  it("has the same call run a few times, then refused, then its turn stopped - as the ls of code/src/main/resources/../../.. was", async () => {
    const { ran, call, aborted } = setUp();
    const path = "plain_modules/app/code/src/main/resources/../../..";
    for (let n = 0; n < REPEATS_ALLOWED; n += 1) await call(path);
    expect(ran).toHaveLength(REPEATS_ALLOWED);

    await expect(call(path)).rejects.toThrow(/Not run: you have made this exact ls call 4 times, with nothing changed since/);
    expect(ran).toHaveLength(REPEATS_ALLOWED);
    for (let n = REPEATS_ALLOWED + 1; n < REPEATS_BEFORE_STOP; n += 1) await expect(call(path)).rejects.toThrow(/Not run/);
    expect(aborted()).toBe(0);

    await expect(call(path)).rejects.toThrow(/Stopped: the same ls call 7 times with nothing changed/);
    expect(aborted()).toBe(1);
  });

  it("knows the same call with its arguments in another order - as a judge ran one find 84 times, path and pattern swapped", async () => {
    const ran: string[] = [];
    const find = { name: "find", execute: async (_id: string, params: { path: string; pattern: string }) => (ran.push(params.path), { content: [{ type: "text", text: "a.json" }] }) };
    let aborted = 0;
    const [tool] = guardRepeats([find as unknown as ToolDefinition], () => ({ abort: async () => void (aborted += 1) }) as unknown as AgentSession);
    const call = (params: Record<string, string>) => (tool!.execute as unknown as (id: string, params: unknown) => Promise<unknown>)("id", params);
    for (let n = 0; n < REPEATS_ALLOWED; n += 1) await call(n % 2 === 0 ? { path: "src/main/resources", pattern: "*.*" } : { pattern: "*.*", path: "src/main/resources" });
    await expect(call({ pattern: "*.*", path: "src/main/resources" })).rejects.toThrow(/Not run: you have made this exact find call 4 times/);
    expect(ran).toHaveLength(REPEATS_ALLOWED);
  });

  it("is not stopped for looking again after something changed - listing the tests after each edit", async () => {
    const ran: string[] = [];
    const tool = (name: string) => ({ name, execute: async (_id: string, params: { path: string }) => (ran.push(`${name} ${params.path}`), { content: [{ type: "text", text: "ok" }] }) });
    const guarded = guardRepeats([tool("ls"), tool("edit")] as unknown as ToolDefinition[], () => undefined);
    const call = (index: number, path: string) => (guarded[index]!.execute as unknown as (id: string, params: { path: string }) => Promise<unknown>)("id", { path });
    for (let n = 0; n < 10; n += 1) {
      await call(0, "tests");
      await call(1, `change ${n}`);
    }
    expect(ran).toHaveLength(20);
  });

  it("refuses a look made again with nothing changed, however many other looks came between - as a judge alternated two greps 288 times", async () => {
    const ran: string[] = [];
    const grep = { name: "grep", execute: async (_id: string, params: { pattern: string }) => (ran.push(params.pattern), { content: [{ type: "text", text: "match" }] }) };
    let aborted = 0;
    const [tool] = guardRepeats([grep as unknown as ToolDefinition], () => ({ abort: async () => void (aborted += 1) }) as unknown as AgentSession);
    const call = (pattern: string) => (tool!.execute as unknown as (id: string, params: { pattern: string }) => Promise<unknown>)("id", { pattern });
    for (let n = 0; n < REPEATS_ALLOWED; n += 1) {
      await call("15701ea2");
      await call("org15701ea2");
    }
    await expect(call("15701ea2")).rejects.toThrow(/made this exact grep call 4 times, with nothing changed since/);
    expect(ran).toHaveLength(REPEATS_ALLOWED * 2);
  });

  it("tells an agent with one thing to decide to decide once its calls are spent, and stops it past twice as many", async () => {
    const read = { name: "read", execute: async () => ({ content: [{ type: "text", text: "x" }] }) };
    const submit = { name: "submit_verdict", execute: async () => ({ content: [{ type: "text", text: "Recorded." }] }) };
    let aborted = 0;
    const [readTool, submitTool] = guardRepeats([read, submit] as unknown as ToolDefinition[], () => ({ abort: async () => void (aborted += 1) }) as unknown as AgentSession, {
      calls: 3,
      finish: ["submit_verdict"],
    });
    const call = (tool: ToolDefinition, path: string) => (tool.execute as unknown as (id: string, params: { path: string }) => Promise<unknown>)("id", { path });
    for (let n = 0; n < 3; n += 1) await call(readTool!, `f${n}`);
    await expect(call(readTool!, "f3")).rejects.toThrow(/you have made 3 tool calls, which is all you have\. Decide now with what you know: call submit_verdict/);
    for (let n = 4; n < 6; n += 1) await call(readTool!, `f${n}`).catch(() => {});
    await expect(call(readTool!, "f6")).rejects.toThrow(/Stopped: 7 tool calls, past the budget of 3/);
    expect(aborted).toBe(1);
    // The decision still goes through past the budget.
    await expect(call(submitTool!, "")).resolves.toBeDefined();
  });

  it("gives an agent kept for its next decision its whole budget again once it hands one over - and lets it read again what it read before", async () => {
    const read = { name: "read", execute: async () => ({ content: [{ type: "text", text: "x" }] }) };
    const submit = { name: "submit_review", execute: async () => ({ content: [{ type: "text", text: "Recorded." }] }) };
    const [readTool, submitTool] = guardRepeats([read, submit] as unknown as ToolDefinition[], () => undefined, { calls: 3, finish: ["submit_review"] });
    const call = (tool: ToolDefinition, path: string) => (tool.execute as unknown as (id: string, params: { path: string }) => Promise<unknown>)("id", { path });
    for (const path of ["a", "a", "a"]) await call(readTool!, path);
    await call(submitTool!, "");
    // The next review: the same file, changed since by the agent it reviews, read three times more - within budget.
    for (const path of ["a", "a", "a"]) await expect(call(readTool!, path)).resolves.toBeDefined();
  });
});

describe("an agent whose calls keep failing", () => {
  /** A session that replays tool results as events, and says when it was stopped. */
  function failingSession(results: Array<{ toolName: string; isError: boolean }>) {
    const listeners: Array<(event: unknown) => void> = [];
    let aborted = 0;
    const session = {
      subscribe(listener: (event: unknown) => void) {
        listeners.push(listener);
        return () => {};
      },
      async prompt() {
        for (const result of results) {
          for (const listener of listeners) {
            listener({ type: "tool_execution_end", toolCallId: "id", toolName: result.toolName, isError: result.isError, result: { content: [{ type: "text", text: "Validation failed for tool" }] } });
          }
        }
      },
      async abort() {
        aborted += 1;
      },
    };
    return { session: session as unknown as AgentSession, aborted: () => aborted };
  }

  it("has its turn stopped when one tool's calls fail again and again - refused arguments never reach any tool's own guard", async () => {
    const { ask, FAILURES_BEFORE_STOP } = await import("../src/pi.ts");
    const { session, aborted } = failingSession(Array.from({ length: 3000 }, () => ({ toolName: "update_notes", isError: true })));
    await ask(session, "Write the conformance tests.");
    expect(FAILURES_BEFORE_STOP).toBe(10);
    expect(aborted()).toBe(1);
  });

  it("is not stopped while calls go through in between, or when the failures are of different tools", async () => {
    const { ask } = await import("../src/pi.ts");
    const results = Array.from({ length: 30 }, (_, n) => [
      { toolName: "bash", isError: true },
      { toolName: n % 2 === 0 ? "edit" : "write", isError: n % 3 === 0 },
    ]).flat();
    const { session, aborted } = failingSession(results);
    await ask(session, "Fix the build.");
    expect(aborted()).toBe(0);
  });
});
