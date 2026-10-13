import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { withActivity } from "../../src/regenerate/activity.ts";
import { debugDir, debugDirFor, startDebugLog } from "../../src/regenerate/debug-log.ts";
import { ask, ProviderError } from "../../src/pi.ts";

let root: string;
let codeDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "turri-debug-"));
  codeDir = join(root, "plain_modules", "app", "code");
  mkdirSync(codeDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A pi session that plays back `events` as its turn - no model, no network. */
function fakeSession(events: AgentSessionEvent[] = []) {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const session = {
    model: { provider: "anthropic", id: "claude-sonnet-5" },
    thinkingLevel: "medium",
    systemPrompt: "You are the coding agent.",
    sessionFile: "/sessions/one.jsonl",
    subscribe(listener: (event: AgentSessionEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: AgentSessionEvent) {
      for (const listener of [...listeners]) listener(event);
    },
    async prompt() {
      for (const event of events) session.emit(event);
    },
    abort() {},
  };
  return session;
}

const update = (assistantMessageEvent: Record<string, unknown>) =>
  ({ type: "message_update", message: {}, assistantMessageEvent }) as unknown as AgentSessionEvent;
const event = (value: Record<string, unknown>) => value as unknown as AgentSessionEvent;

const logFiles = () => readdirSync(debugDir(root)).filter((name) => name.endsWith(".log"));
const onlyLog = () => {
  const files = logFiles();
  expect(files).toHaveLength(1);
  return readFileSync(join(debugDir(root), files[0]!), "utf8");
};

describe("an agent's debug log", () => {
  it("is in the project's .turri/debug, outside plain_modules, which ignores itself in git", () => {
    const log = startDebugLog(fakeSession(), { cwd: codeDir, label: "app 1 coding agent" })!;
    expect(log.file.startsWith(join(root, ".turri", "debug"))).toBe(true);
    expect(log.file).toMatch(/\d{4}-\d\d-\d\dT[\d-]+Z-app-1-coding-agent\.log$/);
    expect(readFileSync(join(root, ".turri", ".gitignore"), "utf8")).toBe("*\n!skills/\n!skills/**\n");
  });

  it("gives two agents started at once a file each", () => {
    const one = startDebugLog(fakeSession(), { cwd: codeDir, label: "app 1 coding agent" })!;
    const two = startDebugLog(fakeSession(), { cwd: codeDir, label: "app 1 coding agent" })!;
    expect(one.file).not.toBe(two.file);
    expect(logFiles()).toHaveLength(2);
  });

  it("starts with what the agent is: its job, model, folder, saved session, tools and system prompt", async () => {
    const sink = { stage() {}, activity: (line: string) => activity.push(line), now() {}, usage() {}, transcript() {} };
    const activity: string[] = [];
    await withActivity({ ...sink, job: { id: "3f2a1b9c", kind: "render", summary: "app.plain functionality 1" } }, async () => {
      startDebugLog(fakeSession(), { cwd: codeDir, label: "app 1 coding agent", tools: ["read", "write", "run_unit_tests"] });
    });
    const text = onlyLog();
    expect(text).toContain("turri debug log · app 1 coding agent");
    expect(text).toContain("job       3f2a1b9c · render · app.plain functionality 1");
    expect(text).toContain("model     anthropic/claude-sonnet-5 · thinking medium");
    expect(text).toContain(`cwd       ${codeDir}`);
    expect(text).toContain("session   /sessions/one.jsonl");
    expect(text).toContain("tools     read, write, run_unit_tests");
    expect(text).toContain("system prompt");
    expect(text).toContain("You are the coding agent.");
    // The job says where its agent's log is.
    // Where it is goes in the trace, not the activity.
    expect(activity.some((line) => line.startsWith("debug log:"))).toBe(false);
  });

  it("streams the whole turn: the prompt, the reply and thinking, every tool call and its whole result, the usage", async () => {
    const longOutput = `${"x".repeat(5000)}\nFAILED test_app.py::test_hello`;
    const session = fakeSession([
      update({ type: "thinking_start" }),
      update({ type: "thinking_delta", delta: "The spec wants hello." }),
      update({ type: "thinking_end" }),
      update({ type: "text_start" }),
      update({ type: "text_delta", delta: "Writing " }),
      update({ type: "text_delta", delta: "app.py." }),
      update({ type: "text_end" }),
      event({ type: "tool_execution_start", toolCallId: "t1", toolName: "write", args: { path: "app.py", content: "print('hello')\nprint('bye')\n" } }),
      event({ type: "tool_execution_end", toolCallId: "t1", toolName: "write", isError: false, result: { content: [{ type: "text", text: "Wrote app.py" }] } }),
      event({ type: "tool_execution_start", toolCallId: "t2", toolName: "run_unit_tests", args: {} }),
      event({ type: "tool_execution_end", toolCallId: "t2", toolName: "run_unit_tests", isError: true, result: { content: [{ type: "text", text: longOutput }] } }),
      event({
        type: "message_end",
        message: { role: "assistant", stopReason: "toolUse", usage: { input: 1200, output: 340, cacheRead: 5000, cacheWrite: 0, cost: { total: 0.0123 } } },
      }),
      event({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "overloaded" }),
      event({ type: "auto_retry_end", success: true, attempt: 1 }),
    ]);
    startDebugLog(session, { cwd: codeDir, label: "app 1 coding agent" });

    await ask(session as unknown as AgentSession, "Implement functionality 1.");

    const text = onlyLog();
    expect(text).toMatch(/=+ prompt 1 · \[\d\d:\d\d:\d\d\.\d{3}\] =+\nImplement functionality 1\.\n/);
    expect(text).toMatch(/\] thinking\nThe spec wants hello\.\n/);
    expect(text).toMatch(/\] reply\nWriting app\.py\.\n/);
    // A file's content is shown as the file.
    expect(text).toMatch(/\] → #1 write\n  path: app\.py\n  content:\n    print\('hello'\)\n    print\('bye'\)\n/);
    expect(text).toMatch(/\] ← #1 write done · \d+ms\n    Wrote app\.py\n/);
    // Unclipped, where the transcript keeps 2000 characters.
    expect(text).toContain(`    ${"x".repeat(5000)}\n    FAILED test_app.py::test_hello\n`);
    expect(text).toMatch(/\] ← #2 run_unit_tests failed/);
    expect(text).toContain("end of response · stop: toolUse · tokens: 1200 in, 340 out, 5000 cache read, 0 cache write · $0.0123");
    expect(text).toContain("provider retry 1 of 3 in 2.0s: overloaded");
    expect(text).toContain("provider retry succeeded");
    expect(text).toMatch(/\] turn finished after \d+s\n$/);
    // In the order it happened.
    const order = ["prompt 1", "] thinking\n", "] reply\n", "→ #1 write", "← #1 write", "→ #2 run_unit_tests", "end of response", "provider retry 1", "turn finished"];
    const positions = order.map((marker) => text.indexOf(marker));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("numbers each prompt of the session in turn", async () => {
    const session = fakeSession();
    startDebugLog(session, { cwd: codeDir, label: "app 1 coding agent" });
    await ask(session as unknown as AgentSession, "First.");
    await ask(session as unknown as AgentSession, "The unit tests failed. Fix them.");
    const text = onlyLog();
    expect(text).toMatch(/prompt 1 [^\n]*\nFirst\./);
    expect(text).toMatch(/prompt 2 [^\n]*\nThe unit tests failed\. Fix them\./);
  });

  it("records a provider error, and the turn ending on it", async () => {
    const session = fakeSession([
      event({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "insufficient credits" } }),
    ]);
    startDebugLog(session, { cwd: codeDir, label: "app 1 coding agent" });
    await expect(ask(session as unknown as AgentSession, "Go.")).rejects.toBeInstanceOf(ProviderError);
    const text = onlyLog();
    expect(text).toContain("end of response · stop: error");
    expect(text).toContain("error: insufficient credits");
    expect(text).toMatch(/turn ended with a provider error after \d+s: insufficient credits/);
  });

  it("records a turn that threw", async () => {
    const session = fakeSession();
    session.prompt = async () => {
      throw new Error("socket hang up");
    };
    startDebugLog(session, { cwd: codeDir, label: "app 1 coding agent" });
    await expect(ask(session as unknown as AgentSession, "Go.")).rejects.toThrow("socket hang up");
    expect(onlyLog()).toMatch(/turn failed after \d+s: socket hang up/);
  });

  it("keeps a block that arrives whole, with no deltas, and an event it cannot format does not reach the agent", async () => {
    const session = fakeSession([
      update({ type: "thinking_start" }),
      update({ type: "thinking_end", content: "[redacted thinking, whole]" }),
      event({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls", timeout: 30 } }),
      update({ type: "text_start" }),
      update({ type: "text_delta", delta: "Done." }),
      update({ type: "text_end", content: "Done." }),
    ]);
    startDebugLog(session, { cwd: codeDir, label: "app 1 coding agent" });
    // The log formats the call first, and that fails; the transcript's formatting after it does not.
    vi.spyOn(JSON, "stringify").mockImplementationOnce(() => {
      throw new Error("cannot format");
    });
    expect(await ask(session as unknown as AgentSession, "Go.")).toBe("Done.");
    vi.restoreAllMocks();
    const text = onlyLog();
    expect(text).toMatch(/\] thinking\n\[redacted thinking, whole\]\n/);
    expect(text).toContain("(an event could not be logged: cannot format)");
    // Streamed once, not again from its end.
    expect(text.match(/Done\./g)).toHaveLength(1);
  });

  it("numbers each tool call, so calls made together that finish out of order still match their results", async () => {
    const session = fakeSession([
      event({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "npm test" } }),
      event({ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { command: "ls" } }),
      event({ type: "tool_execution_end", toolCallId: "b", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "app.py" }] } }),
      event({ type: "tool_execution_end", toolCallId: "a", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "1 failed" }] } }),
    ]);
    startDebugLog(session, { cwd: codeDir, label: "app 1 coding agent" });
    await ask(session as unknown as AgentSession, "Go.");
    const text = onlyLog();
    expect(text).toMatch(/→ #1 bash\n  command: npm test\n/);
    expect(text).toMatch(/→ #2 bash\n  command: ls\n/);
    expect(text).toMatch(/← #2 bash done[^\n]*\n    app\.py\n/);
    expect(text).toMatch(/← #1 bash failed[^\n]*\n    1 failed\n/);
  });

  it("shows the tool calls of a response that was cut off, marked as never run", async () => {
    const session = fakeSession([
      event({
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "terminated", content: [{ type: "toolCall", name: "write", arguments: { path: "big.py", content: "a\nb" } }] },
      }),
    ]);
    startDebugLog(session, { cwd: codeDir, label: "app 1 coding agent" });
    await expect(ask(session as unknown as AgentSession, "Go.")).rejects.toBeInstanceOf(ProviderError);
    expect(onlyLog()).toMatch(/\(cut off, not run\) → write\n  path: big\.py\n  content:\n    a\n    b\n/);
  });

  it("puts the log of an agent working in a build folder outside plain_modules beside that folder, not in it", () => {
    const outside = join(root, "elsewhere", "build");
    mkdirSync(outside, { recursive: true });
    const log = startDebugLog(fakeSession(), { cwd: outside, label: "app 1 coding agent" })!;
    expect(log.file.startsWith(join(root, "elsewhere", ".turri", "debug"))).toBe(true);
    // The project itself, where the planner works, keeps its own.
    expect(debugDirFor(root)).toBe(join(root, ".turri", "debug"));
  });

  it("leaves a session with no log alone", async () => {
    const session = fakeSession([update({ type: "text_start" }), update({ type: "text_delta", delta: "Hi." })]);
    expect(await ask(session as unknown as AgentSession, "Go.")).toBe("Hi.");
    expect(existsSync(debugDir(root))).toBe(false);
  });

  it("never fails the render: a log that cannot be started or written is given up on", async () => {
    const activity: string[] = [];
    const sink = { stage() {}, activity: (line: string) => activity.push(line), now() {}, usage() {}, transcript() {} };

    // The folder cannot be made: no log, and the agent carries on without one.
    mkdirSync(join(root, ".turri"), { recursive: true });
    writeFileSync(join(root, ".turri", "debug"), "not a folder");
    await withActivity(sink, async () => {
      expect(startDebugLog(fakeSession(), { cwd: codeDir, label: "app 1 coding agent" })).toBeUndefined();
    });
    expect(activity.some((line) => line.startsWith("debug log not started:"))).toBe(true);

    // The folder goes mid-turn: the turn finishes, and the log stops once, quietly.
    rmSync(join(root, ".turri", "debug"));
    const session = fakeSession([update({ type: "text_start" }), update({ type: "text_delta", delta: "Hi." }), update({ type: "text_end" })]);
    await withActivity(sink, async () => {
      startDebugLog(session, { cwd: codeDir, label: "app 1 coding agent" });
      rmSync(debugDir(root), { recursive: true, force: true });
      expect(await ask(session as unknown as AgentSession, "Go.")).toBe("Hi.");
    });
    expect(activity.filter((line) => line.startsWith("debug log stopped:"))).toHaveLength(1);
  });
});
