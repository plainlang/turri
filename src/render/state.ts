import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractConceptsFromDefinition, extractConceptsFromSpecText } from "../plain/concepts.ts";
import {
  ACCEPTANCE_TESTS,
  DEFINITIONS,
  FUNCTIONAL_REQUIREMENTS,
  getFrids,
  getHashValue,
  getInheritedFunctionalSpecs,
  getSpecificationItemMarkdown,
  getSpecificationsForFrid,
  NON_FUNCTIONAL_REQUIREMENTS,
  REQUIRED_FUNCTIONAL_SPECS,
  TEST_REQUIREMENTS,
  type MarshalledPlainSource,
  type SpecificationItem,
} from "../plain/spec.ts";

/**
 * What a build directory's code was built from: the marshalled plain tree, and nothing else.
 *
 * `plain_modules/<module>/code/.plainwright.json` holds the tree as JSON - the definitions, the
 * implementation and test reqs, the module's own functional specs and those it inherits - as
 * the code in that directory implements them. Not whether its tests passed, not which files each
 * functionality touched: what matters is that the tests run when they have to, and the history
 * says what happened. The tree answers the one question nothing else can: what is this code
 * built from, so what does it take to bring it up to the spec as it now stands.
 *
 * It is written only when a unit of work lands - a functionality rendered, a spec change
 * rendered - and it lives in the code directory, committed with the code, so undoing a failed
 * unit (`abandonWork`) puts the tree back with the code it describes.
 */

export const STATE_FILE = ".plainwright.json";

/** The sections a module shares across all its functionalities, as text. */
export interface SharedSections {
  [DEFINITIONS]: string[];
  [NON_FUNCTIONAL_REQUIREMENTS]: string[];
  [TEST_REQUIREMENTS]: string[];
}

/** A functional spec of a module this one requires: documented, not built here. */
export interface RequiredSpec {
  module: string;
  frid: string;
  spec: string;
  acceptanceTests?: string[];
}

type Item = SpecificationItem & { module?: string; frid?: string };

const items = (tree: MarshalledPlainSource | null | undefined, heading: string): Item[] =>
  ((tree?.[heading] as Item[] | undefined) ?? []).slice();

/** A record written before the tree was all it held: v2's layout, with its sections as text. */
interface StoredV2 {
  version: number;
  module: string;
  [DEFINITIONS]?: string[];
  [NON_FUNCTIONAL_REQUIREMENTS]?: string[];
  [TEST_REQUIREMENTS]?: string[];
  [FUNCTIONAL_REQUIREMENTS]: Array<{ module: string; frid: string; spec: string; "acceptance tests"?: string[]; unitTests?: string }>;
}

/** The first layout of all: one context snapshot per functionality. */
interface StoredLegacy {
  module: string;
  functionalities: Record<string, { frid: string; unitTests?: string; specifications: Record<string, string[]> }>;
}

const asItem = (markdown: string, acceptanceTests?: string[]): Item => ({
  markdown,
  ...(acceptanceTests !== undefined && acceptanceTests.length > 0 ? { [ACCEPTANCE_TESTS]: acceptanceTests.map((test) => ({ markdown: test })) } : {}),
});

/**
 * An older record, as the tree it describes. Its own functional specs are taken up to the first
 * that did not build: the tree says what is built, and the one that failed is not.
 */
function treeFromV2(stored: StoredV2): MarshalledPlainSource {
  const own = stored[FUNCTIONAL_REQUIREMENTS].filter((entry) => entry.module === stored.module).sort((a, b) => Number(a.frid) - Number(b.frid));
  const built: Item[] = [];
  for (const [index, entry] of own.entries()) {
    if (Number(entry.frid) !== index + 1 || entry.unitTests !== "passed") break;
    built.push(asItem(entry.spec, entry["acceptance tests"]));
  }
  const required = stored[FUNCTIONAL_REQUIREMENTS]
    .filter((entry) => entry.module !== stored.module)
    .map((entry) => ({ ...asItem(entry.spec, entry["acceptance tests"]), module: entry.module, frid: entry.frid }));
  return withoutEmpty({
    [DEFINITIONS]: (stored[DEFINITIONS] ?? []).map((text) => asItem(text)),
    [NON_FUNCTIONAL_REQUIREMENTS]: (stored[NON_FUNCTIONAL_REQUIREMENTS] ?? []).map((text) => asItem(text)),
    [TEST_REQUIREMENTS]: (stored[TEST_REQUIREMENTS] ?? []).map((text) => asItem(text)),
    [FUNCTIONAL_REQUIREMENTS]: built,
    [REQUIRED_FUNCTIONAL_SPECS]: required,
  });
}

