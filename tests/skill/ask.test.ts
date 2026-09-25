import { describe, expect, it, vi } from "vitest";
import { DONE_OPTION, OTHER_OPTION, missingOptions, runAsk, type AskUserIO } from "../../src/ask.ts";

/** A scripted user: each select/input call returns the next queued reply. */
function scriptedUser(replies: Array<string | undefined>): AskUserIO & { calls: string[][] } {
  const queue = [...replies];
  const calls: string[][] = [];
  return {
    calls,
    async select(title, options) {
      calls.push([title, ...options]);
      return queue.shift();
    },
    async input(title) {
      calls.push([title]);
      return queue.shift();
    },
  };
}

describe("a question with no options", () => {
  it("is refused rather than asked", async () => {
    const user = scriptedUser(["never reached"]);
    const answer = await runAsk({ question: "What storage?" }, user);

    expect(answer).toContain("Offer concrete options");
    expect(user.calls).toEqual([]);
  });

  it("is allowed when free_form says so deliberately", async () => {
    const user = scriptedUser(["A todo list"]);
    expect(await runAsk({ question: "What is the app?", freeForm: true }, user)).toBe("A todo list");
  });

  it("names the refusal reason for the model to act on", () => {
    expect(missingOptions({ question: "x" })).toContain("free_form");
    expect(missingOptions({ question: "x", options: ["a"] })).toBeNull();
    expect(missingOptions({ question: "x", freeForm: true })).toBeNull();
  });
});

describe("picking one", () => {
  it("returns the chosen option", async () => {
    const user = scriptedUser(["Postgres"]);
    const answer = await runAsk({ question: "What storage?", options: ["Postgres", "SQLite"] }, user);

    expect(answer).toBe("Postgres");
    expect(user.calls[0]).toEqual(["What storage?", "Postgres", "SQLite", OTHER_OPTION]);
  });

  it("always offers a way out of the list", async () => {
    const user = scriptedUser([OTHER_OPTION, "DynamoDB"]);
    expect(await runAsk({ question: "What storage?", options: ["Postgres"] }, user)).toBe("DynamoDB");
  });

  it("reports a dismissal rather than inventing an answer", async () => {
    const user = scriptedUser([undefined]);
    expect(await runAsk({ question: "What storage?", options: ["Postgres"] }, user)).toContain("dismissed");
  });
});

describe("picking several", () => {
  const request = { question: "Which integrations?", options: ["Slack", "Email", "SMS"], multiSelect: true };

  it("collects choices until the user is done", async () => {
    const user = scriptedUser(["Slack", "SMS", DONE_OPTION]);
    expect(await runAsk(request, user)).toBe("Slack, SMS");
  });

  it("stops offering what has already been picked", async () => {
    const user = scriptedUser(["Slack", DONE_OPTION]);
    await runAsk(request, user);

    expect(user.calls[0]).toContain("Slack");
    expect(user.calls[1]).not.toContain("Slack");
    expect(user.calls[1]![0]).toContain("so far: Slack");
  });

  it("stops on its own once everything is chosen", async () => {
    const user = scriptedUser(["Slack", "Email", "SMS"]);
    expect(await runAsk(request, user)).toBe("Slack, Email, SMS");
    expect(user.calls).toHaveLength(3);
  });

  it("takes typed answers alongside the offered ones", async () => {
    const user = scriptedUser([OTHER_OPTION, "Webhooks", "Email", DONE_OPTION]);
    expect(await runAsk(request, user)).toBe("Webhooks, Email");
  });

  it("reports a dismissal when nothing was picked", async () => {
    const user = scriptedUser([undefined]);
    expect(await runAsk(request, user)).toContain("dismissed");
  });
});

describe("the tool the model sees", () => {
  it("passes the snake_case parameters through to the policy", async () => {
    const { createAskUserTool } = await import("../../src/tools.ts");
    const ask = vi.fn(async () => "picked");
    const tool = createAskUserTool(ask);

    await tool.execute("id", { question: "q", options: ["a"], multi_select: true }, undefined, undefined, {} as never);

    expect(ask).toHaveBeenCalledWith({
      question: "q",
      options: ["a"],
      multiSelect: true,
      freeForm: undefined,
    });
  });
});

describe("tool-call markup a model leaks into a question", () => {
  const recording = () => {
    const shown: string[][] = [];
    return {
      shown,
      io: {
        select: async (_title: string, options: string[]) => (shown.push(options), options[0]),
        input: async () => "typed",
      },
    };
  };

  it("is never shown: cut out of the options, and a leaked multi_select taken as the argument", async () => {
    const { cleanRequest, runAsk } = await import("../../src/ask.ts");
    const leaked = {
      question: "Which CRM should be built first?",
      options: ["HubSpot", "Salesforce\n<parameter name=\"multi_select\">false", "<parameter name=\"multi_select\">false"],
    };
    expect(cleanRequest(leaked)).toEqual({
      request: { question: "Which CRM should be built first?", options: ["HubSpot", "Salesforce"], multiSelect: false },
      leaked: true,
    });
    const { shown, io } = recording();
    expect(await runAsk(leaked, io)).toBe("HubSpot");
    expect(shown[0]).toEqual(["HubSpot", "Salesforce", "Something else…"]);
  });

  it("sends the question back when nothing sensible is left of it", async () => {
    const { runAsk } = await import("../../src/ask.ts");
    const { shown, io } = recording();
    const answer = await runAsk({ question: "Pick one", options: ["</parameter>", "<parameter name=\"options\">[\"a\"]"] }, io);
    expect(answer).toContain("This question was not asked: its question or options held tool-call markup");
    expect(shown).toEqual([]);
  });
});
