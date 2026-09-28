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

    await expect(call(path)).rejects.toThrow(/Not run: you have made this exact ls call 4 times in a row, with nothing in between/);
    expect(ran).toHaveLength(REPEATS_ALLOWED);
    for (let n = REPEATS_ALLOWED + 1; n < REPEATS_BEFORE_STOP; n += 1) await expect(call(path)).rejects.toThrow(/Not run/);
    expect(aborted()).toBe(0);

    await expect(call(path)).rejects.toThrow(/Stopped: the same ls call 7 times running/);
    expect(aborted()).toBe(1);
  });

  it("is not stopped for calling the same thing again after something else - running the tests after each change", async () => {
    const { ran, call } = setUp();
    for (let n = 0; n < 10; n += 1) {
      await call("tests");
      await call(`change ${n}`);
    }
    expect(ran).toHaveLength(20);
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
