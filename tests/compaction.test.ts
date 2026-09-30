import { describe, expect, it } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { compactIfDue, keepCompacted } from "../src/pi.ts";

/** A session as compaction sees it: how big its context is, its instructions, and compact itself. */
function session(tokens: number | null, systemPrompt = "") {
  const compacted: string[] = [];
  const stub = {
    systemPrompt,
    getContextUsage: () => ({ tokens, contextWindow: 1_000_000, percent: null }),
    compact: async (instructions?: string) => {
      compacted.push(instructions ?? "");
      return { summary: "s", firstKeptEntryId: "e", tokensBefore: tokens ?? 0, estimatedTokensAfter: 20_000 };
    },
  };
  return { stub: stub as unknown as AgentSession, compacted };
}

describe("compacting an agent's work between turns", () => {
  it("sums up the work once the conversation passes the threshold, with what its role has to keep", async () => {
    const { stub, compacted } = session(150_000);
    keepCompacted(stub, { instructions: "Keep every problem raised.", atTokens: 100_000 });
    expect(await compactIfDue(stub)).toBe(true);
    expect(compacted).toEqual(["Keep every problem raised."]);
  });

  it("counts only the conversation: instructions however long are never what makes it compact", async () => {
    // 120k tokens in all, 40k of them the task in the system prompt: 80k of work, under the threshold.
    const { stub, compacted } = session(120_000, "x".repeat(160_000));
    keepCompacted(stub, { instructions: "Keep it.", atTokens: 100_000 });
    expect(await compactIfDue(stub)).toBe(false);
    expect(compacted).toEqual([]);
  });

  it("leaves alone a session under the threshold, one whose size is not known, and one never given a compaction", async () => {
    const under = session(50_000);
    keepCompacted(under.stub, { instructions: "Keep it.", atTokens: 100_000 });
    expect(await compactIfDue(under.stub)).toBe(false);
    const unknown = session(null);
    keepCompacted(unknown.stub, { instructions: "Keep it.", atTokens: 100_000 });
    expect(await compactIfDue(unknown.stub)).toBe(false);
    const fresh = session(900_000);
    expect(await compactIfDue(fresh.stub)).toBe(false);
    expect([...under.compacted, ...unknown.compacted, ...fresh.compacted]).toEqual([]);
  });

  it("goes on as it was when compacting fails", async () => {
    const { stub } = session(150_000);
    (stub as unknown as { compact: () => Promise<never> }).compact = async () => {
      throw new Error("the provider is down");
    };
    keepCompacted(stub, { instructions: "Keep it.", atTokens: 100_000 });
    expect(await compactIfDue(stub)).toBe(false);
  });
});
