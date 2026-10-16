import { describe, expect, it, vi } from "vitest";
import { CHAT_OPTION, DONE_OPTION, OTHER_OPTION, TICKED, UNTICKED, isChat, missingOptions, peekKeyListener, runAsk, type AskUserIO } from "../../src/ask.ts";

/** A scripted user: each select/input call returns the next queued reply. */
function scriptedUser(replies: Array<string | undefined>): AskUserIO & { calls: string[][]; at: Array<number | undefined> } {
  const queue = [...replies];
  const calls: string[][] = [];
  const at: Array<number | undefined> = [];
  return {
    calls,
    at,
    async select(title, options, _context, cursor) {
      calls.push([title, ...options]);
      at.push(cursor);
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

describe("talking about a question before answering it", () => {
  const request = { question: "What storage?", options: ["Postgres", "SQLite"], chattable: true };

  it("is offered beside Something else when an agent asked, and comes back as what the person said - no answer", async () => {
    const user = scriptedUser([CHAT_OPTION, "What does SQLite cost us later?"]);
    const answer = await runAsk(request, user);
    expect(user.calls[0]).toEqual(["What storage?", "Postgres", "SQLite", OTHER_OPTION, CHAT_OPTION]);
    expect(user.calls[1]![0]).toContain("What would you like to talk about?");
    expect(isChat(answer)).toBe(true);
    expect(answer).toContain("They said: What does SQLite cost us later?");
  });

  it("is not offered for a question the harness asks itself", async () => {
    const user = scriptedUser(["Postgres"]);
    await runAsk({ question: "What storage?", options: ["Postgres"] }, user);
    expect(user.calls[0]).not.toContain(CHAT_OPTION);
  });

  it("can be backed out of, to the options again", async () => {
    const user = scriptedUser([CHAT_OPTION, undefined, "SQLite"]);
    expect(await runAsk(request, user)).toBe("SQLite");
  });

  it("says what was picked so far, in a question of several", async () => {
    const user = scriptedUser([`${UNTICKED} Slack`, CHAT_OPTION, "Is email enough on its own?"]);
    const answer = await runAsk({ question: "Which integrations?", options: ["Slack", "Email"], multiSelect: true, chattable: true }, user);
    expect(isChat(answer)).toBe(true);
    expect(answer).toContain("They had picked so far: Slack.");
  });
});

describe("Something else, chosen by accident", () => {
  it("goes back to the options on Esc, rather than dismissing the question", async () => {
    const user = scriptedUser([OTHER_OPTION, undefined, "Postgres"]);
    expect(await runAsk({ question: "What storage?", options: ["Postgres"] }, user)).toBe("Postgres");
    expect(user.calls[1]![0]).toContain("Esc, or nothing typed: back to the options");
    expect(user.calls[2]).toEqual(["What storage?", "Postgres", OTHER_OPTION]);
  });

  it("goes back to the options when nothing is typed", async () => {
    const user = scriptedUser([OTHER_OPTION, "   ", "Postgres"]);
    expect(await runAsk({ question: "What storage?", options: ["Postgres"] }, user)).toBe("Postgres");
  });

  it("still dismisses the question from the options themselves", async () => {
    const user = scriptedUser([OTHER_OPTION, undefined, undefined]);
    expect(await runAsk({ question: "What storage?", options: ["Postgres"] }, user)).toContain("dismissed");
  });
});

describe("picking several", () => {
  const request = { question: "Which integrations?", options: ["Slack", "Email", "SMS"], multiSelect: true };
  const box = (ticked: boolean, option: string) => `${ticked ? TICKED : UNTICKED} ${option}`;

  it("ticks each option chosen until the user is done, and answers in the options' order", async () => {
    const user = scriptedUser([box(false, "SMS"), box(false, "Slack"), DONE_OPTION]);
    expect(await runAsk(request, user)).toBe("Slack, SMS");
    expect(user.calls[2]).toEqual(["Which integrations?", box(true, "Slack"), box(false, "Email"), box(true, "SMS"), OTHER_OPTION, DONE_OPTION]);
  });

  it("unticks an option chosen again, so a pick made by mistake is undone", async () => {
    const user = scriptedUser([box(false, "Slack"), box(false, "Email"), box(true, "Slack"), DONE_OPTION]);
    expect(await runAsk(request, user)).toBe("Email");
    expect(user.calls[3]).toContain(box(false, "Slack"));
  });

  it("keeps the cursor on the option just ticked", async () => {
    const user = scriptedUser([box(false, "SMS"), DONE_OPTION]);
    await runAsk(request, user);
    expect(user.at).toEqual([0, 2]);
  });

  it("adds a typed answer as one more box, ticked - and unticks it like any other", async () => {
    const user = scriptedUser([OTHER_OPTION, "Webhooks", box(false, "Email"), box(true, "Webhooks"), DONE_OPTION]);
    expect(await runAsk(request, user)).toBe("Email");
    expect(user.calls[2]).toContain(box(true, "Webhooks"));
  });

  it("takes an option by its text where the answer is typed, as on the command line", async () => {
    const user = scriptedUser(["Email", "Webhooks", DONE_OPTION]);
    expect(await runAsk(request, user)).toBe("Email, Webhooks");
  });

  it("gives no box to Something else, Chat about this or Done", async () => {
    const user = scriptedUser([DONE_OPTION]);
    await runAsk({ ...request, chattable: true }, user);
    expect(user.calls[0]!.slice(-3)).toEqual([OTHER_OPTION, CHAT_OPTION, DONE_OPTION]);
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
      chattable: true,
    });
  });

  it("does not count a choice to talk about the question as its answer, and tells a skill's agent to answer in the question asked again", async () => {
    const { createAskUserTool } = await import("../../src/tools.ts");
    const answered = vi.fn();
    const counted = vi.fn();
    const tool = createAskUserTool(async () => "The user has not answered this question yet: they chose to talk about it first.\nThey said: why?", answered, undefined, { refusal: () => undefined, answered: counted });
    const result = await tool.execute("id", { question: "q", options: ["a"] }, undefined, undefined, {} as never);
    expect(answered).not.toHaveBeenCalled();
    expect(counted).not.toHaveBeenCalled();
    expect(result.content[0]!.text).toContain("Put your answer to them in the question's `context`");
  });

  it("tells the conversation's agent to answer a choice to talk in its reply, and end its turn", async () => {
    const { createAskUserTool } = await import("../../src/tools.ts");
    const tool = createAskUserTool(async () => "The user has not answered this question yet: they chose to talk about it first.\nThey said: why?", undefined, undefined, undefined, "reply");
    const result = await tool.execute("id", { question: "q", options: ["a"] }, undefined, undefined, {} as never);
    expect(result.content[0]!.text).toContain("Answer what they said in your reply, and end your turn there");
  });

  it("passes what the user must read to answer as context, and what the agent said before asking as said alone", async () => {
    const { createAskUserTool } = await import("../../src/tools.ts");
    const ask = vi.fn(async (_request: unknown) => "picked");
    const tool = createAskUserTool(ask, undefined, () => "The probe returned 200.");
    await tool.execute("id", { question: "Is this the brief?", options: ["Yes"], context: "- Problem: lost invoices." }, undefined, undefined, {} as never);
    expect(ask.mock.calls[0]![0]).toMatchObject({ context: "- Problem: lost invoices.", said: "The probe returned 200." });
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

describe("peeking while a question waits", () => {
  it("opens the panel on ctrl+h while a question has the keys - unless the panel shows, whose own ctrl+h closes it - and lets every other key through", () => {
    let shown = false;
    const opened: string[] = [];
    const listen = peekKeyListener({ open: () => opened.push("panel"), shown: () => shown });
    expect(listen("\x08")).toEqual({ consume: true });
    expect(opened).toEqual(["panel"]);
    // Any other key is the question's.
    expect(listen("a")).toBeUndefined();
    expect(listen("\r")).toBeUndefined();
    // The panel shows: its listener has ctrl+h.
    shown = true;
    expect(listen("\x08")).toBeUndefined();
    expect(opened).toEqual(["panel"]);
  });
});
