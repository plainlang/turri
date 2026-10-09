import { describe, expect, it } from "vitest";
import { askUserVia, chatAskUserTool } from "../src/extension.ts";

describe("ask_user in the conversation", () => {
  it("puts the question to the person as a dialog to pick from, and returns what they picked", async () => {
    const asked: Array<{ title: string; options: string[] }> = [];
    const ctx = {
      hasUI: true,
      ui: {
        select: async (title: string, options: string[]) => (asked.push({ title, options }), options[1]),
        input: async () => "typed",
        setWorkingMessage: () => {},
      },
    };
    const tool = chatAskUserTool();
    const result = await (tool.execute as (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>)(
      "id",
      { question: "Which CRM first?", options: ["HubSpot", "Salesforce"] },
      undefined,
      undefined,
      ctx,
    );
    expect(asked[0]!.title).toContain("Which CRM first?");
    expect(asked[0]!.options).toEqual(expect.arrayContaining(["HubSpot", "Salesforce"]));
    expect(result.content[0]!.text).toContain("Salesforce");
    expect(tool.promptGuidelines!.some((line) => line.includes("rather than in your reply"))).toBe(true);
  });

  it("shows a skill's question alone - what its agent said before it kept in its record, never in the dialog", async () => {
    const titles: string[] = [];
    const ctx = {
      hasUI: true,
      ui: {
        select: async (title: string, options: string[]) => (titles.push(title), options[0]),
        input: async () => "typed",
        setWorkingMessage: () => {},
      },
    };
    const kept: Array<string | undefined> = [];
    const said = "The configured token returned **200**; the invalid token returned **401**.";
    const answer = await askUserVia(ctx as never, (_question, _answer, context) => kept.push(context))({
      question: "Which authentication setup should HubSpot contact sync use?",
      options: ["Private app token"],
      said,
    });
    expect(answer).toBe("Private app token");
    expect(titles).toEqual(["Which authentication setup should HubSpot contact sync use?"]);
    expect(kept).toEqual([said]);
  });

  it("shows above a skill's question what it gives to read for it - the brief to confirm - and keeps it with the answer", async () => {
    const titles: string[] = [];
    const ctx = {
      hasUI: true,
      ui: {
        select: async (title: string, options: string[]) => (titles.push(title), options[0]),
        input: async () => "typed",
        setWorkingMessage: () => {},
      },
    };
    const kept: Array<string | undefined> = [];
    const brief = "- Problem: invoices get lost.\n- Primary user: a freelancer.";
    await askUserVia(ctx as never, (_question, _answer, context) => kept.push(context))({
      question: "Is this the right brief?",
      options: ["Yes"],
      context: brief,
      said: "Here is what I have.",
    });
    expect(titles).toEqual([`${brief}\n\nIs this the right brief?`]);
    expect(kept).toEqual([`${brief}\n\nHere is what I have.`]);
  });
});
