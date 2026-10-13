import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ACCEPTANCE_TESTS,
  DEFINITIONS,
  FUNCTIONAL_REQUIREMENTS,
  NON_FUNCTIONAL_REQUIREMENTS,
  REQUIRED_FUNCTIONAL_SPECS,
  TEST_REQUIREMENTS,
  type MarshalledPlainSource,
  type SpecificationItem,
} from "../plain/spec.ts";
import { committedText } from "./lineage.ts";

/**
 * What a module is built from, in two records - see docs/regenerating.md.
 *
 * - The code record, `code/.turri.json`: the spec the code is built from, without what is only
 *   for conformance - the test reqs, and the acceptance tests under each functional spec.
 * - The tests record, `tests/.turri.json`: the functional specs the conformance tests are
 *   written for - a subset of the code record's, each with its number and its acceptance tests - the
 *   definitions and implementation reqs they were written against, and the test reqs they follow.
 *
 * The tests record is always a substate of the code record: a conformance test exercises
 * functionality, and only functionality in the code can be tested. Each record is committed with
 * what it describes, in the module's `.plaingit`, so rolling a unit of work back puts it back too.
 */

export const RECORD_FILE = ".turri.json";

/**
 * A functional spec in the code record marked to regenerate again: its code is built, and is to be regenerated again
 * all the same - `regenerate` with functionalities named. The mark makes the record differ from the spec at that item,
 * so the work loop plans it as it plans any change, and the job that regenerates it writes the item back without it.
 */
export const REGENERATE_AGAIN = "regenerate_again";

/** Whether a record's item is marked to regenerate again. */
export function marksRegenerateAgain(item: unknown): boolean {
  return typeof item === "object" && item !== null && (item as Record<string, unknown>)[REGENERATE_AGAIN] === true;
}

type Item = SpecificationItem & { module?: string; frid?: string };

const itemsOf = (tree: MarshalledPlainSource | null | undefined, heading: string): Item[] => ((tree?.[heading] as Item[] | undefined) ?? []).slice();

/** A tree without the sections it has nothing in, as the parser leaves them out. */
function withoutEmpty(tree: MarshalledPlainSource): MarshalledPlainSource {
  return Object.fromEntries(Object.entries(tree).filter(([, value]) => !Array.isArray(value) || value.length > 0));
}

/** A functional spec as the code sees it: without its acceptance tests. */
function withoutAcceptanceTests(item: Item): Item {
  const { [ACCEPTANCE_TESTS]: _tests, ...rest } = item;
  return rest;
}

/** The spec as the code is built from it: no test reqs, and no acceptance tests under the functional specs. */
export function codeTree(tree: MarshalledPlainSource): MarshalledPlainSource {
  const { [TEST_REQUIREMENTS]: _testReqs, ...rest } = tree;
  return withoutEmpty({
    ...rest,
    [FUNCTIONAL_REQUIREMENTS]: itemsOf(tree, FUNCTIONAL_REQUIREMENTS).map(withoutAcceptanceTests),
    [REQUIRED_FUNCTIONAL_SPECS]: itemsOf(tree, REQUIRED_FUNCTIONAL_SPECS).map(withoutAcceptanceTests),
  });
}

/** A linked resource as the trees compared have it: its link, and the hash of what its file holds. */
interface DigestedResource {
  text: string;
  target: string;
  digest?: string;
}

/** Every linked resource in a tree, wherever an item has them - a functional spec, its acceptance tests, a definition, a req. */
function mapResources(value: unknown, map: (resource: DigestedResource) => DigestedResource): unknown {
  if (Array.isArray(value)) return value.map((entry) => mapResources(entry, map));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) =>
      key === "linked_resources" && Array.isArray(entry) ? [key, (entry as DigestedResource[]).map(map)] : [key, mapResources(entry, map)],
    ),
  );
}

/**
 * A module's tree with the hash of each linked resource's content beside its link: the file is part of the spec,
 * so a change to what it holds is a change to the item that links it - and, a definition linking it, to every
 * functional spec using the concept. Found as the parser finds it: the spec's own folder first, then the other
 * template folders, then the current directory.
 */
