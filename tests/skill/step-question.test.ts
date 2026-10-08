import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "../../src/skill.ts";

/** The replies the skill's agent gives, turn by turn; once they run out, it says it is done. */
let replies: string[] = [];
const asked: string[] = [];
vi.mock("../../src/pi.ts", () => ({
  ask: async (_session: unknown, text: string) => {
    asked.push(text);
    return replies.shift() ?? "Done.";
  },
}));

const { compileSkill, endsOnQuestion, QUESTION_NUDGES } = await import("../../src/graph.ts");

const skillOf = (paced: boolean) =>
  ({
    name: "spawn",
    dir: "/nowhere",
    allowedTools: [],
    paced,
    steps: [
      { name: "groundwork", instructions: "Set it up." },
      { name: "product", instructions: "Write the product." },
    ],
  }) as unknown as Skill;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-step-question-"));
  replies = [];
  asked.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(paced: boolean) {
  const app = compileSkill({
    skill: skillOf(paced), cwd: dir, runDir: dir, executor: {} as never,
    report: { step() {}, artifact() {}, gate() {}, judge() {}, outcome() {} },
  }).compile({ checkpointer: new MemorySaver() });
  await app.invoke({}, { configurable: { thread_id: "t" } });
}

describe("a step whose turn ends on a question in its reply", () => {
  it("is sent back to carry on - the question reaches no one - before the next step starts", async () => {
    replies = ["Groundwork is ready.", "The description is queued. Proceed with the health check feature?", "All ten features are queued."];
    await run(false);
    expect(asked).toHaveLength(3);
    expect(asked[1]).toContain("Write the product.");
    expect(asked[2]).toContain("Your turn ended on a question in your reply");
    expect(asked[2]).toContain("'spawn' asks the person nothing more: decide it yourself");
    expect(asked[2]).toContain("carry on with step 'product' until all of it is done");
  });

  it("is told to ask with ask_user, when the skill asks the person things", async () => {
    replies = ["Ready?", "Done."];
    await run(true);
    expect(asked[1]).toContain("If it is truly the person's to decide, ask it with ask_user");
  });

  it("is sent back at most twice, then the step ends all the same", async () => {
    replies = ["Shall I?", "Shall I?", "Shall I?", "Shall I?"];
    await run(false);
    // The groundwork asks three times - its turn and two nudges - and the product step still starts.
    expect(asked.slice(0, 3).filter((text) => text.includes("Your turn ended on a question"))).toHaveLength(QUESTION_NUDGES);
    expect(asked[3]).toContain("Write the product.");
  });
});

describe("a reply that ends on a question", () => {
  it("is told by its last line, its markdown aside", () => {
    expect(endsOnQuestion("Queued.\n\nProceed with that feature?")).toBe(true);
    expect(endsOnQuestion("Which stack do you want, **Python or Go?**\n")).toBe(true);
    expect(endsOnQuestion("Should I add a health check? I did - all features are queued.")).toBe(false);
    expect(endsOnQuestion("")).toBe(false);
  });
});
