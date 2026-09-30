import { describe, expect, it } from "vitest";
import type { MarshalledPlainSource } from "../../src/plain/spec.ts";
import { checkDraft, findJob, masterPrompt, netChanges, propose, reworkQueue, untouched, type MasterInput, type QueueMasterAgent } from "../../src/render/queue-master.ts";
import { summarizeDiff } from "../../src/render/job-panel.ts";
import { serializeTree } from "../../src/render/spec-steps.ts";

const item = (markdown: string) => ({ markdown });
const tree = (specs: string[], definitions: string[] = []): MarshalledPlainSource =>
  ({ definitions: definitions.map(item), "functional specs": specs.map(item) }) as MarshalledPlainSource;

/**
 * Built: one functional spec. Queued: job 1 adds comments, job 2 adds profiles. Then a new change
 * deletes profiles again - the spec now has only comments on top of what is built.
 */
const built = tree(["- Users sign up."]);
const afterJob1 = tree(["- Users sign up.", "- Users comment on sessions."]);
const afterJob2 = tree(["- Users sign up.", "- Users comment on sessions.", "- Users have a profile page."]);
const now = tree(["- Users sign up.", "- Users comment on sessions."]);

const story = (): MasterInput => ({
  base: built,
  previous: afterJob2,
  current: now,
  queued: [
    { jobId: "job1", title: "comments", tree: afterJob1, textDiff: "+- Users comment on sessions." },
    { jobId: "job2", title: "profiles", tree: afterJob2, textDiff: "+- Users have a profile page." },
    { jobId: "job3", title: "no profiles after all", tree: now, textDiff: "-- Users have a profile page." },
  ],
  specFile: "backend.plain",
  specText: "***functional specs***\n\n- Users sign up.\n- Users comment on sessions.\n",
});

describe("the queue master's proposal", () => {
  it("leaves a job the new change undid with nothing to do - job 2 added profiles, the new change removed them", () => {
    const draft = propose(story());
    expect(draft.map((job) => [job.jobId, job.changes])).toEqual([
      ["job1", ["c1"]],
      ["job2", []],
      ["job3", []],
    ]);
    // It does not check as it is: the jobs left with nothing have to go.
    expect(checkDraft(story(), draft).join("\n")).toContain('"profiles" makes no change');
  });
});

describe("conformance tests in the queue", () => {
  it("are turned off for every job at once, and cannot be turned on where the config or the spec has none", async () => {
    const results: string[] = [];
    const queued = story().queued.map((job) => ({ ...job, conformance: true }));
    const plan = await reworkQueue({
      input: { ...story(), queued, instruction: "no conformance tests", conformanceAvailable: false },
      agent: async (_input, tools) => {
        results.push(tools.setConformance(["all"], false, "as asked"));
        results.push(tools.setConformance(["1"], true, "try"));
        tools.deleteJob("job2", "undone");
        tools.deleteJob("job3", "undone");
        tools.commit("Conformance off.");
      },
    });
    expect(results[0]).toContain("conformance jobs are cancelled");
    expect(results[1]).toContain("cannot be turned on here");
    expect(plan.by).toBe("master");
    expect(plan.jobs.map((job) => job.conformance)).toEqual([false]);
  });
});

describe("the running job", () => {
  /** Built: sign up. Running: the profile page. New: the profile page is dropped - the spec now has the feed instead. */
  const signUp = "- Users sign up.";
  const profile = "- Users have a profile page with their sessions and counts.";
  const feed = "- Users see a feed of the sessions of the users they follow.";
  const running = { jobId: "run1", title: "profile page", tree: tree([signUp, profile]), textDiff: `+${profile}` };
  const input = (): MasterInput => ({
    base: tree([signUp, profile]),
    built: tree([signUp]),
    running,
    previous: tree([signUp, profile]),
    current: tree([signUp, feed]),
    queued: [{ jobId: "new1", title: "feed instead", tree: tree([signUp, feed]), textDiff: "" }],
    specFile: "app.plain",
    specText: "",
  });

  it("is not added on top when the new change undoes what it builds - the master is asked", () => {
    expect(untouched(input())).toBe(false);
    const onTop: MasterInput = { ...input(), current: tree([signUp, profile, feed]), queued: [{ jobId: "new1", title: "feed", tree: tree([signUp, profile, feed]), textDiff: "" }] };
    expect(untouched(onTop)).toBe(true);
  });

  it("can be stopped: the work is numbered again from what is built, and it comes back as the first job", async () => {
    let said = "";
    const plan = await reworkQueue({
      input: input(),
      agent: async (_input, tools) => {
        said = tools.stopRunning("the new change drops the profile page it builds");
        const [stopped] = tools.draft();
        expect(stopped).toMatchObject({ jobId: "run1", changes: [] });
        tools.deleteJob("run1", "its page is gone");
        expect(tools.commit("Stopped the profile page: the change dropped it.").ok).toBe(true);
      },
    });
    expect(said).toContain("Job run1 is to be stopped");
    expect(plan.stopRunning).toEqual({ jobId: "run1", reason: "the new change drops the profile page it builds" });
    expect(serializeTree(plan.base)).toBe(serializeTree(tree([signUp])));
    expect(plan.jobs.map((job) => job.jobId)).toEqual(["new1"]);
    expect(serializeTree(plan.jobs[0]!.step.tree)).toBe(serializeTree(tree([signUp, feed])));
  });

  it("goes on when the master stops it but commits nothing after - a stop counts only with a queue", async () => {
    const plan = await reworkQueue({ input: input(), agent: async (_input, tools) => void tools.stopRunning("maybe") });
    expect(plan.stopRunning).toBeUndefined();
    expect(serializeTree(plan.base)).toBe(serializeTree(tree([signUp, profile])));
  });
});

