import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MarshalledPlainSource } from "../plain/spec.ts";
import { validateConcepts } from "../plain/concepts.ts";
import { ask, createExecutor } from "../pi.ts";
import {
  applyChanges,
  changesBetween,
  describeChange,
  diffSpecText,
  inconsistencies,
  layoutOf,
  makeStep,
  parseTree,
  serializeTree,
  similarity,
  treeText,
  type SpecChange,
  type SpecStep,
} from "./spec-steps.ts";

/**
 * The queue master: what the spec diffs queued for a codebase become when a new change comes in.
 *
 * Every spec change is written to the .plain files at once and queued as a render spec diff job. So
 * the queue is a sequence of edits of the same files, and it can go stale: a later change can undo
 * an earlier one, fix it, or depend on it. When a new change is submitted, the queue master - an
 * agent - is told. It knows the spec as it was before the change, and sees the spec as it is now, so
 * it sees exactly what changed; it has the queue, every job's change in it; and it reworks the queue
 * as it sees fit: deletes a job the change undoes, merges two, reorders them, rewrites one, inserts
 * one.
 *
 * What it can never change is where the queue ends. The work is measured from what the code will be
 * built from when the queue reaches it - the running spec diff's spec, or else the code's own tree -
 * to the spec as it is now, as a set of changes, each numbered. Every job the master leaves is a set
 * of those changes; the harness builds its diff and its spec from them, and checks, before anything
 * changes: every change is in exactly one job, and applying the jobs in order, one after the other,
 * leaves a spec that holds together after each and ends exactly on the .plain files as they are.
 */

/** A queued spec diff job, as the master sees it: its change, and the spec it leaves. */
export interface QueuedDiff {
  jobId: string;
  title: string;
  /** The spec this job leaves, as its render would build it. */
  tree: MarshalledPlainSource;
  /** Its change, as the job renders it. */
  textDiff: string;
}

/** One job of the reworked queue: a title, why, and the changes it makes. `jobId` is the queued job it came from, if any. */
export interface DraftJob {
  title: string;
  reason: string;
  changes: string[];
  jobId?: string;
}

export interface MasterInput {
  /** What the person asked of the queue, when they asked the master themselves - not a new change. */
  instruction?: string;
  /** What the code will be built from when the first queued job runs. */
  base: MarshalledPlainSource;
  /** The spec as it was before this change - as the master last saw it. */
  previous: MarshalledPlainSource;
  /** The spec as it is now, in the .plain files. */
  current: MarshalledPlainSource;
  /** The queued spec diff jobs, in the order they run - the new change's own job last. */
  queued: QueuedDiff[];
  /** The module's .plain file, as the diffs name it, and its text - for the diffs' layout. */
  specFile: string;
  specText: string;
}

/** What the queue becomes: each job's title, reason, the job it came from, and its step - its diff and the spec it leaves. */
export interface MasterPlan {
  jobs: Array<DraftJob & { step: SpecStep }>;
  /** What the master said it did, and why - for the person. */
  summary: string;
  /** How the plan was reached: the master's, the harness's first proposal, or one job for the whole change. */
  by: "master" | "proposal" | "fallback";
}

/** The work the queue does: every change from the base to the spec as it is now, numbered. */
export function netChanges(base: MarshalledPlainSource, current: MarshalledPlainSource): SpecChange[] {
  return changesBetween(serializeTree(base), serializeTree(current));
}

/** Two changes are the same change when they do the same to the same item. */
function sameChange(a: SpecChange, b: SpecChange): boolean {
  return a.section === b.section && a.kind === b.kind && (a.before ?? "") === (b.before ?? "") && (a.after ?? "") === (b.after ?? "");
}

/**
 * Whether the new change leaves every queued job as it is: each job's own changes still all part of
 * the work, as they were queued, and the new job's are all that is left. So there is nothing to
 * rework - a new feature added on top of the queue - and no agent is asked.
 */
