import { describe, expect, it } from "vitest";
import { createQuestioning, levelOf, questioningQuestion, QUESTIONING_LEVELS } from "../src/questioning.ts";

const level = (name: string) => QUESTIONING_LEVELS.find((each) => each.name === name)!;

describe("the questioning level", () => {
  it("is picked by name from the option chosen, and anything else is best judgement", () => {
    expect(levelOf(level("light").option).cap).toBe(3);
    expect(levelOf(level("medium").option).cap).toBe(5);
    expect(levelOf(level("thorough").option).cap).toBe(10);
    expect(levelOf(level("best judgement").option).cap).toBeUndefined();
    expect(levelOf("Keep it light, please").name).toBe("light");
    expect(levelOf("The user dismissed the question without answering.").name).toBe("best judgement");
  });

  it("is asked with an option for each level, naming the phases it caps", () => {
    const asked = questioningQuestion(["stack", "product"]);
    expect(asked.question).toBe("How many questions should I ask you in the stack and product phases?");
    expect(asked.options).toEqual(QUESTIONING_LEVELS.map((each) => each.option));
  });
});

describe("a capped phase", () => {
  it("refuses a question past its cap, but never the closing confirmation", () => {
    const questioning = createQuestioning({ level: level("light"), phases: ["stack", "product"] });
    questioning.enter("stack");
    for (let i = 0; i < 3; i += 1) {
      expect(questioning.refusal(false)).toBeUndefined();
      questioning.answered(false);
    }
    expect(questioning.refusal(false)).toMatch(/light questioning allows 3 questions in the stack phase/);
    expect(questioning.refusal(true)).toBeUndefined();
  });

  it("counts each phase apart, and leaves the phases it does not cap alone", () => {
    const questioning = createQuestioning({ level: level("light"), phases: ["stack", "product"] });
    questioning.enter("intent");
    for (let i = 0; i < 6; i += 1) questioning.answered(false);
    expect(questioning.refusal(false)).toBeUndefined();
    questioning.enter("stack");
    for (let i = 0; i < 3; i += 1) questioning.answered(false);
    questioning.enter("product");
    expect(questioning.refusal(false)).toBeUndefined();
  });

  it("does not count the closing confirmation", () => {
    const questioning = createQuestioning({ level: level("light"), phases: ["stack"] });
    questioning.enter("stack");
    questioning.answered(false);
    questioning.answered(true);
    questioning.answered(false);
    expect(questioning.refusal(false)).toBeUndefined();
  });

  it("ends its questions when the agent says so - best judgement's only end", () => {
    const questioning = createQuestioning({ level: level("best judgement"), phases: ["product"] });
    questioning.enter("product");
    for (let i = 0; i < 20; i += 1) questioning.answered(false);
    expect(questioning.refusal(false)).toBeUndefined();
    expect(questioning.end()).toMatch(/questions are over/);
    expect(questioning.refusal(false)).toMatch(/you ended the product phase's questions/);
  });

  it("picks up where a resumed run left it", () => {
    const states: unknown[] = [];
    const first = createQuestioning({ level: level("medium"), phases: ["product"], onChange: (state) => states.push(state) });
    first.enter("product");
    for (let i = 0; i < 4; i += 1) first.answered(false);
    const again = createQuestioning({ level: level("medium"), phases: ["product"], from: first.state() });
    again.enter("product");
    expect(again.refusal(false)).toBeUndefined();
    again.answered(false);
    expect(again.refusal(false)).toMatch(/all 5 are asked/);
    expect(states).toHaveLength(4);
  });

  it("tells the agent its cap as a capped phase starts, and the first phase which phases it caps", () => {
    const questioning = createQuestioning({ level: level("thorough"), phases: ["stack", "product"] });
    expect(questioning.note("intent", true)).toMatch(/thorough questioning - the harness asked it, so do not ask it again\. It caps the questions of the stack and product phases/);
    expect(questioning.note("stack", false)).toMatch(/Ask at most 10 questions/);
    expect(questioning.note("stack", false)).toMatch(/Ask narrow questions/);
    expect(questioning.note("stack", false)).toMatch(/never the spec changes/);
    expect(questioning.note("testing", false)).toBeUndefined();
  });
});
