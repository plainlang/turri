import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { committedText } from "./history.ts";

/**
 * What a module is built from, in two records - see docs/work-model.md.
 *
 * - The code record, `code/.plainwright.json`: the spec the code is built from, without what is only
 *   for conformance - the test reqs, and the acceptance tests under each functional spec.
 * - The tests record, `tests/.plainwright.json`: the functional specs the conformance tests are
 *   written for - a subset of the code record's, each with its number and its acceptance tests - the
 *   definitions and implementation reqs they were written against, and the test reqs they follow.
 *
 * The tests record is always a substate of the code record: a conformance test exercises
 * functionality, and only functionality in the code can be tested. Each record is committed with
 * what it describes, in the module's `.plaingit`, so rolling a unit of work back puts it back too.
 */

export const RECORD_FILE = ".plainwright.json";

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
 * with the spec - its text in the code record is not the spec's - stays as the tests record has it,
 * until the code lands. So does anything the code record does not have yet.
 */
export function conformanceTarget(code: MarshalledPlainSource | null, tests: MarshalledPlainSource | null, spec: MarshalledPlainSource, chosen: Chosen = () => true): MarshalledPlainSource {
  const built = itemsOf(code, FUNCTIONAL_REQUIREMENTS);
  const now = itemsOf(spec, FUNCTIONAL_REQUIREMENTS);
  const tested = new Map(itemsOf(tests, FUNCTIONAL_REQUIREMENTS).map((item) => [item.frid, item]));
  const specs: Item[] = [];
  built.forEach((item, index) => {
    const frid = String(index + 1);
    if (!chosen(frid)) return;
    const current = now[index];
    if (current !== undefined && current.markdown.trim() === item.markdown.trim()) {
      specs.push({ ...current, frid });
      return;
    }
    // The code is behind the spec here: its tests stay as they are until it catches up.
    const kept = tested.get(frid);
    if (kept !== undefined) specs.push(kept);
  });
  return withoutEmpty({
    [DEFINITIONS]: itemsOf(code, DEFINITIONS),
    [NON_FUNCTIONAL_REQUIREMENTS]: itemsOf(code, NON_FUNCTIONAL_REQUIREMENTS),
    [TEST_REQUIREMENTS]: itemsOf(spec, TEST_REQUIREMENTS),
    [FUNCTIONAL_REQUIREMENTS]: specs,
  });
}

function readRecordText(text: string | undefined): MarshalledPlainSource | null {
  if (text === undefined) return null;
  try {
    const raw = JSON.parse(text) as unknown;
    return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as MarshalledPlainSource) : null;
  } catch {
    return null;
  }
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