export function untouched(input: MasterInput): boolean {
  const net = netChanges(input.base, input.current);
  let before = serializeTree(input.base);
  let count = 0;
  const taken = new Set<string>();
  for (const job of input.queued) {
    const after = serializeTree(job.tree);
    const own = changesBetween(before, after);
    before = after;
    for (const mine of own) {
      const match = net.find((change) => !taken.has(change.id) && sameChange(mine, change));
      if (match === undefined) return false;
      taken.add(match.id);
      count += 1;
    }
  }
  return count === net.length;
}

/** Alike enough to be one item, edited since: a queued job's own change that a later one rewrote. */
const EDITED = 0.5;

/** What a change leaves, or takes out: the item as it is after it, or as it was before. */
const itemOf = (change: SpecChange) => change.after ?? change.before ?? "";

/**
 * The harness's first proposal: each queued job keeps the changes of its own that are still part of
 * the work - as they were queued, or edited since: a job adds the nav bar, a later change takes a
 * link out of it, and the nav bar as it is now is still that job's - and the new change's job takes
 * the rest. A job whose changes the new one undid is left with none - the master sees that, and
 * decides.
 */
export function propose(input: MasterInput): DraftJob[] {
  const net = netChanges(input.base, input.current);
  const taken = new Set<string>();
  let before = serializeTree(input.base);
  const owns = input.queued.map((job) => {
    const after = serializeTree(job.tree);
    const own = changesBetween(before, after);
    before = after;
    return own;
  });
  const jobs: DraftJob[] = input.queued.map((job, index) => {
    const isNew = index === input.queued.length - 1;
    const changes = net.filter((change) => !taken.has(change.id) && owns[index]!.some((mine) => sameChange(mine, change))).map((change) => change.id);
    changes.forEach((id) => taken.add(id));
    return { title: job.title, reason: isNew ? "the new change" : "as it was queued", changes, jobId: job.jobId };
  });
  // A change no job made as it is, but one made an item it is like - edited since - goes back to that job, the first most like it.
  for (const change of net) {
    if (taken.has(change.id)) continue;
    let best: { index: number; score: number } | undefined;
    owns.slice(0, -1).forEach((own, index) => {
      for (const mine of own) {
        if (mine.section !== change.section || (mine.kind === "remove") !== (change.kind === "remove")) continue;
        const score = similarity(itemOf(mine), itemOf(change));
        if (score >= EDITED && (best === undefined || score > best.score)) best = { index, score };
      }
    });
    if (best === undefined) continue;
    const job = jobs[best.index]!;
    // In the order the changes come: the job's own, then this one where it falls among them.
    job.changes = net.filter((item) => job.changes.includes(item.id) || item.id === change.id).map((item) => item.id);
    taken.add(change.id);
  }
  // Whatever no job's own change is - the new change's, or one that only the whole brings about - goes with the new job.
  const rest = net.filter((change) => !taken.has(change.id)).map((change) => change.id);
  if (jobs.length > 0) jobs[jobs.length - 1]!.changes.push(...rest);
  return jobs;
}

/**
 * What is wrong with a reworked queue, or nothing: every change in exactly one job, no job without
 * one, and each job, applied after the ones before it, leaving a spec that holds together - the last
 * exactly the spec as it is now.
 */
