import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_CONCEPTS, extractConceptsFromDefinition, extractConceptsFromSpecText } from "../plain/concepts.ts";
import { ACCEPTANCE_TESTS, DEFINITIONS, FUNCTIONAL_REQUIREMENTS, NON_FUNCTIONAL_REQUIREMENTS, REQUIRED_FUNCTIONAL_SPECS, TEST_REQUIREMENTS, type MarshalledPlainSource } from "../plain/spec.ts";
import { ask, BEGIN, createExecutor } from "../pi.ts";
import { reportActivity, reportStage } from "./activity.ts";
import { steeringBlock, type Steering } from "./steer.ts";
import { marksGrowAgain } from "./records.ts";
import { validateConcepts } from "../plain/concepts.ts";
import { applyChanges, changesBetween, inconsistencies, layoutOf, makeStep, parseTree, serializeTree, type SpecChange, type SpecStep } from "./spec-steps.ts";

/**
 * The queue's work, cut into jobs of a size worth rendering.
 *
 * A spec diff that renders the whole of a new spec is one job too big to build well, and a render per functional
 * spec, the first carrying every definition and req of the spec, is no better: most of the work lands in one job,
 * and the rest are a line each. So the work from what the code will be built from to the spec now is cut from the
 * functional specs outward, in three steps:
 *
 * 1. Which new functional specs go together - next to each other, as the spec orders them, at most
 *    `max-specs-per-pulse` in a job (MAX_SPECS_PER_JOB unset): what builds one feature goes together, and only what
 *    stands on its own goes alone. An agent judges it: "builds the same thing" is a judgement.
 * 2. The definitions each group uses: the concepts its functional specs name, and the concepts those
 *    definitions name in turn. A definition goes with the first group that uses it; later ones have it built.
 *    Code, not an agent: it is a lookup.
 * 3. Where each new implementation req goes - the group it is about, or the first, when it is about
 *    everything - and each new test req: the group whose conformance tests need it first. An agent judges it.
 *
 * Changes to what is built already - an item edited or taken out, a functional spec built changed - go first, in a
 * job of their own. Every answer is checked; one that does not hold goes back to its agent, twice at most, and then
 * the plan falls back to a functional spec a job. A job past `max-lines-per-pulse` (MAX_LINES_PER_JOB unset) is split. The plan is the queue
 * master's proposal: it reviews it, and may change it, held to the same checks.
 */


/** What the planner cuts: the work from `base` to `current`, and the module's .plain file for how the diffs read. */
export interface PlanInput {
  /** What the work starts from: the record, or what the job running lands. */
  base: MarshalledPlainSource;
  /** What it ends on: the spec as the track sees it now. */
  current: MarshalledPlainSource;
  /** How the person wants the work cut and ordered. */
  steering?: Steering[];
  /** The module whose codebase it is: its own functional specs are given with it. */
  moduleName?: string;
  /** The module's .plain file, as the diffs name it, and its text - for the diffs' layout. */
  specFile: string;
  specText: string;
  /**
   * Which work it is. The conformance tests' is anchored on functional specs: a job of theirs tests at least one -
   * the definitions and reqs they are written against go with the functional specs whose tests need them.
   * Default: the code's.
   */
  track?: "code" | "conformance";
  /**
   * For the conformance tests: a job a functional spec, as the person asked. Otherwise every functional spec tested is
   * in one job, as far as the guardrail (`max-lines-per-pulse`) lets.
   */
  separately?: boolean;
  /** How big a pulse may be - the config's `max-specs-per-pulse` and `max-lines-per-pulse`; unset, MAX_SPECS_PER_JOB and MAX_LINES_PER_JOB. */
  limits?: PulseLimits;
}

/** How big a pulse may be: how many functional specs, and how many lines of spec with the definitions they bring. */
export interface PulseLimits {
  specs: number;
  lines: number;
}

/** One job of a plan: a title, why, and the changes it makes, by id. */
export interface DraftJob {
  title: string;
  reason: string;
  changes: string[];
}

/** The work the queue does: every change from the base to the spec as it is now, numbered. */
export function netChanges(base: MarshalledPlainSource, current: MarshalledPlainSource): SpecChange[] {
  return changesBetween(serializeTree(base), serializeTree(current));
}

/**
 * What is wrong with a reworked queue, or nothing: every change in exactly one job, no job without
 * one, and each job, applied after the ones before it, leaving a spec that holds together - the last
 * exactly the spec as it is now.
 */