describe("a job the master names", () => {
  it("is its place before it is the start of an id - ids are hex, and one can begin with 2", () => {
    const draft = [
      { jobId: "2f9c41aa", title: "comments", reason: "", changes: [] },
      { jobId: "b07e3d12", title: "profiles", reason: "", changes: [] },
    ];
    expect(findJob(draft, "2")).toBe(1);
    expect(findJob(draft, "#1")).toBe(0);
    expect(findJob(draft, "job 2")).toBe(1);
    expect(findJob(draft, "2f9c41aa")).toBe(0);
    expect(findJob(draft, "b07e")).toBe(1);
    expect(findJob(draft, "profiles")).toBe(1);
    expect(findJob(draft, "3")).toBe(-1);
  });
});

describe("a new change that touches nothing queued", () => {
  it("is only added on top - nothing to rework, so no agent is asked - while one that undoes a queued job is not", () => {
    const extra = tree(["- Users sign up.", "- Users comment on sessions.", "- Users have a profile page.", "- Users give kudos."]);
    const onTop: MasterInput = { ...story(), previous: afterJob2, current: extra, queued: [...story().queued.slice(0, 2), { jobId: "job3", title: "kudos", tree: extra, textDiff: "" }] };
    expect(untouched(onTop)).toBe(true);
    expect(untouched(story())).toBe(false);
  });
});

describe("a queued job's change, edited since", () => {
  it("stays that job's - a later change takes a link out of the nav bar the first job adds", () => {
    const nav = "- The nav bar has the links `Feed`, `Search` and `My profile`.";
    const navNow = "- The nav bar has the links `Feed` and `Search`.";
    const input: MasterInput = {
      base: built,
      previous: tree(["- Users sign up.", nav, "- Users have a profile page."]),
      current: tree(["- Users sign up.", navNow]),
      queued: [
        { jobId: "nav", title: "nav bar", tree: tree(["- Users sign up.", nav]), textDiff: "" },
        { jobId: "profile", title: "profile page", tree: tree(["- Users sign up.", nav, "- Users have a profile page."]), textDiff: "" },
        { jobId: "drop", title: "no profile", tree: tree(["- Users sign up.", navNow]), textDiff: "" },
      ],
      specFile: "frontend.plain",
      specText: "",
    };
    expect(propose(input).map((job) => [job.jobId, job.changes.length])).toEqual([
      ["nav", 1],
      ["profile", 0],
      ["drop", 0],
    ]);
  });
});

