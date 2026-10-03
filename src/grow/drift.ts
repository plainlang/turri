import { DEFAULT_CONCEPTS, extractConceptsFromDefinition, extractConceptsFromSpecText } from "../plain/concepts.ts";
import { DEFINITIONS, FUNCTIONAL_REQUIREMENTS, REQUIRED_FUNCTIONAL_SPECS, type MarshalledPlainSource } from "../plain/spec.ts";
import { codeTree, conformanceTarget, marksGrowAgain, type Chosen } from "./records.ts";
import { applyChanges, changesBetween, parseTree, resourcesChanged, serializeTree, type SpecChange } from "./spec-steps.ts";

/**
 * The work, derived from the records - see docs/growing.md. Nothing here is stored: what is left
 * to build is the difference between what a record says is built and what the spec says now, worked
 * out again whenever either changes.
 *
 * - Code work: from the code record to the spec as the code sees it.
 * - Conformance work: from the tests record to what the conformance tests are to be written for now -
 *   the chosen functional specs the code is built from.
 *
 * A job is a set of those changes. What it tells its agents follows from the functional specs it
 * touches - its cases - and a running job is stopped once the spec no longer wants what it makes.
 */

/** Everything left to build in the code: from what the code record says it is built from, to the spec now. */
export function codeWork(record: MarshalledPlainSource | null, spec: MarshalledPlainSource): SpecChange[] {
  return changesBetween(serializeTree(codeTree(record ?? {})), serializeTree(codeTree(spec)));
}

/** Everything left to do in the conformance tests: from what the tests record says they are written for, to what they are to be now. */
export function conformanceWork(tests: MarshalledPlainSource | null, code: MarshalledPlainSource | null, spec: MarshalledPlainSource, chosen?: Chosen): SpecChange[] {
  return changesBetween(serializeTree(tests ?? {}), serializeTree(conformanceTarget(code, tests, spec, chosen)));
}

/**
 * A functional spec a job touches: its number - in the spec after the job, or, taken out, before it - its first line,
 * and the module it belongs to: each module numbers its own from 1, so a number alone can mean two.
 */
export interface TouchedSpec {
  frid: string;
  text: string;
  module?: string;
}

/**
 * What a job does to the functional specs, and so what its agents are told:
 *
 * - fresh: the module requires none and nothing is built - the project is set up first.
 * - add: functional specs that are new.
 * - patch: functional specs changed - their text, their acceptance tests, or a concept they use: a
 *   change to what is built, never built again from scratch.
 * - again: functional specs marked to grow again (`rejuvenate`): their code is built, and is grown again - rewritten
 *   or started over, doing what the spec says now - with what it replaces taken out. A functional spec of a module
 *   this one requires, grown again here, is one too.
 * - delete: functional specs taken out.
 * - mechanical: none of those - only reqs, or definitions no functional spec uses. Existing tests may
 *   change only mechanically, and no new ones are written.
 *
 * A job can hold several of add, patch and delete at once: its prompt has a section for each.
 */
export interface JobCases {
  fresh: boolean;
  add: TouchedSpec[];
  patch: TouchedSpec[];
  again: TouchedSpec[];
  delete: TouchedSpec[];
  mechanical: boolean;
}

interface FunctionalItem {
  markdown: string;
  frid?: string;
}

const functionalSpecs = (tree: MarshalledPlainSource): FunctionalItem[] => (tree[FUNCTIONAL_REQUIREMENTS] as FunctionalItem[] | undefined) ?? [];

const firstLine = (markdown: string) => markdown.trim().split("\n")[0]!.replace(/^-\s*/, "").trim();

/** An item of a serialized tree, read back. */
const itemOfLine = (line: string | undefined): FunctionalItem | undefined => {
  if (line === undefined) return undefined;
  try {
    return JSON.parse(line) as FunctionalItem;
  } catch {
    return undefined;
  }
};

/** The concept a definition defines, from its text. */
const definedBy = (markdown: string): string[] => extractConceptsFromDefinition(markdown)[0];

/** The concepts a text names, the predefined ones left out. */
const namedIn = (text: string): string[] => extractConceptsFromSpecText(text).filter((concept) => !DEFAULT_CONCEPTS.has(concept));

/**
 * Every concept a functional spec uses: those its text names, and those their definitions name in
 * turn, as far as it goes.
 */
export function conceptsUsed(markdown: string, definitions: Array<{ markdown: string }>): Set<string> {
  const byConcept = new Map<string, string>();
  for (const definition of definitions) for (const concept of definedBy(definition.markdown)) byConcept.set(concept, definition.markdown);
  const used = new Set<string>();
  const visit = (text: string) => {
    for (const concept of namedIn(text)) {
      if (used.has(concept)) continue;
      used.add(concept);
      const definition = byConcept.get(concept);
      if (definition !== undefined) visit(definition);
    }
  };
  visit(markdown);
  return used;
}

/**
 * The cases of a job: `before` is the tree it starts from - the record, or what the jobs ahead of it
 * leave - and `changes` the changes it makes, found from `before`. `fresh`: the module requires none
 * and nothing is built.
 *
 * A functional spec is patched when its item changed, or when a concept it uses - as the spec after
 * the job defines it, or as it was defined before - is defined anew, changed or taken out by the job.
 * `module`: the module whose codebase it is - its own functional specs are that module's.
 */
