import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AskUserRequest } from "../src/ask.ts";

type Listener = (event: unknown) => void;
type Tool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };

// The skill's agent, scripted: it states a brief in its reply, then asks whether it is right.
vi.mock("../src/pi.ts", () => {
  let tools: Tool[] = [];
  const listeners: Listener[] = [];
  const say = (text: string) => {
    for (const listener of listeners) listener({ type: "message_update", assistantMessageEvent: { type: "text_start" } });
    for (const listener of listeners) listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
  };
  return {
    createExecutor: async (opts: { customTools: Tool[] }) => {
      tools = opts.customTools;
      return { sessionFile: undefined, dispose: () => {}, subscribe: (listener: Listener) => (listeners.push(listener), () => {}) };
    },
    ask: async () => {
      const askUser = tools.find((tool) => tool.name === "ask_user")!;
      for (const listener of listeners) listener({ type: "tool_execution_start", toolName: "write", args: { path: "asana.plain" } });
      say("- The problem: invoices get lost.\n- The primary user: a freelancer.");
      await askUser.execute("1", { question: "Is this the right brief for the first version?", options: ["Build it", "Change something"] });
      say("Noted.");
      await askUser.execute("2", { question: "Anything else?", free_form: true });
      return "done";
    },
  };
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "turri-skill-ask-"));
  mkdirSync(join(root, "skill"));
  writeFileSync(
    join(root, "skill", "SKILL.md"),
    "---\nname: brief\ndescription: States a brief and asks.\nallowed-tools: [read]\n---\n\n# Brief\n\n## Steps\n\n### intent\n\nState the brief and ask whether it is right.\n",
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("a skill's agent at work", () => {
  it("is reported as it works - each tool call, and its words from the start of each reply", async () => {
    const { runSkill } = await import("../src/forge.ts");
    const activity: string[] = [];
    let saying = "";
    await runSkill({
      skillDir: join(root, "skill"),
      cwd: root,
      runDir: join(root, "run"),
      report: {
        step: () => {},
        artifact: () => {},
        gate: () => {},
        judge: () => {},
        outcome: () => {},
        activity: (line) => activity.push(line),
        said: (delta, fresh) => (saying = fresh ? "" : saying + delta),
      },
      escalate: async () => false,
      askUser: async () => "Build it",
    });
    expect(activity[0]).toContain("write asana.plain");
    expect(saying).toBe("Noted.");
  });
});

describe("a skill's question", () => {
  it("comes with what its agent said since its last question - the brief it asks about - and only that", async () => {
    const { runSkill } = await import("../src/forge.ts");
    const asked: AskUserRequest[] = [];
    await runSkill({
      skillDir: join(root, "skill"),
      cwd: root,
      runDir: join(root, "run"),
      report: { step: () => {}, artifact: () => {}, gate: () => {}, judge: () => {}, outcome: () => {} },
      escalate: async () => false,
      askUser: async (request) => (asked.push(request), "Build it"),
    });
    expect(asked[0]!.context).toBe("- The problem: invoices get lost.\n- The primary user: a freelancer.");
    expect(asked[1]!.context).toBe("Noted.");
  });

  it("is shown below that text in the dialog", async () => {
    const { runAsk } = await import("../src/ask.ts");
    const titles: string[] = [];
    await runAsk(
      { question: "Is this the right brief?", options: ["Build it"], context: "- The problem: invoices get lost." },
      { select: async (title) => (titles.push(title), "Build it"), input: async () => undefined },
    );
    expect(titles[0]).toBe("- The problem: invoices get lost.\n\nIs this the right brief?");
  });
});
