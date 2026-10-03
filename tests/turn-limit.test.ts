import { describe, expect, it } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

process.env.TURRI_TURN_LIMIT = "1";
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
  it("is ended where it is when the time is up - without being told its time - then the harness takes it from there", async () => {
    const { session, prompts, aborted } = slowSession();
    timeTurns(session);
    const started = Date.now();
    const reply = await ask(session, "Fix the failing test.");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(aborted()).toBe(1);
    expect(prompts[0]).toBe("Fix the failing test.");
    expect(reply).toContain("[the turn was stopped: its 1 second were up]");
  });

  it("does not pay for waiting on its sandbox VM: the clock stops meanwhile, and runs on from where it was", async () => {
    const { offTheTurnClock } = await import("../src/grow/activity.ts");
    const { session, aborted } = slowSession();
    const prompt = session.prompt.bind(session);
    // A turn whose first command waits 1.5s for its VM - longer than the whole turn's 1 second - then works on.
    (session as unknown as { prompt: (text: string) => Promise<void> }).prompt = async (text: string) => {
      const working = prompt(text);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await offTheTurnClock(new Promise((resolve) => setTimeout(resolve, 1500)));
      await working;
    };
    timeTurns(session);
    const started = Date.now();
    const reply = await ask(session, "Fix the failing test.");
    const took = Date.now() - started;
    // Its 1 second is the 0.3s before the wait and 0.7s after it: stopped at about 2.5s, not at 1s.
    expect(took).toBeGreaterThanOrEqual(2400);
    expect(took).toBeLessThan(4000);
    expect(aborted()).toBe(1);
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

  it("fails the run when it does not pass, or when the error is not one that passes", async () => {
    await expect(ask(flakySession(10).session, "Fix it.")).rejects.toThrow(/high demand/);
    const { session, prompts } = flakySession(1, "401 invalid API key");
    await expect(ask(session, "Fix it.")).rejects.toThrow(/invalid API key/);
    expect(prompts).toHaveLength(1);
  });
});