export function checkDraft(input: MasterInput, draft: DraftJob[]): string[] {
  const net = netChanges(input.base, input.current);
  const byId = new Map(net.map((change) => [change.id, change]));
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const job of draft) {
    if (job.changes.length === 0) problems.push(`"${job.title}" makes no change - delete it, or give it changes.`);
    for (const id of job.changes) {
      if (!byId.has(id)) problems.push(`"${job.title}" names ${id}, which is not one of the changes.`);
      else if (seen.has(id)) problems.push(`${id} is in more than one job - "${job.title}" and an earlier one.`);
      seen.add(id);
    }
  }
  const missing = net.filter((change) => !seen.has(change.id)).map((change) => change.id);
  if (missing.length > 0) problems.push(`No job makes ${missing.join(", ")} - every change has to be made, or the queue does not end on the spec as it is now.`);
  if (problems.length > 0) return problems;

  const base = serializeTree(input.base);
  const endpoints = new Set([...validateConcepts(input.base), ...validateConcepts(input.current)]);
  const sofar: SpecChange[] = [];
  for (const job of draft) {
    sofar.push(...job.changes.map((id) => byId.get(id)!));
    const wrong = inconsistencies(parseTree(applyChanges(base, sofar)), endpoints);
    if (wrong.length > 0) {
      problems.push(`After "${job.title}" the spec does not hold together - a later job defines what it uses:\n${wrong.map((error) => `  - ${error}`).join("\n")}`);
      return problems;
    }
  }
  if (applyChanges(base, sofar) !== serializeTree(input.current)) {
    problems.push("Applied in order, the jobs do not end exactly on the spec as it is now.");
  }
  return problems;
}

/** A checked draft, as the queue runs it: each job's diff and the spec it leaves. */
export function stepsOf(input: MasterInput, draft: DraftJob[]): Array<DraftJob & { step: SpecStep }> {
  const byId = new Map(netChanges(input.base, input.current).map((change) => [change.id, change]));
  const layout = layoutOf(input.specText);
  let before = serializeTree(input.base);
  const sofar: SpecChange[] = [];
  return draft.map((job) => {
    const changes = job.changes.map((id) => byId.get(id)!);
    sofar.push(...changes);
    const after = applyChanges(serializeTree(input.base), sofar);
    const step = makeStep(job.title, job.reason, changes, before, after, input.specFile, layout);
    before = after;
    return { ...job, step };
  });
}

/** The tools the master reworks the queue with - on a draft the harness checks before it takes. */
export interface MasterTools {
  draft(): DraftJob[];
  deleteJob(job: string, reason: string): string;
  mergeJobs(jobs: string[], title: string, reason: string): string;
  reorderJobs(order: string[]): string;
  rewriteJob(job: string, change: { title?: string; reason?: string; changes?: string[] }): string;
  insertJob(job: { title: string; reason: string; changes: string[]; position: number }): string;
  askPerson(question: string): Promise<string>;
  /** Check the draft and take it, or say what is wrong with it. */
  commit(summary: string): { ok: boolean; problems: string[] };
}

/** The master itself: works on the tools until it commits. Injectable, so the queue can be tested without a model. */
export type QueueMasterAgent = (input: MasterInput, tools: MasterTools, prompt: string) => Promise<void>;

/**
 * A job named by the master: its id, its place in the draft from 1, the start of its id, or its
 * title - in that order. Ids are hex, so "2" could begin one: a number is a place before it is the
 * start of an id, and a start of an id is at least four characters.
 */
