import { describe, expect, it } from "vitest";
import { chatAskUserTool } from "../src/extension.ts";

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
});
