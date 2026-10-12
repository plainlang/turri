import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AskUserRequest } from "../../src/ask.ts";

type Tool = { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> };

const prompts: string[] = [];
const replies: string[] = [];

// The skill's agent, scripted: one question in intent; in stack, four questions, then the confirmation.
vi.mock("../../src/pi.ts", () => {
  let tools: Tool[] = [];
  return {
    createExecutor: async (opts: { customTools: Tool[] }) => {
      tools = opts.customTools;
      return { sessionFile: undefined, dispose: () => {}, subscribe: () => () => {} };
    },
    ask: async (_session: unknown, prompt: string) => {
      prompts.push(prompt);
      const askUser = tools.find((tool) => tool.name === "ask_user")!;
      const question = async (text: string, extra: object = {}) =>
        replies.push((await askUser.execute("id", { question: text, options: ["Yes"], ...extra })).content[0]!.text);
      if ((globalThis as { perAnswer?: boolean }).perAnswer === true) {
        // Two questions in a row, the first answer never written as a spec change.
        await question("Which feature first?");
        await question("Which feature next?");
        return "done";
      }
      if (prompt.includes("step 'intent'")) await question("What problem does it solve?");
      else for (const n of [1, 2, 3, 4]) await question(`Stack question ${n}?`);
      if (prompt.includes("step 'stack'")) await question("Is this the stack?", { confirms_phase: true });
      return "done";
    },
  };
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "turri-questioning-"));
  mkdirSync(join(root, "skill"));
  writeFileSync(
    join(root, "skill", "SKILL.md"),
    "---\nname: interview\ndescription: Asks.\nallowed-tools: [read]\nmetadata:\n  questioning: [stack]\n---\n\n# Interview\n\n## Steps\n\n### intent\n\nAsk about intent.\n\n### stack\n\nAsk about the stack.\n",
  );
  prompts.length = 0;
  replies.length = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function run(answer: (request: AskUserRequest) => string) {
  const { runSkill } = await import("../../src/genome.ts");
  const asked: AskUserRequest[] = [];
  await runSkill({
    skillDir: join(root, "skill"),
    cwd: root,
    runDir: join(root, "run"),
    report: { step: () => {}, artifact: () => {}, gate: () => {}, judge: () => {}, outcome: () => {} },
    escalate: async () => false,
    askUser: async (request) => (asked.push(request), answer(request)),
  });
  return asked;
}

describe("a phase where each answer is a spec change", () => {
  it("does not ask the next question until the last answer is written with write_spec_diff", async () => {
    writeFileSync(
      join(root, "skill", "SKILL.md"),
      "---\nname: interview\ndescription: Asks.\nallowed-tools: [read, write_spec_diff]\nmetadata:\n  spec-diff-per-answer: [product]\n---\n\n# Interview\n\n## Steps\n\n### product\n\nAsk about the product.\n",
    );
    const { runSkill } = await import("../../src/genome.ts");
    const asked: AskUserRequest[] = [];
    (globalThis as { perAnswer?: boolean }).perAnswer = true;
    try {
      await runSkill({
        skillDir: join(root, "skill"),
        cwd: root,
        runDir: join(root, "run"),
        report: { step: () => {}, artifact: () => {}, gate: () => {}, judge: () => {}, outcome: () => {} },
        escalate: async () => false,
        askUser: async (request) => (asked.push(request), "Sign-up"),
        renderQueue: {} as never,
      });
    } finally {
      delete (globalThis as { perAnswer?: boolean }).perAnswer;
    }
    expect(asked.map((request) => request.question)).toEqual(["Which feature first?"]);
    expect(replies[1]).toMatch(/the last answer is not in the spec yet/);
  });
});

describe("an interview whose phases the questioning level caps", () => {
  it("asks the level first, before the agent asks anything, and tells the agent what was chosen", async () => {
    const asked = await run((request) => (request.question.startsWith("How many") ? request.options![0]! : "Yes"));
    expect(asked[0]!.question).toBe("How many questions should I ask you in the stack phase?");
    expect(asked[1]!.question).toBe("What problem does it solve?");
    expect(prompts[0]).toMatch(/The person chose light questioning - the harness asked it/);
    expect(prompts[1]).toMatch(/Ask at most 3 questions/);
  });

  it("refuses the questions past the cap, and still asks the closing confirmation", async () => {
    const asked = await run((request) => (request.question.startsWith("How many") ? request.options![0]! : "Yes"));
    expect(asked.map((request) => request.question)).toEqual([
      "How many questions should I ask you in the stack phase?",
      "What problem does it solve?",
      "Stack question 1?",
      "Stack question 2?",
      "Stack question 3?",
      "Is this the stack?",
    ]);
    expect(replies[4]).toMatch(/This question was not asked: light questioning allows 3 questions in the stack phase/);
    expect(JSON.parse(readFileSync(join(root, "run", "run.json"), "utf8")).questioning).toEqual({ level: "light", asked: { stack: 3 }, over: ["stack"] });
  });

  it("asks every question under best judgement", async () => {
    const asked = await run((request) => (request.question.startsWith("How many") ? request.options!.at(-1)! : "Yes"));
    expect(asked.filter((request) => request.question.startsWith("Stack question"))).toHaveLength(4);
  });
});
