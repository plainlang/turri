import { describe, expect, it } from "vitest";

const { turnLimited, RUNS_PER_TURN } = await import("../../src/regenerate/conformance.ts");

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