describe("the queue master", () => {
  it("deletes the job a new change undoes - the queue shrinks, and still ends on the spec as it is now", async () => {
    const master: QueueMasterAgent = async (_input, tools) => {
      // The new change removes the profile page that job 2 adds: both go.
      expect(tools.deleteJob("job2", "the new change removes the profile page it adds")).toContain("Deleted");
      expect(tools.deleteJob("job3", "it only undid job 2")).toContain("Deleted");
      expect(tools.commit("Deleted job 2: the new change removed the profile page it added.").ok).toBe(true);
    };
    const plan = await reworkQueue({ input: story(), agent: master });
    expect(plan.by).toBe("master");
    expect(plan.jobs.map((job) => job.jobId)).toEqual(["job1"]);
    expect(serializeTree(plan.jobs[0]!.step.tree)).toBe(serializeTree(now));
    expect(plan.summary).toContain("Deleted job 2");
  });

  it("is held to where the queue ends: a draft that drops a change, doubles one or breaks the spec is refused, with why", async () => {
    const problems: string[][] = [];
    const master: QueueMasterAgent = async (_input, tools) => {
      tools.rewriteJob("job1", { changes: [] });
      problems.push(tools.commit("dropped comments").problems);
      tools.rewriteJob("job1", { changes: ["c1"] });
      tools.rewriteJob("job2", { changes: ["c1"] });
      problems.push(tools.commit("comments twice").problems);
    };
    const plan = await reworkQueue({ input: story(), agent: master });
    expect(problems[0]!.join("\n")).toContain("No job makes c1");
    expect(problems[1]!.join("\n")).toContain("c1 is in more than one job");
    // It never committed one that checks: the harness takes the whole change as one job, which always does.
    expect(plan.by).toBe("fallback");
    expect(plan.jobs).toHaveLength(1);
    expect(serializeTree(plan.jobs[0]!.step.tree)).toBe(serializeTree(now));
  });

  it("merges, reorders and inserts - and a job that uses what a later one defines is refused", async () => {
    const base = tree(["- Users sign up."]);
    const current = tree(["- Users sign up.", "- A :Badge: is shown on a profile."], ["- :Badge: is an award."]);
    const input: MasterInput = {
      base,
      previous: base,
      current,
      queued: [{ jobId: "new", title: "badges", tree: current, textDiff: "" }],
      specFile: "backend.plain",
      specText: "",
    };
    const ids = netChanges(base, current).map((change) => change.id);
    expect(ids).toHaveLength(2);
    let refused: string[] = [];
    const master: QueueMasterAgent = async (_input, tools) => {
      // The functional spec first, the definition it uses after it: that does not hold together.
      tools.rewriteJob("new", { changes: [] });
      tools.insertJob({ title: "badge spec", reason: "", changes: [ids[1]!], position: 1 });
      tools.insertJob({ title: "badge concept", reason: "", changes: [ids[0]!], position: 2 });
      tools.deleteJob("badges", "split into two");
      refused = tools.commit("split").problems;
      // Put the definition first, then merge them into one.
      tools.reorderJobs(["badge concept", "badge spec"]);
      tools.mergeJobs(["badge concept", "badge spec"], "badges", "they belong together");
      expect(tools.commit("merged").ok).toBe(true);
    };
    const plan = await reworkQueue({ input, agent: master });
    expect(refused.join("\n")).toMatch(/does not hold together|a later job defines/);
    expect(plan.by).toBe("master");
    expect(plan.jobs.map((job) => job.title)).toEqual(["badges"]);
    expect(serializeTree(plan.jobs[0]!.step.tree)).toBe(serializeTree(current));
  });

  it("takes the harness's proposal when the master commits nothing and the proposal checks - each queued job as it was", async () => {
    const extra = tree(["- Users sign up.", "- Users comment on sessions.", "- Users follow each other."]);
    const input: MasterInput = { ...story(), previous: afterJob1, current: extra, queued: [story().queued[0]!, { jobId: "job2", title: "following", tree: extra, textDiff: "" }] };
    const plan = await reworkQueue({ input, agent: async () => {} });
    expect(plan.by).toBe("proposal");
    expect(plan.jobs.map((job) => job.jobId)).toEqual(["job1", "job2"]);
    expect(serializeTree(plan.jobs.at(-1)!.step.tree)).toBe(serializeTree(extra));
  });

  it("asks the person when it is not sure", async () => {
    const asked: string[] = [];
    const master: QueueMasterAgent = async (_input, tools) => {
      const answer = await tools.askPerson("Should the profile page go, or only move?");
      expect(answer).toBe("It goes.");
      tools.deleteJob("job2", answer);
      tools.deleteJob("job3", answer);
      tools.commit("asked");
    };
    await reworkQueue({ input: story(), agent: master, askPerson: async (question) => (asked.push(question), "It goes.") });
    expect(asked).toEqual(["Should the profile page go, or only move?"]);
  });
});

describe("the queue master's prompt", () => {
  const prompt = masterPrompt(story(), propose(story()));

  it("says how to read each block that follows", () => {
    expect(prompt).toContain("How to read what follows.");
    for (const block of ["<the new change>", "<the queue>", "<the changes>", "<the draft>", "<the spec now>"]) expect(prompt).toContain(`- ${block}:`);
  });

  it("tells the new change and every queued job section by section, as the coding agents are told, not as raw diffs", () => {
    expect(prompt).toContain('<the new change - the spec before it to the spec now>\n<functional specs change="1 removed">\nRemoved:\n  - Users have a profile page.\n</functional specs>');
    expect(prompt).toContain('job 1 (job1) · comments · no conformance tests\n<functional specs change="1 added">\nAdded:\n  functionality 2:\n  - Users comment on sessions.\n</functional specs>');
    expect(prompt).not.toContain("+- Users comment on sessions.");
  });
});

describe("a job's one-line title", () => {
  it("says what a change that only takes lines out takes out", () => {
    expect(summarizeDiff("--- a/app.plain\n+++ b/app.plain\n@@ -3,2 +3,0 @@\n-- :ProfilePage: is the page at `/u/<handle>`.\n-")).toBe("app.plain +0 −2 · removes: :ProfilePage: is the page at `/u/<handle>`.");
  });
});