export function findJob(draft: DraftJob[], name: string): number {
  const trimmed = name.trim().replace(/^job\s+/i, "");
  const exact = draft.findIndex((job) => job.jobId === trimmed);
  if (exact !== -1) return exact;
  const position = Number(trimmed.replace(/^#/, ""));
  if (/^#?\d+$/.test(trimmed) && position >= 1 && position <= draft.length) return position - 1;
  if (trimmed.length >= 4) {
    const byId = draft.findIndex((job) => job.jobId !== undefined && job.jobId.startsWith(trimmed));
    if (byId !== -1) return byId;
  }
  return draft.findIndex((job) => job.title === trimmed);
}

/**
 * Rework the queue: the master works on a draft of it, seeded with the harness's proposal, and
 * commits it; the harness takes only a draft that checks. If the master never commits one that does,
 * the proposal is taken if it checks, and otherwise the whole change as one job - which always does.
 */
export async function reworkQueue(options: {
  input: MasterInput;
  agent: QueueMasterAgent;
  askPerson?: (question: string) => Promise<string | undefined>;
}): Promise<MasterPlan> {
  const { input } = options;
  const proposal = propose(input);
  let draft: DraftJob[] = proposal.map((job) => ({ ...job, changes: [...job.changes] }));
  let committed: { draft: DraftJob[]; summary: string } | undefined;

  const tools: MasterTools = {
    draft: () => draft.map((job) => ({ ...job, changes: [...job.changes] })),
    deleteJob(name, reason) {
      const at = findJob(draft, name);
      if (at === -1) return `No job "${name}" in the draft.`;
      const job = draft[at]!;
      if (job.changes.length > 0) return `"${job.title}" still makes ${job.changes.join(", ")}: move them to another job with rewrite_job first, or merge it instead.`;
      draft = draft.filter((_, index) => index !== at);
      return `Deleted "${job.title}": ${reason}`;
    },
    mergeJobs(names, title, reason) {
      const at = names.map((name) => findJob(draft, name));
      if (at.some((index) => index === -1)) return `Not every one of ${names.join(", ")} is in the draft.`;
      const first = Math.min(...at);
      const merged: DraftJob = { title, reason, changes: at.sort((a, b) => a - b).flatMap((index) => draft[index]!.changes), jobId: draft[first]!.jobId };
      draft = draft.flatMap((job, index) => (index === first ? [merged] : at.includes(index) ? [] : [job]));
      return `Merged into "${title}", where the first of them was.`;
    },
    reorderJobs(order) {
      const at = order.map((name) => findJob(draft, name));
      if (at.some((index) => index === -1) || new Set(at).size !== draft.length || at.length !== draft.length) {
        return `Name every job of the draft once, in the new order - it has ${draft.length}.`;
      }
      draft = at.map((index) => draft[index]!);
      return `Reordered: ${draft.map((job) => job.title).join(" → ")}.`;
    },
    rewriteJob(name, change) {
      const at = findJob(draft, name);
      if (at === -1) return `No job "${name}" in the draft.`;
      const job = draft[at]!;
      draft[at] = { ...job, ...(change.title !== undefined ? { title: change.title } : {}), ...(change.reason !== undefined ? { reason: change.reason } : {}), ...(change.changes !== undefined ? { changes: [...change.changes] } : {}) };
      return `Rewrote "${draft[at]!.title}": ${draft[at]!.changes.join(", ") || "no changes"}.`;
    },
    insertJob(job) {
      const position = Math.max(1, Math.min(draft.length + 1, Math.round(job.position)));
      draft = [...draft.slice(0, position - 1), { title: job.title, reason: job.reason, changes: [...job.changes] }, ...draft.slice(position - 1)];
      return `Inserted "${job.title}" as job ${position}.`;
    },
    async askPerson(question) {
      const answer = await options.askPerson?.(question);
      return answer === undefined || answer.trim() === "" ? "(no answer - decide yourself, and keep to what the person asked for)" : answer;
    },
    commit(summary) {
      const problems = checkDraft(input, draft);
      if (problems.length === 0) committed = { draft: tools.draft(), summary };
      return { ok: problems.length === 0, problems };
    },
  };

  try {
    await options.agent(input, tools, masterPrompt(input, proposal));
  } catch {
    // The master's failing is not the queue's: the proposal, or the whole change as one job, still is.
  }
  if (committed !== undefined) return { jobs: stepsOf(input, committed.draft), summary: committed.summary, by: "master" };
  if (checkDraft(input, proposal).length === 0) return { jobs: stepsOf(input, proposal), summary: "The queue master committed no queue; the queue runs as proposed.", by: "proposal" };
  const whole: DraftJob[] = [{ title: input.queued.at(-1)?.title ?? "The spec change", reason: "the whole of the queued change, in one job", changes: netChanges(input.base, input.current).map((change) => change.id), jobId: input.queued[0]?.jobId }];
  return { jobs: whole[0]!.changes.length === 0 ? [] : stepsOf(input, whole), summary: "The queue master committed no queue that checks; the whole change runs as one job.", by: "fallback" };
}

export function masterPrompt(input: MasterInput, proposal: DraftJob[]): string {
  const net = netChanges(input.base, input.current);
  const change = diffSpecText(serializeTree(input.previous), serializeTree(input.current), input.specFile, layoutOf(input.specText));
  const byId = new Map(net.map((item) => [item.id, item]));
  return [
    "You are the queue master of a codebase's render queue. Each spec change is written to the .plain files at once and",
    "queued as a job that renders it into the code; the jobs run one after the other. A new change has just been made. Work",
    "out how it fits into what is queued, and rework the queue so it builds what the spec now says with no wasted work.",
    "",
    "What you can do, on a draft of the queue: delete a job (a change the new one undoes), merge jobs (a fix to a queued",
    "change goes with it), reorder them (what another relies on goes first), rewrite one (its title, or which changes it",
    "makes), insert one. Ask the person when you are not sure what they meant. Then commit the queue.",
    "",
    "The one rule: the work is the changes below, c1, c2, ... - everything from what the code will be built from to the",
    "spec as the .plain files have it now. Every change is in exactly one job; a job makes at least one; and the jobs, applied",
    "in order, leave a spec that holds together after each, ending exactly on the .plain files as they are. commit_queue checks",
    "it, and says what is wrong if anything is - fix that and commit again. A job that is running is not in the queue: it stays.",
    "",
    "Read the changes as ***plain, by the rules in your system prompt: what a concept's definition, an imported or required",
    "module, an implementation or test req means for the functional specs that use it, and so what has to go first or together.",
    "",
    "Keep jobs small and about one thing a person would name; never more jobs than there are queued now unless the change",
    "really adds a separate piece of work. When the queue is right as proposed, commit it as it is.",
    "",
    ...(input.instruction !== undefined
      ? [
          "<what the person asks of the queue>",
          input.instruction.trim(),
          "</what the person asks>",
          "Do what they ask, within the one rule: you can reorder, merge, split and rewrite the jobs, but not the spec they end on.",
          "What they ask that would change the spec itself - take something out of what is built - is not yours to do: say so in",
          "the summary, and that it takes a spec change, which reworks the queue again.",
          "",
        ]
      : []),
    "<the new change - the spec before it to the spec now>",
    change.trim() === "" ? "(no difference in the spec)" : change.trim(),
    "</the new change>",
    "",
    "<the queue, in the order it runs - each job's change as it was queued>",
    ...input.queued.flatMap((job, index) => [`job ${index + 1} (${job.jobId}) · ${job.title}`, job.textDiff.trim(), ""]),
    "</the queue>",
    "",
    "<the changes - the whole of the queue's work, from what the code will be built from to the spec now>",
    net.length === 0 ? "(none: the code is already built from the spec as it is now - every queued job can go)" : net.map(describeChange).join("\n\n"),
    "</the changes>",
    "",
    "<the draft, as the harness proposes it - each job keeping the changes of its own still part of the work>",
    ...proposal.map((job, index) => `job ${index + 1}${job.jobId ? ` (${job.jobId})` : " (new)"} · ${job.title}: ${job.changes.length > 0 ? job.changes.join(", ") : "no changes left - the new change undid them"}`),
    "</the draft>",
    "",
    "<the spec as the .plain files have it now>",
    treeText(serializeTree(input.current)),
    "</the spec now>",
    ...(net.length > 0 ? [] : [""]),
    ...(byId.size > 0 ? [] : ["There is no work left: delete every job, and commit the empty queue."]),
  ].join("\n");
}

/** The master as an agent: a model with the queue's tools, working on the draft until it commits. */
export function llmQueueMaster(options: { cwd: string; model?: string; label?: string }): QueueMasterAgent {
  return async (input, tools, prompt) => {
    const say = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
    const job = Type.String({ description: "A job: its id, its number in the draft from 1, or its title" });
    const defs: ToolDefinition[] = [
      defineTool({
        name: "show_queue",
        label: "Show the draft",
        description: "The draft queue as it stands: each job's title and the changes it makes.",
        parameters: Type.Object({}),
        async execute() {
          return say(tools.draft().map((item, index) => `job ${index + 1}${item.jobId ? ` (${item.jobId})` : " (new)"} · ${item.title}: ${item.changes.join(", ") || "no changes"}`).join("\n") || "(empty)");
        },
      }),
      defineTool({
        name: "delete_job",
        label: "Delete a job",
        description: "Take a job out of the queue - one whose changes the new change undid, so it makes none.",
        parameters: Type.Object({ job, reason: Type.String() }),
        async execute(_id, params) {
          return say(tools.deleteJob(params.job, params.reason));
        },
      }),
      defineTool({
        name: "merge_jobs",
        label: "Merge jobs",
        description: "Make several jobs one, at the place of the first of them, with every change they made.",
        parameters: Type.Object({ jobs: Type.Array(job), title: Type.String(), reason: Type.String() }),
        async execute(_id, params) {
          return say(tools.mergeJobs(params.jobs, params.title, params.reason));
        },
      }),
      defineTool({
        name: "reorder_jobs",
        label: "Reorder jobs",
        description: "Put the jobs in a new order - every job of the draft, once.",
        parameters: Type.Object({ order: Type.Array(job) }),
        async execute(_id, params) {
          return say(tools.reorderJobs(params.order));
        },
      }),
      defineTool({
        name: "rewrite_job",
        label: "Rewrite a job",
        description: "Change a job's title, reason, or the changes it makes (by id, e.g. [\"c1\", \"c3\"]).",
        parameters: Type.Object({ job, title: Type.Optional(Type.String()), reason: Type.Optional(Type.String()), changes: Type.Optional(Type.Array(Type.String())) }),
        async execute(_id, params) {
          return say(tools.rewriteJob(params.job, params));
        },
      }),
      defineTool({
        name: "insert_job",
        label: "Insert a job",
        description: "Add a job at a place in the queue (1 is first), making the changes given by id.",
        parameters: Type.Object({ title: Type.String(), reason: Type.String(), changes: Type.Array(Type.String()), position: Type.Number() }),
        async execute(_id, params) {
          return say(tools.insertJob(params));
        },
      }),
      defineTool({
        name: "ask_person",
        label: "Ask the person",
        description: "Ask the person who wrote the spec, when you are not sure what they meant a change to do to the queue.",
        parameters: Type.Object({ question: Type.String() }),
        async execute(_id, params) {
          return say(await tools.askPerson(params.question));
        },
      }),
      defineTool({
        name: "commit_queue",
        label: "Commit the queue",
        description: "Check the draft and make it the queue. If anything is wrong, it says what - fix it and commit again.",
        parameters: Type.Object({ summary: Type.String({ description: "What you did to the queue and why, in a sentence or two, for the person" }) }),
        async execute(_id, params) {
          const result = tools.commit(params.summary);
          if (!result.ok) return say(`Not committed:\n${result.problems.map((problem) => `- ${problem}`).join("\n")}`);
          return { content: [{ type: "text" as const, text: "Committed." }], details: {}, terminate: true };
        },
      }),
    ] as ToolDefinition[];
    void input;
    const session = await createExecutor({
      cwd: options.cwd,
      customTools: defs,
      tools: defs.map((tool) => tool.name),
      model: options.model,
      label: options.label ?? "queue master",
      // It judges how spec changes depend on each other - concepts, definitions, requires, test reqs - by the rules.
      rules: true,
      budget: { calls: 30, finish: ["commit_queue", "ask_person"] },
    });
    try {
      await ask(session, prompt);
    } finally {
      session.dispose();
    }
  };
}