function treeFromLegacy(stored: StoredLegacy): MarshalledPlainSource {
  const entries = Object.values(stored.functionalities).sort((a, b) => Number(a.frid) - Number(b.frid));
  const latest = entries.at(-1)?.specifications;
  const built: Item[] = [];
  for (const [index, entry] of entries.entries()) {
    if (Number(entry.frid) !== index + 1 || entry.unitTests !== "passed") break;
    built.push(asItem(entry.specifications[FUNCTIONAL_REQUIREMENTS]?.at(-1) ?? "", entry.specifications[ACCEPTANCE_TESTS]));
  }
  return withoutEmpty({
    [DEFINITIONS]: (latest?.[DEFINITIONS] ?? []).map((text) => asItem(text)),
    [NON_FUNCTIONAL_REQUIREMENTS]: (latest?.[NON_FUNCTIONAL_REQUIREMENTS] ?? []).map((text) => asItem(text)),
    [TEST_REQUIREMENTS]: (latest?.[TEST_REQUIREMENTS] ?? []).map((text) => asItem(text)),
    [FUNCTIONAL_REQUIREMENTS]: built,
  });
}

/** A tree without the sections it has nothing in, as the parser leaves them out. */
function withoutEmpty(tree: MarshalledPlainSource): MarshalledPlainSource {
  return Object.fromEntries(Object.entries(tree).filter(([, value]) => !Array.isArray(value) || value.length > 0));
}

/** The tree the code in `buildDir` was built from - or null when nothing records one. */
export function readBuiltTree(buildDir: string): MarshalledPlainSource | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(buildDir, STATE_FILE), "utf8"));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof (raw as { version?: unknown }).version === "number") return treeFromV2(raw as StoredV2);
  if ("functionalities" in raw) return treeFromLegacy(raw as StoredLegacy);
  return raw as MarshalledPlainSource;
}

export function writeBuiltTree(buildDir: string, tree: MarshalledPlainSource): void {
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(join(buildDir, STATE_FILE), `${JSON.stringify(withoutEmpty(tree), null, 2)}\n`);
}

/** The concepts an item uses, its acceptance tests included. */
function conceptsUsedBy(item: Item): string[] {
  return [item, ...(item[ACCEPTANCE_TESTS] ?? [])].flatMap((part) => extractConceptsFromSpecText(part.markdown));
}

/** The concepts a definition defines. */
function conceptsDefinedBy(item: Item): string[] {
  return extractConceptsFromDefinition(item.markdown)[0];
}

/**
 * The tree after functionality `frid` of `current` is built on the code: what was built before,
 * with that functional spec in its place - and whatever it is the first to need.
 *
 * Only what the render actually built is recorded. The definitions already built stay as they
 * were built, even where the spec has moved on since, so a later sync still sees that change;
 * a definition the functionality uses that nothing built defined is added, with every concept
 * it uses in turn. The reqs are taken from the spec when nothing of the module's own was built
 * before - the first functionality is built with all of them - and otherwise stay as built,
 * with any req added that names a concept this functionality brought in.
 */