export function checkDraft(input: PlanInput, draft: DraftJob[]): string[] {
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
export function stepsOf(input: PlanInput, draft: DraftJob[]): Array<DraftJob & { step: SpecStep }> {
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


export const MAX_SPECS_PER_JOB = 3;
export const MAX_LINES_PER_JOB = 120;
/** How often an answer that does not hold goes back to its agent before the plan falls back. */
const RETRIES = 2;

/**
 * A functional spec to build, for the grouping: the number the agent answers with, its text, and whether it is built
 * already and grown again. `id` and `module` say which it is: each module numbers its own from 1, and a codebase grows
 * again the functional specs of the modules it is built on too. No module: the codebase's own. No id: the number.
 */
export interface NewSpec {
  number: number;
  text: string;
  again?: boolean;
  id?: string;
  module?: string;
}

export interface GroupAnswer {
  groups: Array<{ specs: number[]; title: string }>;
  /** What of the person's wishes it did not follow, and why. */
  notes?: string;
}

export interface PlaceInput {
  /** How the person or the harness wants the queue planned. */
  steering?: Steering[];
  groups: Array<{ number: number; title: string; specs: string[]; definitions: string[] }>;
  /** What is built already changes too: a job for that goes first, and a req can go with it. */
  built: boolean;
  implementationReqs: Array<{ number: number; text: string }>;
  testReqs: Array<{ number: number; text: string }>;
}

/** Where a req goes: a group's number, "all" - the first job, it is about everything - or "built", with the changes to what is built. */
export type Target = number | "all" | "built";

export interface PlaceAnswer {
  implementationReqs: Array<{ req: number; to: Target }>;
  testReqs: Array<{ req: number; to: Target }>;
  /** What of the person's wishes it did not follow, and why. */
  notes?: string;
}

/**
 * The two judgements, each asked again with what was wrong with its answer - the last answer given, whether it holds
 * or not: the plan checks it again. Injectable, so the plan is testable without a model.
 */
export interface ChunkAgents {
  group(specs: NewSpec[], check: (answer: GroupAnswer) => string[], steering?: Steering[], maxSpecs?: number): Promise<GroupAnswer | undefined>;
  place(input: PlaceInput, check: (answer: PlaceAnswer) => string[]): Promise<PlaceAnswer | undefined>;
}

/** An item's text, from its serialized line: its markdown, and its acceptance tests. */
function textOf(change: SpecChange): string {
  const line = change.after ?? change.before ?? "";
  try {
    const item = JSON.parse(line) as { markdown?: string; [ACCEPTANCE_TESTS]?: Array<{ markdown?: string }> };
    return [item.markdown ?? "", ...(item[ACCEPTANCE_TESTS] ?? []).map((test) => test.markdown ?? "")].filter(Boolean).join("\n");
  } catch {
    return line;
  }
}

/** How many lines a change reads as: what a job's size is counted in. */
function linesOf(change: SpecChange): number {
  return textOf(change).split("\n").length;
}

/** The concepts a text names, reserved ones left out. */
function namedIn(text: string): string[] {
  return extractConceptsFromSpecText(text).filter((concept) => !DEFAULT_CONCEPTS.has(concept));
}

/** The concept a definition defines, from its text. */
function definedBy(text: string): string[] {
  return extractConceptsFromDefinition(text)[0];
}

/** What is wrong with a grouping: every new functional spec once, in order, next to each other, none too big. */
export function groupProblems(specs: NewSpec[], answer: GroupAnswer, maxSpecs = MAX_SPECS_PER_JOB): string[] {
  const problems: string[] = [];
  const numbers = specs.map((spec) => spec.number);
  const given = answer.groups.flatMap((group) => group.specs);
  if (given.join(",") !== numbers.join(",")) problems.push(`The groups must hold every new functional spec once, in the order the spec has them: ${numbers.join(", ")}. They hold ${given.join(", ") || "none"}.`);
  // Next to each other: in the same module, one numbered after the other there.
  const byNumber = new Map(specs.map((spec) => [spec.number, spec]));
  const nextTo = (a: number, b: number) => {
    const first = byNumber.get(a);
    const second = byNumber.get(b);
    if (first === undefined || second === undefined) return b === a + 1;
    return first.module === second.module && Number(second.id ?? second.number) === Number(first.id ?? first.number) + 1;
  };
  for (const group of answer.groups) {
    if (group.specs.length === 0) problems.push(`"${group.title}" has no functional spec.`);
    if (group.specs.length > maxSpecs) problems.push(`"${group.title}" has ${group.specs.length} functional specs - at most ${maxSpecs}.`);
    for (let i = 1; i < group.specs.length; i += 1) {
      if (!nextTo(group.specs[i - 1]!, group.specs[i]!)) problems.push(`"${group.title}" groups ${group.specs.join(", ")}: only functional specs next to each other in the same module go together.`);
    }
    if (group.title.trim() === "") problems.push("Every group needs a title.");
  }
  return problems;
}

/** What is wrong with a placement: every new req once, each where there is such a job. */
export function placeProblems(input: PlaceInput, answer: PlaceAnswer): string[] {
  const problems: string[] = [];
  const valid = (to: Target) => to === "all" || (to === "built" ? input.built : Number.isInteger(to) && to >= 1 && to <= input.groups.length);
  for (const [kind, reqs, placed] of [
    ["implementation req", input.implementationReqs, answer.implementationReqs],
    ["test req", input.testReqs, answer.testReqs],
  ] as const) {
    const numbers = reqs.map((req) => req.number);
    const seen = new Map<number, number>();
    for (const entry of placed) {
      if (!numbers.includes(entry.req)) problems.push(`There is no ${kind} ${entry.req}.`);
      seen.set(entry.req, (seen.get(entry.req) ?? 0) + 1);
      if (!valid(entry.to)) problems.push(`${kind} ${entry.req} goes to ${entry.to}, which is no job: a group's number, "all"${input.built ? ', or "built"' : ""}.`);
    }
    for (const number of numbers) {
      const times = seen.get(number) ?? 0;
      if (times === 0) problems.push(`${kind} ${number} is not placed: every one goes somewhere.`);
      if (times > 1) problems.push(`${kind} ${number} is placed ${times} times: once.`);
    }
  }
  return problems;
}

/** Whether a change is to a functional spec marked to grow again: built, and grown again - cut into jobs as new work is. */
function growsAgain(change: SpecChange): boolean {
  if ((change.section !== FUNCTIONAL_REQUIREMENTS && change.section !== REQUIRED_FUNCTIONAL_SPECS) || change.kind !== "change" || change.before === undefined) return false;
  try {
    return marksGrowAgain(JSON.parse(change.before));
  } catch {
    return false;
  }
}

/** The functional specs added at the end: new work. One added anywhere else changes what is built on. */
function newSpecsOf(net: SpecChange[], current: MarshalledPlainSource): SpecChange[] {
  const count = ((current[FUNCTIONAL_REQUIREMENTS] as unknown[] | undefined) ?? []).length;
  const added = net.filter((change) => change.section === FUNCTIONAL_REQUIREMENTS && change.kind === "add").sort((a, b) => a.position - b.position);
  const tail: SpecChange[] = [];
  for (let at = count; at >= 1; at -= 1) {
    const change = added.find((candidate) => candidate.position === at);
    if (change === undefined) break;
    tail.unshift(change);
  }
  return tail;
}

interface Chunk {
  title: string;
  specs: SpecChange[];
  definitions: SpecChange[];
  reqs: SpecChange[];
  /** The changes to what is built, for the job that goes first. */
  built?: SpecChange[];
}

/**
 * The definitions each chunk uses, in order: the concepts its items name, and those its definitions name in turn -
 * each definition with the first chunk that uses it. Those nothing uses go with the last.
 */
function placeDefinitions(chunks: Chunk[], definitions: SpecChange[]): void {
  const byConcept = new Map<string, SpecChange>();
  for (const definition of definitions) for (const concept of definedBy(textOf(definition))) byConcept.set(concept, definition);
  const placed = new Set<SpecChange>();
  for (const chunk of chunks) {
    chunk.definitions = [];
    const queue = [...chunk.specs, ...chunk.reqs, ...(chunk.built ?? [])].flatMap((change) => namedIn(textOf(change)));
    for (let concept = queue.shift(); concept !== undefined; concept = queue.shift()) {
      const definition = byConcept.get(concept);
      if (definition === undefined || placed.has(definition)) continue;
      placed.add(definition);
      chunk.definitions.push(definition);
      queue.push(...namedIn(textOf(definition)));
    }
  }
  const left = definitions.filter((definition) => !placed.has(definition));
  if (left.length > 0 && chunks.length > 0) chunks.at(-1)!.definitions.push(...left);
}

/**
 * The lines of a chunk that a split can move to a later job: its functional specs and the definitions they bring. Its
 * reqs stay with the first job of the split whatever happens, so they never decide one.
 */
function movableSize(chunk: Chunk): number {
  return [...chunk.specs, ...chunk.definitions].reduce((total, change) => total + linesOf(change), 0);
}

function sizeOf(chunk: Chunk): number {
  return [...chunk.specs, ...chunk.definitions, ...chunk.reqs, ...(chunk.built ?? [])].reduce((total, change) => total + linesOf(change), 0);
}

/**
 * The draft a chunking is: a job per chunk, its changes in the order the net has them. A job runs as the queued job
 * whose own change it carries - the first of them not taken by an earlier one - so a job keeps its id, its notes and
 * its conformance job where the plan leaves its change where it was.
 */
function draftOf(chunks: Chunk[], net: SpecChange[]): DraftJob[] {
  return chunks
    .map((chunk) => {
      const ids = new Set([...chunk.specs, ...chunk.definitions, ...chunk.reqs, ...(chunk.built ?? [])].map((change) => change.id));
      return { chunk, changes: net.filter((change) => ids.has(change.id)).map((change) => change.id) };
    })
    .filter((entry) => entry.changes.length > 0)
    .map((entry) => ({
      title: entry.chunk.title,
      reason:
        entry.chunk.built !== undefined
          ? "what is built already, changed"
          : entry.chunk.specs.length > 0 && entry.chunk.specs.every(growsAgain)
            ? "functional specs grown again"
            : "new work, cut from its functional specs",
      changes: entry.changes,
    }));
}

/** A spec's first line, as a group's title when no agent gave one. */
function titleOf(change: SpecChange): string {
  return textOf(change).split("\n")[0]!.replace(/^-\s*/, "").slice(0, 80);
}

/**
 * Cut the queue's work - from `input.base` to `input.current` - into jobs, as the three steps say. Returns the draft
 * the work loop runs: checked (checkDraft), or, when nothing holds, the whole work as one job. `notes` is given what
 * the plan did not do as asked - the person's wishes an agent did not follow and why, an answer that did not hold, a
 * group split for its size - for the conversation to say, rather than guess.
 */
export async function planChunks(input: PlanInput, agents?: ChunkAgents, notes?: string[]): Promise<DraftJob[]> {
  if (input.track !== "conformance") return cut(input, agents, notes);
  // The conformance tests are grouped by the harness, as one job as far as the guardrail lets: no agent is asked.
  return anchored(await cut(input), netChanges(input.base, input.current));
}

/**
 * A conformance plan, every job of it testing a functional spec: a job that touches none - reqs or definitions alone -
 * goes into the next job that does, or, with none after it, the last before it. Work that touches no functional spec
 * at all - test reqs changed, say - stays as it is: it is mechanical, and nothing else.
 */
function anchored(draft: DraftJob[], net: SpecChange[]): DraftJob[] {
  const sectionOf = new Map(net.map((change) => [change.id, change.section]));
  const testsASpec = (job: DraftJob) => job.changes.some((id) => sectionOf.get(id) === FUNCTIONAL_REQUIREMENTS);
  if (!draft.some(testsASpec)) return draft;
  const jobs: DraftJob[] = [];
  let carried: string[] = [];
  for (const job of draft) {
    if (!testsASpec(job)) {
      carried.push(...job.changes);
      continue;
    }
    jobs.push({ ...job, changes: [...carried, ...job.changes] });
    carried = [];
  }
  if (carried.length > 0) jobs[jobs.length - 1] = { ...jobs.at(-1)!, changes: [...jobs.at(-1)!.changes, ...carried] };
  return jobs;
}

/**
 * How the conformance tests are cut, with no agent: every functional spec tested in one job - those of one module
 * together - a new job begun only where the next functional spec would take the job's functional specs and the
 * definitions they bring past `maxLines`; or, `separately`, a job a functional spec, as the person asked.
 * `size`: the movable lines of the last group of a grouping, its definitions placed.
 */
function conformanceGroups(
  specs: NewSpec[],
  separately: boolean,
  maxLines: number,
  size: (groups: Array<{ specs: number[]; title: string }>) => number,
  titleOfSpec: (number: number) => string,
): Array<{ specs: number[]; title: string }> {
  const groups: Array<{ specs: number[] }> = [];
  for (const spec of specs) {
    const last = groups.at(-1);
    const sameModule = last !== undefined && specs.find((other) => other.number === last.specs[0])?.module === spec.module;
    if (!separately && last !== undefined && sameModule) {
      const trial = [...groups.slice(0, -1), { specs: [...last.specs, spec.number] }].map((group) => ({ ...group, title: "" }));
      if (size(trial) <= maxLines) {
        last.specs.push(spec.number);
        continue;
      }
    }
    groups.push({ specs: [spec.number] });
  }
  return groups.map((group) => ({ specs: group.specs, title: group.specs.map(titleOfSpec).join("; ") }));
}

async function cut(input: PlanInput, agents?: ChunkAgents, notes?: string[]): Promise<DraftJob[]> {
  // How big a pulse may be: the config's, else the defaults.
  const { specs: maxSpecs, lines: maxLines } = input.limits ?? { specs: MAX_SPECS_PER_JOB, lines: MAX_LINES_PER_JOB };
  /** What the plan did not do as asked: in the activity, and in the notes. */
  const say = (text: string) => {
    reportActivity(`  ${text}`);
    notes?.push(text);
  };
  const net = netChanges(input.base, input.current);
  if (net.length === 0) return [];
  // What is grouped into jobs: the functional specs grown again - the modules' below first, as the codebase is built on
  // them - and the codebase's own, grown again or new at the end, in the spec's order.
  const below = net.filter((change) => growsAgain(change) && change.section === REQUIRED_FUNCTIONAL_SPECS).sort((a, b) => a.position - b.position);
  // The conformance tests are written on the code as built: every functional spec added or changed is tested alike, wherever it is.
  const own =
    input.track === "conformance"
      ? net.filter((change) => change.section === FUNCTIONAL_REQUIREMENTS && change.kind !== "remove").sort((a, b) => a.position - b.position)
      : [...net.filter((change) => growsAgain(change) && change.section === FUNCTIONAL_REQUIREMENTS), ...newSpecsOf(net, input.current)].sort((a, b) => a.position - b.position);
  const specs = [...below, ...own];
  const inSpecs = new Set(specs);
  const isNew = (change: SpecChange, section: string) => change.section === section && change.kind === "add";
  const definitions = net.filter((change) => isNew(change, DEFINITIONS));
  const implementationReqs = net.filter((change) => isNew(change, NON_FUNCTIONAL_REQUIREMENTS));
  const testReqs = net.filter((change) => isNew(change, TEST_REQUIREMENTS));
  const placedByKind = new Set([...definitions, ...implementationReqs, ...testReqs]);
  // Added in another section - the required modules' functional specs of a first build: with the first job of the new work.
  const otherAdds = net.filter((change) => change.kind === "add" && !inSpecs.has(change) && !placedByKind.has(change) && change.section !== FUNCTIONAL_REQUIREMENTS);
  // Anything else changes what is built on - an edit, a removal, a functional spec built changed or put in among them.
  const builtChanges = net.filter((change) => !inSpecs.has(change) && !placedByKind.has(change) && !otherAdds.includes(change));
  const hasBuilt = builtChanges.length > 0;
  const whole: DraftJob[] = [{ title: "The spec change", reason: "the whole of the work, in one job", changes: net.map((change) => change.id) }];
  if (specs.length === 0) return checkDraft(input, whole).length === 0 ? whole : [];

  // 1. Which functional specs go together.
  reportStage(`planning the queue: which of the ${specs.length} functional spec${specs.length === 1 ? "" : "s"} to build go together`);
  const numbered: NewSpec[] = specs.map((change, index) => {
    const required = change.section === REQUIRED_FUNCTIONAL_SPECS ? (JSON.parse(change.after!) as { module?: string; frid?: string }) : undefined;
    return {
      number: index + 1,
      text: textOf(change),
      id: required?.frid ?? String(change.position),
      ...(required?.module !== undefined ? { module: required.module } : input.moduleName !== undefined ? { module: input.moduleName } : {}),
      ...(growsAgain(change) ? { again: true } : {}),
    };
  });
  const bySpec = new Map(specs.map((change, index) => [index + 1, change]));
  const chunksFor = (list: Array<{ specs: number[]; title: string }>): Chunk[] => [
    ...(hasBuilt ? [{ title: "Changes to what is built", specs: [], definitions: [], reqs: [], built: builtChanges }] : []),
    ...list.map((group) => ({ title: group.title, specs: group.specs.map((number) => bySpec.get(number)!), definitions: [], reqs: [] })),
  ];
  const conformance = input.track === "conformance";
  const grouped = conformance ? undefined : ((await agents?.group(numbered, (answer) => groupProblems(numbered, answer, maxSpecs), input.steering, maxSpecs).catch(() => undefined)) ?? undefined);
  const groups = conformance
    ? conformanceGroups(numbered, input.separately === true, maxLines, (list) => {
        const trial = chunksFor(list);
        placeDefinitions(trial, definitions);
        return movableSize(trial.at(-1)!);
      }, (number) => titleOf(bySpec.get(number)!))
    : grouped !== undefined && groupProblems(numbered, grouped, maxSpecs).length === 0
      ? grouped.groups
      : numbered.map((spec, index) => ({ specs: [spec.number], title: titleOf(specs[index]!) }));
  if (grouped?.notes !== undefined && grouped.notes.trim() !== "") say(`the grouping: ${grouped.notes.trim()}`);
  if (!conformance && agents !== undefined) {
    if (grouped === undefined) say("the grouping was not given - a functional spec a pulse");
    else if (groupProblems(numbered, grouped, maxSpecs).length > 0) say(`the grouping did not hold (${groupProblems(numbered, grouped, maxSpecs).join(" ")}) - a functional spec a pulse`);
  }
  let chunks = chunksFor(groups);

  // 2. The definitions each group uses.
  placeDefinitions(chunks, definitions);

  // 3. Where each implementation req and test req goes.
  const newChunks = () => chunks.filter((chunk) => chunk.built === undefined);
  const builtChunk = () => chunks.find((chunk) => chunk.built !== undefined);
  let placement: PlaceAnswer | undefined;
  if (implementationReqs.length + testReqs.length > 0) {
    reportStage(`planning the queue: where each of ${implementationReqs.length + testReqs.length} new req${implementationReqs.length + testReqs.length === 1 ? "" : "s"} goes`);
    const placeInput: PlaceInput = {
      ...(input.steering !== undefined ? { steering: input.steering } : {}),
      groups: newChunks().map((chunk, index) => ({ number: index + 1, title: chunk.title, specs: chunk.specs.map(textOf), definitions: chunk.definitions.map(textOf) })),
      built: hasBuilt,
      implementationReqs: implementationReqs.map((change, index) => ({ number: index + 1, text: textOf(change) })),
      testReqs: testReqs.map((change, index) => ({ number: index + 1, text: textOf(change) })),
    };
    const answer = (await agents?.place(placeInput, (given) => placeProblems(placeInput, given)).catch(() => undefined)) ?? undefined;
    if (answer?.notes !== undefined && answer.notes.trim() !== "") say(`the placement: ${answer.notes.trim()}`);
    placement = answer !== undefined && placeProblems(placeInput, answer).length === 0 ? answer : undefined;
    if (placement === undefined && agents !== undefined) say("the placement did not hold - every implementation req with the first pulse, every test req with the first conformance pulse");
  }
  /** A req's chunk: its group, the built job, or the first job of the new work for "all". */
  const chunkOf = (to: Target): Chunk => (to === "built" ? builtChunk()! : to === "all" ? newChunks()[0]! : newChunks()[to - 1]!);
  const place = () => {
    for (const chunk of chunks) chunk.reqs = [];
    implementationReqs.forEach((change, index) => chunkOf(placement?.implementationReqs.find((entry) => entry.req === index + 1)?.to ?? "all").reqs.push(change));
    testReqs.forEach((change, index) => chunkOf(placement?.testReqs.find((entry) => entry.req === index + 1)?.to ?? 1).reqs.push(change));
    newChunks()[0]?.reqs.push(...otherAdds);
    // What the reqs name is defined with them, or before.
    placeDefinitions(chunks, definitions);
  };
  place();

  // A group too big to render well is split - into as few pulses as fit, its functional specs kept together in runs as
  // long as the limit lets, rather than a functional spec a pulse: most of the grouping holds. Its reqs go with the first.
  if (newChunks().some((chunk) => chunk.specs.length > 1 && movableSize(chunk) > maxLines)) {
    /** The size of the group starting at `first` in a trial grouping, its definitions placed as they would be. */
    const sizeIn = (list: Array<{ specs: number[]; title: string }>, first: number): number => {
      const trial = chunksFor(list);
      placeDefinitions(trial, definitions);
      const chunk = trial.find((candidate) => candidate.specs[0] === bySpec.get(first));
      return chunk !== undefined ? movableSize(chunk) : 0;
    };
    const split: Array<{ specs: number[]; title: string }> = [];
    groups.forEach((group, at) => {
      const chunk = newChunks().find((candidate) => candidate.specs[0] === bySpec.get(group.specs[0]!));
      if (chunk === undefined || chunk.specs.length < 2 || movableSize(chunk) <= maxLines) {
        split.push(group);
        return;
      }
      const after = groups.slice(at + 1);
      const runs: number[][] = [];
      let run: number[] = [group.specs[0]!];
      for (const next of group.specs.slice(1)) {
        const longer = [...run, next];
        const trial = [...split, ...runs.map((specs) => ({ specs, title: "" })), { specs: longer, title: "" }, ...after];
        if (sizeIn(trial, longer[0]!) <= maxLines) run = longer;
        else {
          runs.push(run);
          run = [next];
        }
      }
      runs.push(run);
      say(`"${group.title}" is past ${maxLines} lines with its definitions and reqs - split into ${runs.length} pulses`);
      runs.forEach((specs, index) =>
        split.push({ specs, title: specs.length === 1 ? titleOf(bySpec.get(specs[0]!)!) : `${group.title} (${index + 1} of ${runs.length})` }),
      );
    });
    const before = placement;
    // A req placed with a group that split goes with the first functional spec of it.
    const groupOfSpec = new Map(split.map((group, index) => [group.specs[0]!, index + 1]));
    const remap = (to: Target): Target => (typeof to === "number" ? (groupOfSpec.get(groups[to - 1]!.specs[0]!) ?? to) : to);
    placement = before !== undefined ? { implementationReqs: before.implementationReqs.map((entry) => ({ ...entry, to: remap(entry.to) })), testReqs: before.testReqs.map((entry) => ({ ...entry, to: remap(entry.to) })) } : undefined;
    groups.splice(0, groups.length, ...split);
    chunks = chunksFor(groups);
    place();
  }
  // What is about everything, the first group cannot carry within the limit: a job of its own ahead of it, when it holds on its own.
  const first = newChunks()[0];
  if (first !== undefined && sizeOf(first) > maxLines) {
    const everything = implementationReqs.filter((change, index) => (placement?.implementationReqs.find((entry) => entry.req === index + 1)?.to ?? "all") === "all");
    const standalone = everything.filter((change) => namedIn(textOf(change)).every((concept) => definitions.every((definition) => !definedBy(textOf(definition)).includes(concept))));
    if (standalone.length > 0) {
      first.reqs = first.reqs.filter((change) => !standalone.includes(change));
      chunks.splice(chunks.indexOf(first), 0, { title: "What the whole of it is built with", specs: [], definitions: [], reqs: standalone });
    }
  }

  const draft = draftOf(chunks, net);
  if (checkDraft(input, draft).length === 0) return draft;
  // It does not hold together: a functional spec a job, every req with the first.
  say(`the plan did not hold together (${checkDraft(input, draft)[0]?.slice(0, 120)}) - a functional spec a pulse`);
  placement = undefined;
  groups.splice(0, groups.length, ...numbered.map((spec, index) => ({ specs: [spec.number], title: titleOf(specs[index]!) })));
  chunks = chunksFor(groups);
  place();
  const simple = draftOf(chunks, net);
  if (checkDraft(input, simple).length === 0) return simple;
  return checkDraft(input, whole).length === 0 ? whole : [];
}

// ---------------------------------------------------------------------------------------------
// The agents.

export function groupPrompt(specs: NewSpec[], steering?: Steering[], maxSpecs = MAX_SPECS_PER_JOB): string {
  return [
    "You plan how new work on a codebase is built: which of its new functional specs are built together, in one job.",
    "",
    "Each job is rendered by a coding agent, reviewed and tested, then the next - fewer, fuller jobs: each job costs a",
    "coding session, a test run and a review. So group by default: what builds one feature goes together - the feature,",
    `its edge cases, and the functional specs that build on it - up to ${maxSpecs}: a component and the parts only it uses`,
    "(a timeout handler, a retry handler and the executor that runs a function through both), an endpoint and the one",
    "that undoes it, a record, the list of it and its filters. Keep a functional spec alone only when it is truly",
    "independent - nothing next to it builds on it or is part of the same thing - or when it is very large on its own.",
    "Never group specs only because they are of the same kind.",
    "",
    "Only functional specs next to each other in the same module go together, and they stay in the order given: the",
    "order is what each is built on. Give each group a short title that says what it builds.",
    "",
    "The specification is split into modules - a ***plain matter, not how the code is laid out. Each numbers its",
    "functional specs from 1: each below is given with its module and its id there, and a number of its own to answer with.",
    "",
    ...steeringBlock(steering),
    ...(specs.some((spec) => spec.again === true)
      ? [
          "Those marked again=\"true\" are built already, and are grown again - rewritten, doing what they say. Group them as",
          "you would new ones, by what they build.",
          "",
        ]
      : []),
    "The functional specs to build:",
    "",
    ...specs.map(
      (spec) =>
        `<functional spec number="${spec.number}"${spec.module !== undefined ? ` module="${spec.module}"` : ""} id="${spec.id ?? spec.number}"${spec.again === true ? ' again="true"' : ""}>\n${spec.text.trim()}\n</functional spec>`,
    ),
    "",
    "Call submit_groups once, with every one of them in a group.",
  ].join("\n");
}

export function placePrompt(input: PlaceInput): string {
  return [
    "You plan how new work on a codebase is built. Its new functional specs are in groups, each a job, built in order,",
    "each with the definitions it uses. Place each new implementation req and test req in the job it belongs to.",
    "",
    "- An implementation req goes with the group it is about - how that part is built, stored, secured. One about",
    '  everything - the language, the framework, how every part is laid out - goes to "all": with the first job,',
    "  where the codebase starts.",
    "- A test req goes with the first group whose conformance tests need it; one about all the tests to \"all\".",
    ...(input.built ? ['- "built" is the job that changes what is built already, and goes first: a req about the code there already goes there.'] : []),
    "",
    ...steeringBlock(input.steering),
    ...input.groups.map((group) =>
      [
        // A title that is only its first spec's first line is not said twice.
        group.specs[0] !== undefined && group.specs[0].includes(group.title.trim().replace(/\.$/, "")) ? `<group number="${group.number}">` : `<group number="${group.number}" title="${group.title}">`,
        ...group.specs.map((spec) => `<functional spec>\n${spec.trim()}\n</functional spec>`),
        ...group.definitions.map((definition) => `<definition>\n${definition.trim()}\n</definition>`),
        "</group>",
      ].join("\n"),
    ),
    "",
    ...(input.implementationReqs.length > 0 ? ["The new implementation reqs:", ...input.implementationReqs.map((req) => `<implementation req number="${req.number}">\n${req.text.trim()}\n</implementation req>`), ""] : []),
    ...(input.testReqs.length > 0 ? ["The new test reqs:", ...input.testReqs.map((req) => `<test req number="${req.number}">\n${req.text.trim()}\n</test req>`), ""] : []),
    "Call submit_placement once, with every one of them placed once.",
  ].join("\n");
}

const TargetSchema = Type.Union([Type.Number(), Type.Literal("all"), Type.Literal("built")]);
const NOTES = "Each of the person's wishes for how the queue is planned that you did not follow, and why - a limit it would break, say. Leave it out when you followed them all, or there are none.";

/** Ask one step of an agent, and ask again with what was wrong, until it holds or the retries are spent. */
async function askStep<A>(options: { cwd: string; model?: string; label: string; task: string; tool: (take: (answer: A) => void) => ToolDefinition; check: (answer: A) => string[] }): Promise<A | undefined> {
  let answer: A | undefined;
  const tool = options.tool((given) => (answer = given));
  const session = await createExecutor({ cwd: options.cwd, customTools: [tool], tools: [tool.name], model: options.model, label: options.label, role: "planner", task: options.task, budget: { calls: 4, finish: [tool.name] } });
  try {
    await ask(session, BEGIN);
    for (let again = 0; again < RETRIES; again += 1) {
      if (answer !== undefined && options.check(answer).length === 0) return answer;
      const problems = answer === undefined ? [`You did not call ${tool.name}.`] : options.check(answer);
      answer = undefined;
      await ask(session, `That does not hold:\n- ${problems.join("\n- ")}\n\nCall ${tool.name} again, with it fixed.`);
    }
    return answer;
  } finally {
    session.dispose();
  }
}

/** The chunking's two agents, on a model - fresh for every plan. */
export function llmChunkAgents(options: { cwd: string; model?: string; label?: string }): ChunkAgents {
  const label = options.label ?? "queue planner";
  return {
    group: (specs, check, steering, maxSpecs) =>
      askStep<GroupAnswer>({
        cwd: options.cwd,
        model: options.model,
        label: `${label} grouping`,
        task: groupPrompt(specs, steering, maxSpecs),
        check,
        tool: (take) =>
          defineTool({
            name: "submit_groups",
            label: "Submit the groups",
            description: "The new functional specs in groups, in order: each group's spec numbers and a short title.",
            parameters: Type.Object({
              groups: Type.Array(Type.Object({ specs: Type.Array(Type.Number()), title: Type.String() })),
              notes: Type.Optional(Type.String({ description: NOTES })),
            }),
            async execute(_id, params) {
              take(params as GroupAnswer);
              return { content: [{ type: "text" as const, text: "Recorded." }], details: {}, terminate: true };
            },
          }) as ToolDefinition,
      }),
    place: (input, check) =>
      askStep<PlaceAnswer>({
        cwd: options.cwd,
        model: options.model,
        label: `${label} placement`,
        task: placePrompt(input),
        check,
        tool: (take) =>
          defineTool({
            name: "submit_placement",
            label: "Submit the placement",
            description: 'Where each new req goes: a group\'s number, "all", or "built".',
            parameters: Type.Object({
              implementation_reqs: Type.Array(Type.Object({ req: Type.Number(), to: TargetSchema })),
              test_reqs: Type.Array(Type.Object({ req: Type.Number(), to: TargetSchema })),
              notes: Type.Optional(Type.String({ description: NOTES })),
            }),
            async execute(_id, params) {
              const given = params as { implementation_reqs: PlaceAnswer["implementationReqs"]; test_reqs: PlaceAnswer["testReqs"]; notes?: string };
              take({ implementationReqs: given.implementation_reqs, testReqs: given.test_reqs, ...(given.notes !== undefined ? { notes: given.notes } : {}) });
              return { content: [{ type: "text" as const, text: "Recorded." }], details: {}, terminate: true };
            },
          }) as ToolDefinition,
      }),
  };
}
