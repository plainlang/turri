import { DEFINITIONS, FUNCTIONAL_REQUIREMENTS, NON_FUNCTIONAL_REQUIREMENTS, type MarshalledPlainSource } from "../plain/spec.ts";
import { describeSpecChange } from "./prompt.ts";
import { applyChanges, changesBetween, parseTree, serializeTree, type SpecChange } from "./spec-steps.ts";

/**
 * JobSteering a running code job: the spec changed while it grows, inside what it is growing - a functional spec it
 * builds reworded, a sub-bullet added under one, a definition or an implementation req it is given edited, a file one
 * links edited - and the coding agent is told, rather than the job stopped or the change left to the next one. A new
 * or removed item is not a steer: the work changes shape, and that is the next job's. At most MAX_STEERS a job; the
 * one after is the next job's, or stops this one, as `allow-to-stop-jobs` says.
 *
 * Three trees. `target`: what the job lands as built from - its code record. `agent`: what its agent is to build -
 * the target, and a definition or req edited that functional specs built before the job use too: the agent is told,
 * but the record keeps what those were built from, so the loop patches them - this one's with them - once it lands.
 * `told`: what the agent has been told. A steer is waiting while `told` is not `agent`; edits made before it is
 * given are one steer, the newest of each item.
 */

export const MAX_STEERS = 2;

export interface JobSteering {
  target: MarshalledPlainSource;
  agent: MarshalledPlainSource;
  told: MarshalledPlainSource;
  /** Steers so far: each counted as it is made - edits merged into one waiting are one. */
  steers: number;
  /** What each steer was, in a line, for the job's report. */
  notes: string[];
  /** Set by the running job while its coding agent can be reached: tells it now, in its turn, and says whether it could. */
  deliver?: (text: string) => boolean;
  /** The module whose codebase it grows: the change is told with each item's module (`describeSpecChange`). */
  module?: string;
}

export function createSteering(tree: MarshalledPlainSource, module?: string): JobSteering {
  return { target: tree, agent: tree, told: tree, steers: 0, notes: [], ...(module !== undefined ? { module } : {}) };
}

/** What the agent is to be told and has not been: the steer waiting, or undefined when there is none. */
export function waitingSteer(steering: JobSteering): string | undefined {
  const changes = changesBetween(serializeTree(steering.told), serializeTree(steering.agent));
  return changes.length === 0 ? undefined : steerText(changes, steering.module);
}

/** The agent has it now. */
export function markTold(steering: JobSteering): void {
  steering.told = steering.agent;
}

/** The message a steer is: the change since it was last told, as its first one was - and to make the code match. */
export function steerText(changes: SpecChange[], moduleName?: string): string {
  return [
    "The spec changed while you work, in what you are building. The change, from the spec as you were given it to the spec as it is now:",
    "",
    describeSpecChange(changes, moduleName),
    "",
    "Make the code and its unit tests match the spec as it is now - this change, and nothing else changes. Carry on from where you are: the harness runs the unit tests again once you have.",
  ].join("\n");
}

/** A definition's concept: `:User:` of `- :User: is a person.`. */
function conceptOf(serialized: string | undefined): string | undefined {
  if (serialized === undefined) return undefined;
  try {
    const item = JSON.parse(serialized) as { markdown?: string } | string;
    const text = typeof item === "string" ? item : (item.markdown ?? "");
    return /^-\s+(:[^:\s]+:)/.exec(text)?.[1];
  } catch {
    return undefined;
  }
}

/** The functional specs of a tree, a line each, as its serialized form - and so a change's text - has them. */
function functionalSpecs(tree: MarshalledPlainSource): string[] {
  const header = JSON.stringify([FUNCTIONAL_REQUIREMENTS]);
  const lines = serializeTree(tree).split("\n");
  const start = lines.indexOf(header);
  if (start === -1) return [];
  const own: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line === "" || line.startsWith("[")) break;
    own.push(line);
  }
  return own;
}

/**
 * The part of `changes` - from a tree the job grows towards, to the spec - that steers it: changes to items it already
 * has, never one added or removed. A functional spec only when it is one of the job's own (`mine`, as the job grows it);
 * a definition or an implementation req always. `shared`: those of them that functional specs built before the job
 * (`built`) use too - the agent is told, but they stay out of the record.
 */
export function steerableChanges(changes: SpecChange[], mine: Set<string>, built: string[]): { steer: SpecChange[]; shared: SpecChange[] } {
  const steer: SpecChange[] = [];
  const shared: SpecChange[] = [];
  for (const change of changes) {
    if (change.kind !== "change") continue;
    if (change.section === FUNCTIONAL_REQUIREMENTS) {
      if (mine.has(change.before ?? "")) steer.push(change);
    } else if (change.section === DEFINITIONS) {
      steer.push(change);
      const concept = conceptOf(change.before) ?? conceptOf(change.after);
      if (concept !== undefined && built.some((spec) => spec.includes(concept))) shared.push(change);
    } else if (change.section === NON_FUNCTIONAL_REQUIREMENTS) {
      steer.push(change);
      if (built.length > 0) shared.push(change);
    }
  }
  return { steer, shared };
}

/**
 * Steer a job, when the spec moved on inside what it grows: the trees it moves to, or undefined when nothing in the
 * change steers it. `toSpec(tree)` is the work from a tree to the spec, as the job's track sees it; `own` the job's
 * changes, from its record `from` to what it grows towards now.
 */
export function steer(steering: JobSteering, from: MarshalledPlainSource, own: SpecChange[], toSpec: (tree: MarshalledPlainSource) => SpecChange[]): { target: MarshalledPlainSource; agent: MarshalledPlainSource; steered: SpecChange[] } | undefined {
  // The job's own functional specs, as it grows them; those built before it that it does not touch.
  const mine = new Set(own.filter((change) => change.section === FUNCTIONAL_REQUIREMENTS && change.after !== undefined).map((change) => change.after!));
  const patched = new Set(own.filter((change) => change.section === FUNCTIONAL_REQUIREMENTS && change.kind === "change").map((change) => change.before ?? ""));
  const built = functionalSpecs(from).filter((spec) => !patched.has(spec));

  const forAgent = steerableChanges(toSpec(steering.agent), mine, built);
  if (forAgent.steer.length === 0) return undefined;
  // The record takes what the agent is told but what was built before it uses too.
  const forRecord = steerableChanges(toSpec(steering.target), mine, built);
  const recordChanges = forRecord.steer.filter((change) => !forRecord.shared.includes(change));
  return {
    target: parseTree(applyChanges(serializeTree(steering.target), recordChanges)),
    agent: parseTree(applyChanges(serializeTree(steering.agent), forAgent.steer)),
    steered: forAgent.steer,
  };
}
