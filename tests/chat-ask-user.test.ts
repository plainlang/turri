import { describe, expect, it } from "vitest";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { askUserVia, chatAskUserTool } from "../src/extension.ts";

type Shown = { render(width: number): string[]; handleInput?(data: string): void };

/**
 * A TUI stand-in: each dialog turri opens with ctx.ui.custom is drawn, kept, and answered with the keys `press` gives it
 * - by default, enter on the first option.
 */
function fakeUi(press: (lines: string[]) => string[] = () => ["\r"]) {
  const shown: string[][] = [];
  const ui = {
    setWorkingMessage: () => {},
    setWidget: () => {},
    custom: <T>(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => Shown) =>
      new Promise<T>((resolve) => {
        const tui = { terminal: { rows: 40 }, requestRender: () => {}, addInputListener: () => () => {} };
        const theme = { fg: (_colour: string, text: string) => text, bold: (text: string) => text };
        const component = factory(tui, theme, {}, resolve);
        const lines = component.render(100).map((line) => stripTerminalSequences(line));
        shown.push(lines);
        for (const key of press(lines)) component.handleInput?.(key);
      }),
  };
  return { ctx: { hasUI: true, ui }, shown };
}

describe("ask_user in the conversation", () => {
  it("puts the question to the person as a dialog to pick from, and returns what they picked", async () => {
    const { ctx, shown } = fakeUi(() => ["\x1b[B", "\r"]);
    const tool = chatAskUserTool();
    const result = await (tool.execute as (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>)(
      "id",
      { question: "Which CRM first?", options: ["HubSpot", "Salesforce"] },
      undefined,
      undefined,
      ctx,
    );
    expect(shown[0]).toContain("  Which CRM first?");
    expect(shown[0]).toEqual(expect.arrayContaining(["  › HubSpot", "    Salesforce"]));
    expect(result.content[0]!.text).toContain("Salesforce");
    expect(tool.promptGuidelines!.some((line) => line.includes("rather than in your reply"))).toBe(true);
  });

  it("shows a skill's question alone - what its agent said before it kept in its record, never in the dialog", async () => {
    const { ctx, shown } = fakeUi();
    const kept: Array<string | undefined> = [];
    const said = "The configured token returned **200**; the invalid token returned **401**.";
    const answer = await askUserVia(ctx as never, (_question, _answer, context) => kept.push(context))({
      question: "Which authentication setup should HubSpot contact sync use?",
      options: ["Private app token"],
      said,
    });
    expect(answer).toBe("Private app token");
    expect(shown[0]![1]).toBe("  Which authentication setup should HubSpot contact sync use?");
    expect(shown[0]!.join("\n")).not.toContain("returned");
    expect(kept).toEqual([said]);
  });

  it("shows above a skill's question what it gives to read for it - the brief to confirm - and keeps it with the answer", async () => {
    const { ctx, shown } = fakeUi();
    const kept: Array<string | undefined> = [];
    const brief = "- Problem: invoices get lost.\n- Primary user: a freelancer.";
    await askUserVia(ctx as never, (_question, _answer, context) => kept.push(context))({
      question: "Is this the right brief?",
      options: ["Yes"],
      context: brief,
      said: "Here is what I have.",
    });
    expect(shown[0]!.slice(1, 5)).toEqual(["  - Problem: invoices get lost.", "  - Primary user: a freelancer.", "", "  Is this the right brief?"]);
    expect(kept).toEqual([`${brief}\n\nHere is what I have.`]);
  });
});
