import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

/**
 * The tree after functionality `frid` of `current` is built on the code: what was built before,
 * with that functional spec in its place, and the module's definitions, implementation reqs and
 * test reqs as the spec has them. Every functional spec of a module shares those - the parser
 * gives each one all of them - so the functionality was built with all of them.
 *
 * What it inherits stays as built: the code it was started from, or what was rebuilt here since.
 * Only with nothing recorded is it taken from the spec.
 */
export function withBuiltFunctionality(built: MarshalledPlainSource | null, current: MarshalledPlainSource, frid: string): MarshalledPlainSource {
  const index = Number(frid) - 1;
  const currentSpecs = items(current, FUNCTIONAL_REQUIREMENTS);
  const item = currentSpecs[index];
  if (item === undefined) throw new Error(`Functionality ${frid} does not exist.`);

  // Built on the functionalities before it: any the record lacks are there in the code.
  const specs = items(built, FUNCTIONAL_REQUIREMENTS);
  for (let before = specs.length; before < index; before += 1) specs.push(currentSpecs[before]!);
  specs[index] = item;

  const inherited = items(built, REQUIRED_FUNCTIONAL_SPECS).length > 0 ? items(built, REQUIRED_FUNCTIONAL_SPECS) : items(current, REQUIRED_FUNCTIONAL_SPECS);
  return withoutEmpty({ ...current, [FUNCTIONAL_REQUIREMENTS]: specs, [REQUIRED_FUNCTIONAL_SPECS]: inherited });
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

/**
 * Whether every functionality is built from its current spec. The sections around them are not
 * looked at here: `reachedByRendering` says whether the code is built from the spec as a whole.
 */
export function isModuleUpToDate(tree: MarshalledPlainSource, buildDir: string): boolean {
  return existsSync(buildDir) && pendingFrids(tree, buildDir).length === 0;
}

export function describePending(pending: Pending[]): string {
  if (pending.length === 0) return "everything is up to date";
  return pending.map((p) => `${p.frid} (${p.reason})`).join(", ");
}