export function withResourceDigests(tree: MarshalledPlainSource, dirs: string[]): MarshalledPlainSource {
  return mapResources(tree, (resource) => {
    for (const path of [...dirs.map((dir) => resolve(dir, resource.target)), resolve(resource.target)]) {
      try {
        return { ...resource, digest: createHash("sha256").update(readFileSync(path)).digest("hex") };
      } catch {
        /* not here */
      }
    }
    return resource;
  }) as MarshalledPlainSource;
}

/**
 * A record written before linked resources were hashed, with the hashes of `spec` where its links are the same:
 * what it was built from is taken to be the resource as it is now, rather than every item linking one built again.
 */
export function adoptDigests(record: MarshalledPlainSource | null, spec: MarshalledPlainSource): MarshalledPlainSource | null {
  if (record === null) return null;
  const digests = new Map<string, string>();
  mapResources(spec, (resource) => {
    if (resource.digest !== undefined) digests.set(`${resource.text}\n${resource.target}`, resource.digest);
    return resource;
  });
  return mapResources(record, (resource) => {
    if (resource.digest !== undefined) return resource;
    const digest = digests.get(`${resource.text}\n${resource.target}`);
    return digest === undefined ? resource : { ...resource, digest };
  }) as MarshalledPlainSource;
}

/** Items of a section, tagged with the module they come from, unless they already say. */
const taggedWith = (items: Item[], module: string): Item[] => items.map((item) => (item.module !== undefined ? item : { ...item, module }));

/**
 * The spec a codebase is built from: the spec of its whole requires chain, as its code holds it. A
 * codebase is built on the code of the modules below it, so its code implements their definitions and
 * implementation reqs too: those come tagged with their module, bottom of the chain first, and the
 * module's own untagged after them. An item a lower module already has - the same text, from an import
 * they share - is not the module's own again: its code implements it already. The functional specs of the
 * modules below are the ones it inherits, as the parser gives them; its test reqs are its own.
 *
 * `trees`: every module of the chain, bottom first - the module itself last.
 */
export function chainTree(trees: Array<{ module: string; tree: MarshalledPlainSource }>): MarshalledPlainSource {
  const own = trees.at(-1);
  if (own === undefined) return {};
  const lower = trees.slice(0, -1);
  const section = (heading: string): Item[] => {
    const seen = new Set<string>();
    const out: Item[] = [];
    for (const { module, tree } of lower) {
      for (const item of taggedWith(itemsOf(tree, heading), module)) {
        const text = item.markdown.trim();
        if (seen.has(text)) continue;
        seen.add(text);
        out.push(item);
      }
    }
    for (const item of itemsOf(own.tree, heading)) if (!seen.has(item.markdown.trim())) out.push(item);
    return out;
  };
  return withoutEmpty({
    ...own.tree,
    [DEFINITIONS]: section(DEFINITIONS),
    [NON_FUNCTIONAL_REQUIREMENTS]: section(NON_FUNCTIONAL_REQUIREMENTS),
  });
}

/**
 * What a new module's codebase starts from, copied from the code of the module it requires: that module's
 * record, as a lower module's - its own definitions and implementation reqs tagged with it, its functional
 * specs among the ones inherited. The new module has built nothing of its own yet.
 */
export function inheritedRecord(source: MarshalledPlainSource, sourceModule: string): MarshalledPlainSource {
  const inherited = [
    ...itemsOf(source, REQUIRED_FUNCTIONAL_SPECS),
    ...itemsOf(source, FUNCTIONAL_REQUIREMENTS).map((item, index) => ({ ...withoutAcceptanceTests(item), module: sourceModule, frid: String(index + 1) })),
  ];
  return withoutEmpty({
    [DEFINITIONS]: taggedWith(itemsOf(source, DEFINITIONS), sourceModule),
    [NON_FUNCTIONAL_REQUIREMENTS]: taggedWith(itemsOf(source, NON_FUNCTIONAL_REQUIREMENTS), sourceModule),
    [REQUIRED_FUNCTIONAL_SPECS]: inherited,
  });
}

/** Which functional specs are to have conformance tests, by number. Default: every one. */
export type Chosen = (frid: string) => boolean;

/**
 * What the conformance tests are to be written for, now: of the functional specs the code is built
 * from, those chosen, each as the spec has it now with its acceptance tests - and the code's
 * definitions and implementation reqs, with the test reqs as the spec has them now.
 *
 * Conformance follows the code, never goes ahead of it: a functional spec whose code is not caught up
 * with the spec - its text in the code record is not the spec's, or the code record does not have it at
 * all, as while it is regenerated again - stays as the tests record has it, until the code lands. Its tests are
 * taken out only once the spec and the code have both dropped it.
 */
