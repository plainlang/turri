import { describe, expect, it } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

process.env.TURRI_TURN_LIMIT = "1";
process.env.TURRI_TURN_GRACE = "1";
process.env.TURRI_PROVIDER_RETRY_DELAY = "0.01";
const { ask, timeTurns } = await import("../src/pi.ts");

/** A session whose turn goes on until it is aborted, and says what it was asked. */
function slowSession() {
  const prompts: string[] = [];
  let finish: () => void = () => {};
  let aborted = 0;
  const session = {
    subscribe: () => () => {},
    prompt: (text: string) => (prompts.push(text), new Promise<void>((resolve) => (finish = resolve))),
    abort: async () => {
      aborted += 1;
      finish();
    },
  };
  return { session: session as unknown as AgentSession, prompts, aborted: () => aborted };
}

describe("an agent's turn", () => {
  it("is ended where it is once the grace after its time is up too - without being told its time - then the harness takes it from there", async () => {
    const { session, prompts, aborted } = slowSession();
    timeTurns(session);
    const started = Date.now();
    const reply = await ask(session, "Fix the failing test.");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(aborted()).toBe(1);
    expect(prompts[0]).toBe("Fix the failing test.");
    expect(reply).toContain("[the turn was stopped: its 1 second were up]");
  });

  it("is ended at its next request to the model once its time is up, never in the middle of one - a request cut short is billed whole", async () => {
    const listeners: Array<(event: unknown) => void> = [];
    let finish: () => void = () => {};
    let aborted = 0;
    let requests = 0;
    const session = {
      subscribe(listener: (event: unknown) => void) {
        listeners.push(listener);
        return () => void listeners.splice(listeners.indexOf(listener), 1);
      },
      prompt: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
          // The model is answering past the limit; then, its answer in, the agent's next request starts.
          setTimeout(() => {
            requests += 1;
            for (const listener of [...listeners]) listener({ type: "message_end", message: { role: "assistant", stopReason: "toolUse" } });
            for (const listener of [...listeners]) listener({ type: "turn_start" });
          }, 1500);
        }),
      abort: async () => {
        aborted += 1;
        finish();
      },
    } as unknown as AgentSession;
    timeTurns(session);
    const reply = await ask(session, "Fix the failing test.");
    expect(requests).toBe(1);
    expect(aborted).toBe(1);
    expect(reply).toContain("[the turn was stopped: its 1 second were up]");
  });

  it("is not timed for a session a render did not start - the conversation, a skill's agent", async () => {
    const { session, prompts, aborted } = slowSession();
    const reply = ask(session, "Write the spec.");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(aborted()).toBe(0);
    expect(prompts[0]).toBe("Write the spec.");
    await session.abort();
    await reply;
  });
});

describe("a provider that fails for a moment", () => {
  /** A session whose provider answers with an error the first `failures` times, then replies. */
  function flakySession(failures: number, error = "503 This model is currently experiencing high demand.") {
    const listeners: Array<(event: unknown) => void> = [];
    const prompts: string[] = [];
    const session = {
      model: { id: "flaky" },
      subscribe(listener: (event: unknown) => void) {
        listeners.push(listener);
        return () => void listeners.splice(listeners.indexOf(listener), 1);
      },
      async prompt(text: string) {
        prompts.push(text);
        const failing = prompts.length <= failures;
        for (const listener of [...listeners]) {
          if (failing) listener({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: error } });
          else listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done." } });
        }
      },
      async abort() {},
    };
    return { session: session as unknown as AgentSession, prompts };
  }

  it("is waited out and the agent carries on - as a 503 of high demand once ended a whole run", async () => {
    const { session, prompts } = flakySession(2);
    expect(await ask(session, "Fix the failing test.")).toBe("Done.");
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toMatch(/^Carry on where you were: the model provider failed part-way through your last turn/);
  });

  it("does not fail a turn pi's own retry recovered - as a reviewer's verdict was once thrown away after Bedrock dropped its stream", async () => {
    const listeners: Array<(event: unknown) => void> = [];
    const prompts: string[] = [];
    const session = {
      model: { id: "bedrock" },
      subscribe(listener: (event: unknown) => void) {
        listeners.push(listener);
        return () => void listeners.splice(listeners.indexOf(listener), 1);
      },
      async prompt(text: string) {
        prompts.push(text);
        for (const event of [
          { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "Bedrock stream ended without a stop reason" } },
          { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "Bedrock stream ended without a stop reason" },
          { type: "auto_retry_end", success: true, attempt: 1 },
          { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Recorded." } },
          { type: "message_end", message: { role: "assistant", stopReason: "toolUse" } },
        ]) {
          for (const listener of [...listeners]) listener(event);
        }
      },
      async abort() {},
    };
    expect(await ask(session as unknown as AgentSession, "Review the work.")).toBe("Recorded.");
    expect(prompts).toEqual(["Review the work."]);
  });

  it("fails the run when it does not pass, or when the error is not one that passes", async () => {
    await expect(ask(flakySession(10).session, "Fix it.")).rejects.toThrow(/high demand/);
    const { session, prompts } = flakySession(1, "401 invalid API key");
    await expect(ask(session, "Fix it.")).rejects.toThrow(/invalid API key/);
    expect(prompts).toHaveLength(1);
  });
});

describe("the reasoning effort turri sends itself", () => {
  const luna = { api: "bedrock-converse-stream", id: "global.openai.gpt-6-luna", reasoning: true };
  it("goes to OpenAI's models on Bedrock as the session's thinking level - pi sends them none", async () => {
    const { withReasoningEffort } = await import("../src/pi.ts");
    expect(withReasoningEffort({ modelId: "x", additionalModelRequestFields: { a: 1 } }, luna, "high")).toEqual({ modelId: "x", additionalModelRequestFields: { a: 1, reasoning: { effort: "high" } } });
    expect(withReasoningEffort({}, luna, "max")).toEqual({ additionalModelRequestFields: { reasoning: { effort: "xhigh" } } });
    expect(withReasoningEffort({}, luna, "off")).toEqual({ additionalModelRequestFields: { reasoning: { effort: "none" } } });
  });
  it("leaves every other model's request as pi built it", async () => {
    const { withReasoningEffort } = await import("../src/pi.ts");
    const payload = { additionalModelRequestFields: { thinking: { type: "adaptive" } } };
    expect(withReasoningEffort(payload, { api: "bedrock-converse-stream", id: "eu.anthropic.claude-sonnet-5", reasoning: true }, "high")).toBe(payload);
    expect(withReasoningEffort(payload, { api: "google-generative-ai", id: "gemini-3.8-flash", reasoning: true }, "high")).toBe(payload);
  });
});