export function casesOf(before: MarshalledPlainSource, changes: SpecChange[], options: { fresh?: boolean; module?: string } = {}): JobCases {
  const beforeText = serializeTree(before);
  const after = parseTree(applyChanges(beforeText, changes));
  const numberIn = (tree: MarshalledPlainSource, item: FunctionalItem | undefined, position: number): string => {
    if (item?.frid !== undefined) return item.frid;
    const specs = functionalSpecs(tree);
    const at = item === undefined ? -1 : specs.findIndex((spec) => spec.markdown === item.markdown);
    return String(at === -1 ? position : at + 1);
  };
  const own = options.module !== undefined ? { module: options.module } : {};
  const add: TouchedSpec[] = [];
  const patch: TouchedSpec[] = [];
  const again: TouchedSpec[] = [];
  const removed: TouchedSpec[] = [];
  for (const change of changes) {
    const was = itemOfLine(change.before);
    const is = itemOfLine(change.after);
    // Marked to grow again: grown again, whatever else changed in its text - its own or, required, another module's.
    if (change.kind === "change" && is !== undefined && marksGrowAgain(was)) {
      const required = change.section === REQUIRED_FUNCTIONAL_SPECS ? (is as FunctionalItem & { module?: string }) : undefined;
      if (change.section === FUNCTIONAL_REQUIREMENTS) again.push({ frid: numberIn(after, is, change.position), text: firstLine(is.markdown), ...own });
      else if (required !== undefined) again.push({ frid: `${required.frid ?? change.position}`, text: firstLine(is.markdown), ...(required.module !== undefined ? { module: required.module } : {}) });
      continue;
    }
    if (change.section !== FUNCTIONAL_REQUIREMENTS) continue;
    if (change.kind === "add" && is !== undefined) add.push({ frid: numberIn(after, is, change.position), text: firstLine(is.markdown), ...own });
    else if (change.kind === "remove" && was !== undefined) removed.push({ frid: numberIn(before, was, change.position), text: firstLine(was.markdown), ...own });
    else if (change.kind === "change" && is !== undefined) patch.push({ frid: numberIn(after, is, change.position), text: firstLine(is.markdown), ...own });
  }

  // The concepts the job defines anew, changes or takes out.
  const redefined = new Set<string>();
  for (const change of changes) {
    if (change.section !== DEFINITIONS) continue;
    for (const line of [change.before, change.after]) {
      const item = itemOfLine(line);
      if (item !== undefined) for (const concept of definedBy(item.markdown)) redefined.add(concept);
    }
  }
  if (redefined.size > 0) {
    const touched = new Set([...add, ...patch, ...again].filter((spec) => spec.module === options.module).map((spec) => spec.frid));
    const definitionsAfter = (after[DEFINITIONS] as Array<{ markdown: string }> | undefined) ?? [];
    const definitionsBefore = (before[DEFINITIONS] as Array<{ markdown: string }> | undefined) ?? [];
    functionalSpecs(after).forEach((item, index) => {
      const frid = item.frid ?? String(index + 1);
      if (touched.has(frid)) return;
      const uses = new Set([...conceptsUsed(item.markdown, definitionsAfter), ...conceptsUsed(item.markdown, definitionsBefore)]);
      if ([...redefined].some((concept) => uses.has(concept))) patch.push({ frid, text: firstLine(item.markdown), ...own });
    });
    patch.sort((a, b) => Number(a.frid) - Number(b.frid));
  }

  return {
    fresh: options.fresh === true,
    add,
    patch,
    again,
    delete: removed,
    mechanical: add.length === 0 && patch.length === 0 && again.length === 0 && removed.length === 0,
  };
}

/** Two changes are the same change when they do the same to the same item. */
function sameChange(a: SpecChange, b: SpecChange): boolean {
  return a.section === b.section && a.kind === b.kind && (a.before ?? "") === (b.before ?? "") && (a.after ?? "") === (b.after ?? "");
}

/**
 * Whether a running job may finish: every change it makes is still part of the work as it is now -
 * both measured from the same record, which nothing changes while the job runs. When one is not, the
 * job is making something the spec no longer wants, and it is stopped and rolled back.
 */
/**
 * Why a running job is no longer wanted, in a line: the files it links that hold something else now - the commonest
 * cause, a resource edited while the job grew from it - else the items whose text changed under it, by section and place.
 */
export function whyNotWanted(running: SpecChange[], work: SpecChange[]): string {
  const taken = new Set<number>();
  const gone = running.filter((mine) => {
    const at = work.findIndex((change, index) => !taken.has(index) && sameChange(mine, change));
    if (at === -1) return true;
    taken.add(at);
    return false;
  });
  const files = new Set<string>();
  const items: string[] = [];
  for (const mine of gone) {
    // The same item as the spec has it now: by section and place.
    const now = work.find((change) => change.section === mine.section && change.position === mine.position);
    const changedFiles = now !== undefined ? resourcesChanged(mine.after, now.after).map((resource) => resource.target) : [];
    if (changedFiles.length > 0) changedFiles.forEach((file) => files.add(file));
    else items.push(`${mine.section} ${mine.position}`);
  }
  const parts = [
    ...(files.size > 0 ? [`${[...files].join(", ")} ${files.size === 1 ? "holds" : "hold"} something else now`] : []),
    ...(items.length > 0 ? [`${items.join(", ")} ${items.length === 1 ? "reads" : "read"} otherwise now`] : []),
  ];
  return parts.length > 0 ? parts.join("; ") : "the spec it was building from changed";
}

export function stillWanted(running: SpecChange[], work: SpecChange[]): boolean {
  const taken = new Set<number>();
  return running.every((mine) => {
    const at = work.findIndex((change, index) => !taken.has(index) && sameChange(mine, change));
    if (at === -1) return false;
    taken.add(at);
    return true;
  });
}
