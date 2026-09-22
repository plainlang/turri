import { describe, expect, it } from "vitest";
import { createLiveReviewer, type JudgePass } from "../../src/review/live.ts";

const SPEC = { rubric: "live.md", judges: 1, judgeTools: ["read"] };

function reviewer(judge: JudgePass, onPass?: (r: { scope: string; findings: number }) => void) {
  return createLiveReviewer({ cwd: "/tmp", spec: SPEC, rubric: "RUBRIC", judge, onPass });
}

const pass: JudgePass = async () => ({ verdict: "pass", violations: [] });

const fail = (criterion: string): JudgePass => async () => ({
  verdict: "fail",
  violations: [{ criterion, evidence: "the text", fix: "do this" }],
});

/** A judge that does not resolve until released, so overlap can be observed. */
function gatedJudge() {
  let release: (() => void) | undefined;
  let running = 0;
  let peak = 0;
  const prompts: string[] = [];
  const judge: JudgePass = async (prompt) => {
    prompts.push(prompt);
    running += 1;
    peak = Math.max(peak, running);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    running -= 1;
    return { verdict: "pass", violations: [] };
  };
  return { judge, prompts, release: () => release?.(), peak: () => peak };
}

describe("createLiveReviewer", () => {
  it("reports nothing when the pass is clean", async () => {
    const live = reviewer(pass);
    live.notice("functionality 1");
    expect(await live.settle()).toEqual({ clean: true, findings: [] });
    expect(live.take()).toEqual([]);
  });

  it("hands findings over once, between questions", async () => {
    const live = reviewer(fail("≤200 LOC"));
    live.notice("functionality 1");
    await live.settle();

    const findings = live.take();
    expect(findings).toEqual([
      { scope: "functionality 1", criterion: "≤200 LOC", evidence: "the text", fix: "do this" },
    ]);
    expect(live.take()).toEqual([]);
    expect(live.history()).toHaveLength(1);
  });

  it("runs one pass at a time and coalesces the ones queued behind it", async () => {
    const gated = gatedJudge();
    const live = reviewer(gated.judge);

    live.notice("functionality 1");
    live.notice("functionality 2");
    live.notice("functionality 3");
    expect(gated.peak()).toBe(1);

    gated.release();
    await new Promise((r) => setTimeout(r, 0));
    gated.release();
    await live.settle();

    // Three writes, two passes: the first, and one covering everything that landed while
    // it ran - named by the newest, since the file is read as it stands.
    expect(live.passes()).toBe(2);
    expect(gated.prompts[1]).toContain("functionality 3");
    expect(gated.peak()).toBe(1);
  });

  it("does not re-report what it already cleared", async () => {
    const seen: string[] = [];
    const live = reviewer(async (prompt) => {
      seen.push(prompt);
      return { verdict: "pass", violations: [] };
    });
    live.notice("functionality 1");
    await live.settle();
    live.notice("functionality 2");
    await live.settle();
    expect(seen[1]).toContain("already cleared");
    expect(seen[1]).toContain("functionality 1");
  });

  it("carries the user's answer into the next pass", async () => {
    const seen: string[] = [];
    let first = true;
    const live = reviewer(async (prompt) => {
      seen.push(prompt);
      if (first) {
        first = false;
        return {
          verdict: "fail",
          violations: [{ criterion: "consistent", evidence: "x", fix: "decide" }],
          question: "Should an empty title be rejected?",
        };
      }
      return { verdict: "pass", violations: [] };
    });

    live.notice("functionality 1");
    await live.settle();
    live.take();

    const questions = live.takeQuestions();
    expect(questions).toHaveLength(1);
    expect(live.takeQuestions()).toEqual([]);
    expect(live.reply(questions[0]!.id, "Reject it with a 400")).toBe(true);
    expect(live.reply("q99", "nonsense")).toBe(false);

    live.notice("functionality 2");
    await live.settle();
    expect(seen[1]).toContain("Reject it with a 400");
  });

  it("stays out of the way when a pass throws", async () => {
    const live = reviewer(async () => {
      throw new Error("provider exploded");
    });
    live.notice("functionality 1");
    expect(await live.settle()).toEqual({ clean: true, findings: [] });
  });

  it("settles anything still in flight before the gate reads it", async () => {
    const gated = gatedJudge();
    const live = reviewer(gated.judge);
    live.notice("functionality 1");

    let settled = false;
    const settling = live.settle().then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);

    gated.release();
    expect((await settling).clean).toBe(true);
  });

  it("tells the progress display about every pass", async () => {
    const passes: Array<{ scope: string; findings: number }> = [];
    const live = reviewer(fail("order"), (r) => passes.push(r));
    live.notice("functionality 4");
    await live.settle();
    expect(passes).toEqual([{ scope: "functionality 4", findings: 1 }]);
  });
});