export function conformanceTarget(code: MarshalledPlainSource | null, tests: MarshalledPlainSource | null, spec: MarshalledPlainSource, chosen: Chosen = () => true): MarshalledPlainSource {
  const built = itemsOf(code, FUNCTIONAL_REQUIREMENTS);
  const now = itemsOf(spec, FUNCTIONAL_REQUIREMENTS);
  const tested = new Map(itemsOf(tests, FUNCTIONAL_REQUIREMENTS).map((item) => [item.frid, item]));
  const inCode = new Set(built.map((item) => item.markdown.trim()));
  const specs: Item[] = [];
  for (let index = 0; index < Math.max(built.length, now.length); index += 1) {
    const frid = String(index + 1);
    const current = now[index];
    if (current !== undefined && built[index]?.markdown.trim() === current.markdown.trim()) {
      if (chosen(frid)) specs.push({ ...current, frid });
      continue;
    }
    // The code is behind the spec here - built from other text, not built, or being regenerated again: its tests stay
    // as they are until it catches up. Taken out of the spec, they go once the code has dropped it too.
    const kept = tested.get(frid);
    if (kept === undefined) continue;
    if (current !== undefined || inCode.has(kept.markdown.trim())) specs.push(kept);
  }
  return withoutEmpty({
    [DEFINITIONS]: itemsOf(code, DEFINITIONS),
    [NON_FUNCTIONAL_REQUIREMENTS]: itemsOf(code, NON_FUNCTIONAL_REQUIREMENTS),
    [TEST_REQUIREMENTS]: itemsOf(spec, TEST_REQUIREMENTS),
    [FUNCTIONAL_REQUIREMENTS]: specs,
  });
}

/**
 * Of the functional specs given, by number, those the code record does not have as `tree` has them - not built,
 * or built from other text: no conformance test can be written for them yet. `tree` is a spec, its functional
 * specs numbered by place, or what conformance tests are written for, each with its number.
 */
export function notBuilt(code: MarshalledPlainSource | null, tree: MarshalledPlainSource, frids: string[]): string[] {
  const built = itemsOf(code, FUNCTIONAL_REQUIREMENTS);
  const wanted = itemsOf(tree, FUNCTIONAL_REQUIREMENTS);
  const numbered = wanted.some((item) => item.frid !== undefined);
  return frids.filter((frid) => {
    const item = numbered ? wanted.find((entry) => entry.frid === frid) : wanted[Number(frid) - 1];
    const have = built[Number(frid) - 1];
    return item === undefined || have === undefined || have.markdown.trim() !== item.markdown.trim();
  });
}

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

/** A record's text as the tree it holds, whatever layout wrote it - or null when it is not one. */
function readRecordText(text: string | undefined): MarshalledPlainSource | null {
  if (text === undefined) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof (raw as { version?: unknown }).version === "number") return treeFromV2(raw as StoredV2);
  if ("functionalities" in raw) return treeFromLegacy(raw as StoredLegacy);
  return raw as MarshalledPlainSource;
}

function readFileText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * A record in `dir`: as the module's last commit has it, by default - what the harness itself wrote
 * when the last unit of work landed, never what an agent's shell changed since - or, with `onDisk`,
 * the file as it is. Null when there is none.
 */
export function readRecord(dir: string, options: { onDisk?: boolean } = {}): MarshalledPlainSource | null {
  const committed = options.onDisk === true ? undefined : committedText(dir, RECORD_FILE);
  return readRecordText(committed ?? readFileText(join(dir, RECORD_FILE)));
}

/** Write the code record: the tree, as the code sees it. */
export function writeCodeRecord(codeDir: string, tree: MarshalledPlainSource): void {
  mkdirSync(codeDir, { recursive: true });
  writeFileSync(join(codeDir, RECORD_FILE), `${JSON.stringify(codeTree(tree), null, 2)}\n`);
}

/** Write the tests record: a conformance target, as it now is built. */
export function writeTestsRecord(testsDir: string, tree: MarshalledPlainSource): void {
  mkdirSync(testsDir, { recursive: true });
  writeFileSync(join(testsDir, RECORD_FILE), `${JSON.stringify(withoutEmpty(tree), null, 2)}\n`);
}