export function withBuiltFunctionality(built: MarshalledPlainSource | null, current: MarshalledPlainSource, frid: string): MarshalledPlainSource {
  const index = Number(frid) - 1;
  const currentSpecs = items(current, FUNCTIONAL_REQUIREMENTS);
  const item = currentSpecs[index];
  if (item === undefined) throw new Error(`Functionality ${frid} does not exist.`);

  const first = items(built, FUNCTIONAL_REQUIREMENTS).length === 0;
  // What it inherits is what the code was started from - or rebuilt here since - not what the
  // required modules' specs say now. Only with nothing recorded are those taken.
  const inherited = items(built, REQUIRED_FUNCTIONAL_SPECS).length > 0 ? items(built, REQUIRED_FUNCTIONAL_SPECS) : items(current, REQUIRED_FUNCTIONAL_SPECS);
  // Built on the functionalities before it: any the record lacks are there in the code.
  const specs = items(built, FUNCTIONAL_REQUIREMENTS);
  for (let before = specs.length; before < index; before += 1) specs.push(currentSpecs[before]!);
  specs[index] = item;

  if (first) {
    return withoutEmpty({
      ...current,
      [FUNCTIONAL_REQUIREMENTS]: specs,
      [REQUIRED_FUNCTIONAL_SPECS]: inherited,
    });
  }

  // The definitions it needs that nothing built defined, and the ones those need.
  const definitions = items(built, DEFINITIONS);
  const defined = new Set(definitions.flatMap(conceptsDefinedBy));
  const available = items(current, DEFINITIONS);
  const added = new Set<string>();
  const wanted = [...conceptsUsedBy(item), ...specs.slice(0, index).flatMap(conceptsUsedBy)];
  while (wanted.length > 0) {
    const concept = wanted.pop()!;
    if (defined.has(concept)) continue;
    const definition = available.find((candidate) => conceptsDefinedBy(candidate).includes(concept));
    if (definition === undefined) continue;
    definitions.push(definition);
    for (const concept of conceptsDefinedBy(definition)) {
      defined.add(concept);
      added.add(concept);
    }
    wanted.push(...conceptsUsedBy(definition));
  }
  // A req that names what this functionality brought in came with it.
  const withNew = (heading: string) => {
    const kept = items(built, heading);
    const known = new Set(kept.map((entry) => JSON.stringify(entry)));
    const brought = items(current, heading).filter(
      (entry) => !known.has(JSON.stringify(entry)) && conceptsUsedBy(entry).some((concept) => added.has(concept)),
    );
    return [...kept, ...brought];
  };
  return withoutEmpty({
    ...built,
    [DEFINITIONS]: definitions,
    [NON_FUNCTIONAL_REQUIREMENTS]: withNew(NON_FUNCTIONAL_REQUIREMENTS),
    [TEST_REQUIREMENTS]: withNew(TEST_REQUIREMENTS),
    [FUNCTIONAL_REQUIREMENTS]: specs,
    [REQUIRED_FUNCTIONAL_SPECS]: inherited,
  });
}

/** Record that functionality `frid` of `current` is built in `buildDir`. */
export function recordBuiltFunctionality(buildDir: string, current: MarshalledPlainSource, frid: string): MarshalledPlainSource {
  const tree = withBuiltFunctionality(readBuiltTree(buildDir), current, frid);
  writeBuiltTree(buildDir, tree);
  return tree;
}

/**
 * Record, in the codebase of a later module, that a functional spec of a module it requires was
 * rebuilt there, as that module's spec - `item` - now has it. Nothing else of its tree moves.
 */
export function recordBuiltRequiredFunctionality(buildDir: string, module: string, frid: string, item: SpecificationItem): void {
  const built = readBuiltTree(buildDir) ?? {};
  const required = items(built, REQUIRED_FUNCTIONAL_SPECS);
  const at = required.findIndex((entry) => entry.module === module && entry.frid === frid);
  const entry = { ...item, module, frid };
  if (at === -1) required.push(entry);
  else required[at] = entry;
  writeBuiltTree(buildDir, { ...built, [REQUIRED_FUNCTIONAL_SPECS]: required });
}

/**
 * Carry what a codebase is built from into a new module's, started on top of its code. The code
 * comes with everything the source's tree has - what it inherits, and its own functional specs -
 * as the new module's inheritance. The new module has built nothing of its own: a tree it already
 * has keeps its own functional specs, and the rest of it.
 */
export function inheritBuiltTree(fromBuildDir: string, toBuildDir: string, fromModule: string): void {
  const source = readBuiltTree(fromBuildDir);
  if (source === null) return;
  const carried = [
    ...items(source, REQUIRED_FUNCTIONAL_SPECS),
    ...items(source, FUNCTIONAL_REQUIREMENTS).map((item, index) => ({ ...item, module: fromModule, frid: String(index + 1) })),
  ];
  const target = readBuiltTree(toBuildDir) ?? {};
  writeBuiltTree(toBuildDir, { ...target, [REQUIRED_FUNCTIONAL_SPECS]: carried });
}

/** The required modules' functional specs a codebase is built on, as text - or null when nothing records them. */
export function builtRequiredSpecs(buildDir: string): RequiredSpec[] | null {
  const built = readBuiltTree(buildDir);
  if (built === null) return null;
  return getInheritedFunctionalSpecs(built);
}

