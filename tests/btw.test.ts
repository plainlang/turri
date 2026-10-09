import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AskUserRequest } from "../src/ask.ts";

type Tool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };

// The side agent, scripted: it answers from its task, and its tools are kept to be looked at.
const seen: { task?: string; tools: string[]; disposed: boolean } = { tools: [], disposed: false };
vi.mock("../src/pi.ts", () => ({
  BEGIN: "Begin.",
  createExecutor: async (opts: { task?: string; tools: string[]; customTools: Tool[] }) => {
    seen.task = opts.task;
    seen.tools = opts.tools;
    return { dispose: () => (seen.disposed = true) };
  },
  ask: async () => "A frid is a functionality id.",
}));

const { answerSideQuestion, askWithAsides, BTW_HOW, sideQuestionOf, skillRunStarted, runningSkill, skillSessionText, transcriptOf } = await import("../src/btw.ts");

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "turri-btw-"));
  seen.task = undefined;
  seen.tools = [];
  seen.disposed = false;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const message = (role: string, content: unknown) => ({ type: "message", message: { role, content } });

describe("a side question", () => {
  it("is what follows /btw, and anything else is not one", () => {
    expect(sideQuestionOf("/btw what is a frid?")).toBe("what is a frid?");
    expect(sideQuestionOf("  /BTW  why this stack?  ")).toBe("why this stack?");
    expect(sideQuestionOf("/btw")).toBe("");
    expect(sideQuestionOf("/btwx no")).toBeUndefined();
    expect(sideQuestionOf("Build it")).toBeUndefined();
  });

  it("is shown the conversation as who said what, tool calls named and thinking left out, from its end", () => {
    const entries = [
      message("user", "Build me an invoice tracker."),
      message("assistant", [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Starting brood." }, { type: "toolCall", name: "cultivate" }]),
      message("toolResult", [{ type: "text", text: "ignored" }]),
      { type: "custom", data: {} },
    ];
    expect(transcriptOf(entries, 10_000)).toBe("user: Build me an invoice tracker.\n\nassistant: Starting brood.\n\nassistant called cultivate");
    expect(transcriptOf(entries, 10)).toBe("… cultivate");
  });

  it("reads the running skill's agent's session from the file its run.json names", () => {
    const session = join(root, "session.jsonl");
    writeFileSync(session, [JSON.stringify({ type: "session" }), JSON.stringify(message("assistant", [{ type: "text", text: "Which stack?" }])), "not json"].join("\n"));
    writeFileSync(join(root, "run.json"), JSON.stringify({ sessionFile: session }));
    expect(skillSessionText(root)).toBe("assistant: Which stack?");
    expect(skillSessionText(join(root, "missing"))).toBe("");
  });

  it("is answered by a read-only agent told the conversation, what the skill has done, the pulses and the question", async () => {
    const answer = await answerSideQuestion({
      question: "what is a frid?",
      conversation: "user: Build me an invoice tracker.",
      skill: { name: "brood", step: "interview, attempt 1", trace: ["step interview (attempt 1)", "  Q: Who uses it?", "  A: freelancers"], session: "assistant: Which stack?" },
      pulses: ["ab12 running: app.plain Accounts"],
      projectDir: root,
      harnessDir: root,
    });
    expect(answer).toBe("A frid is a functionality id.");
    expect(seen.task).toContain("user: Build me an invoice tracker.");
    expect(seen.task).toContain("A skill is running now: brood, in its interview, attempt 1");
    expect(seen.task).toContain("  A: freelancers");
    expect(seen.task).toContain("assistant: Which stack?");
    expect(seen.task).toContain("- ab12 running: app.plain Accounts");
    expect(seen.task).toContain("<question>\nwhat is a frid?\n</question>");
    expect(seen.tools).not.toContain("write");
    expect(seen.tools).not.toContain("edit");
    expect(seen.tools).not.toContain("bash");
    expect(seen.disposed).toBe(true);
  });

  it("knows the skill running only until it says it has ended", () => {
    const ended = skillRunStarted({ skill: "brood", step: () => "", trace: () => [], runDir: root });
    expect(runningSkill()?.skill).toBe("brood");
    ended();
    expect(runningSkill()).toBeUndefined();
  });
});

describe("a skill's question, answered with /btw", () => {
  it("answers the side question and asks the same question again with the answer above it, the asker getting only the real answer", async () => {
    const asked: AskUserRequest[] = [];
    const answers = ["/btw what is a frid?", "Build it"];
    const answer = await askWithAsides(
      { question: "Is this the brief?", options: ["Build it"], context: "- invoices get lost" },
      async (request) => (asked.push(request), answers.shift()!),
      async (question) => `answered: ${question}`,
    );
    expect(answer).toBe("Build it");
    expect(asked).toHaveLength(2);
    expect(asked[1]).toEqual({ question: "Is this the brief?", options: ["Build it"], context: "btw: what is a frid?\nanswered: what is a frid?\n\n- invoices get lost" });
  });

  it("keeps only the latest side answer above the question", async () => {
    const asked: AskUserRequest[] = [];
    const answers = ["/btw one", "/btw two", "yes"];
    await askWithAsides({ question: "Go?", freeForm: true }, async (request) => (asked.push(request), answers.shift()!), async (question) => `re ${question}`);
    expect(asked[2]!.context).toBe("btw: two\nre two");
  });

  it("says how to ask when /btw comes alone, and says so when the side question fails, asking again either way", async () => {
    const asked: AskUserRequest[] = [];
    const answers = ["/btw", "/btw boom", "ok"];
    const answer = await askWithAsides(
      { question: "Go?", freeForm: true },
      async (request) => (asked.push(request), answers.shift()!),
      async () => {
        throw new Error("no provider");
      },
    );
    expect(answer).toBe("ok");
    expect(asked[1]!.context).toBe(BTW_HOW);
    expect(asked[2]!.context).toBe("btw: boom\nThe side question could not be answered: no provider");
  });
});