/** What a functionality would be rendered from right now: its own spec, the shared sections, and a hash of it all. */
export function specStateFor(
  tree: MarshalledPlainSource,
  frid: string,
): { specHash: string; spec: string; acceptanceTests?: string[]; sections: SharedSections } {
  const [specifications] = getSpecificationsForFrid(tree, frid);
  return {
    specHash: getHashValue(specifications),
    spec: specifications[FUNCTIONAL_REQUIREMENTS].at(-1) ?? "",
    acceptanceTests: specifications[ACCEPTANCE_TESTS],
    sections: {
      [DEFINITIONS]: specifications[DEFINITIONS],
      [NON_FUNCTIONAL_REQUIREMENTS]: specifications[NON_FUNCTIONAL_REQUIREMENTS],
      [TEST_REQUIREMENTS]: specifications[TEST_REQUIREMENTS],
    },
  };
}

/** A module's shared sections as they stand, with or without a functional spec to read them through. */
export function sectionsOf(tree: MarshalledPlainSource): SharedSections {
  const render = (heading: string) =>
    ((tree[heading] as Array<Parameters<typeof getSpecificationItemMarkdown>[0]> | undefined) ?? []).map((item) =>
      getSpecificationItemMarkdown(item, {}, true),
    );
  return {
    [DEFINITIONS]: render(DEFINITIONS),
    [NON_FUNCTIONAL_REQUIREMENTS]: render(NON_FUNCTIONAL_REQUIREMENTS),
    [TEST_REQUIREMENTS]: render(TEST_REQUIREMENTS),
  };
}

export type PendingReason = "never built" | "specification changed";

export interface Pending {
  frid: string;
  reason: PendingReason;
}

/**
 * A functionality's own specification: its functional spec and its acceptance tests.
 *
 * The context a functionality is rendered from also holds every spec before it, the
 * definitions and the reqs. Those are left out here on purpose: changing functionality 2
 * changes what 3 and 4 were rendered from, but it does not change what 3 and 4 are, and
 * rebuilding everything after an edit would turn one fix into a rebuild of the rest of the
 * module. The regression suite, run after every regeneration, is what catches a later
 * functionality the edit broke.
 */
function ownSpec(entry: { spec: string; acceptanceTests?: string[] }): string {
  return JSON.stringify([entry.spec, entry.acceptanceTests ?? []]);
}

/**
 * Which functionalities still need building, in order.
 *
 * `upTo` is inclusive: asking for functionality 4 asks for everything up to and including
 * it, because 4 is built on top of 1 to 3. A functionality whose own specification has
 * changed since it was built counts as pending even though code for it exists - that is
 * the whole reason the specification is stored rather than just a flag.
 */
export function pendingFrids(
  tree: MarshalledPlainSource,
  buildDir: string,
  upTo?: string,
): Pending[] {
  const all = [...getFrids(tree)];
  const limit = upTo === undefined ? all.length : all.indexOf(upTo) + 1;
  if (upTo !== undefined && limit === 0) {
    throw new Error(`Functionality ${upTo} does not exist. Available: ${all.join(", ")}.`);
  }

  const built = readBuiltTree(buildDir);
  const builtFrids = new Set(built === null ? [] : getFrids(built));
  const pending: Pending[] = [];

  for (const frid of all.slice(0, limit)) {
    if (!builtFrids.has(frid)) {
      pending.push({ frid, reason: "never built" });
      continue;
    }
    if (ownSpec(specStateFor(built!, frid)) !== ownSpec(specStateFor(tree, frid))) {
      pending.push({ frid, reason: "specification changed" });
    }
  }

  return pending;
}

/**
 * Functionalities whose built code no longer matches the specification.
 *
 * Narrower than `pendingFrids` on purpose: only things that were actually rendered and
 * have since changed. A specification edited before it was ever built is not stale - there
 * is nothing built to be stale - and re-queueing it would be work for nothing.
 */
export function staleFrids(tree: MarshalledPlainSource, buildDir: string): Pending[] {
  return pendingFrids(tree, buildDir).filter((entry) => entry.reason === "specification changed");
}

export function isModuleUpToDate(tree: MarshalledPlainSource, buildDir: string): boolean {
  return existsSync(buildDir) && pendingFrids(tree, buildDir).length === 0;
}

export function describePending(pending: Pending[]): string {
  if (pending.length === 0) return "everything is up to date";
  return pending.map((p) => `${p.frid} (${p.reason})`).join(", ");
}
