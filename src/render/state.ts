import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCEPTANCE_TESTS,
  DEFINITIONS,
  FUNCTIONAL_REQUIREMENTS,
  getFrids,
  getHashValue,
  getSpecificationItemMarkdown,
  getSpecificationsForFrid,
  NON_FUNCTIONAL_REQUIREMENTS,
  TEST_REQUIREMENTS,
  type MarshalledPlainSource,
  type Specifications,
} from "../plain/spec.ts";

/**
 * What a build directory already contains, in terms of the specification it was built from.
 *
 * Laid out the way the specification is, not as one snapshot per functionality: the
 * definitions and the implementation and test reqs once, as of the latest build, and the
 * functional specs as one list that grows as functionalities are rendered. That list starts
 * with every functional spec of the modules this one requires, transitively - their code is
 * in this codebase too, so they are part of what it is - and each of this module's own specs
 * carries how it was built: when, whether its tests passed, what it did to the files.
 *
 * The spec text is stored, not just a hash. The hash answers "has this changed"; the text
 * answers "what was this code actually built from", which is the question you have when the
 * code and the spec disagree.
 *
 * It is written into the build directory itself - `plain_modules/<module>/code` - so it
 * lives in the codebase it describes and is committed with it. A state file kept outside
 * the codebase can be cleared without the code changing, and then nothing knows which
 * functionalities the code already holds.
 */

export const STATE_FILE = ".plainwright.json";
const STATE_VERSION = 2;

/** The sections a module shares across all its functionalities. */
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
  /**
   * How the code for it that this codebase holds was built, and in whose codebase: its own
   * module's, copied up the chain with the code, or this one's when it was regenerated here.
   * Absent when that was never recorded.
   */
  build?: RequiredBuild;
}

export type RequiredBuild = Omit<FunctionalityState, "frid" | "spec" | "acceptanceTests"> & {
  /** The module whose codebase it was built in. */
  in: string;
};

export interface FunctionalityState {
  frid: string;
  /** Hash of the whole context it was rendered from. A record, not what staleness uses. */
  specHash: string;
  /** Its functional spec, as it was built. */
  spec: string;
  acceptanceTests?: string[];
  renderedAt: string;
  unitTests: "passed" | "failed";
  conformance?: "passed" | "failed" | "skipped";
  /** What its render did to the codebase, by content, so the next render knows where it lives. */
  files?: { added: string[]; changed: string[]; removed: string[] };
  /** The unit test command that last passed while building it. */
  testCommand?: string;
}

export interface BuildState {
  module: string;
  updatedAt: string;
  sections: SharedSections;
  /** The required modules' functional specs, bottom of the chain first. */
  required: RequiredSpec[];
  /** This module's own, by functionality id. */
  functionalities: Record<string, FunctionalityState>;
  /**
   * The command that last ran this codebase's whole conformance suite and passed. Kept so
   * the tests it has - its own, and those carried up from the modules below - can be run
   * again by a build that writes none of its own.
   */
  conformanceCommand?: string;
}

const EMPTY_SECTIONS: SharedSections = {
  [DEFINITIONS]: [],
  [NON_FUNCTIONAL_REQUIREMENTS]: [],
  [TEST_REQUIREMENTS]: [],
};

/** One entry of the stored `functional specs` list. */
interface StoredSpec {
  module: string;
  frid: string;
  spec: string;
  "acceptance tests"?: string[];
  build?: RequiredBuild;
  specHash?: string;
  renderedAt?: string;
  unitTests?: "passed" | "failed";
  conformance?: "passed" | "failed" | "skipped";
  files?: FunctionalityState["files"];
  testCommand?: string;
}

interface StoredState extends SharedSections {
  version: number;
  module: string;
  updatedAt: string;
  conformanceCommand?: string;
  [FUNCTIONAL_REQUIREMENTS]: StoredSpec[];
}

/** The first format: one full context snapshot per functionality. Read, never written. */
interface LegacyState {
  module: string;
  updatedAt: string;
  functionalities: Record<string, Omit<FunctionalityState, "spec" | "acceptanceTests"> & { specifications: Specifications }>;
}

function byFrid(a: string, b: string): number {
  return Number(a) - Number(b);
}

function fromStored(stored: StoredState): BuildState {
  const own = stored[FUNCTIONAL_REQUIREMENTS].filter((entry) => entry.module === stored.module);
  return {
    module: stored.module,
    updatedAt: stored.updatedAt,
    conformanceCommand: stored.conformanceCommand,
    sections: {
      [DEFINITIONS]: stored[DEFINITIONS] ?? [],
      [NON_FUNCTIONAL_REQUIREMENTS]: stored[NON_FUNCTIONAL_REQUIREMENTS] ?? [],
      [TEST_REQUIREMENTS]: stored[TEST_REQUIREMENTS] ?? [],
    },
    required: stored[FUNCTIONAL_REQUIREMENTS]
      .filter((entry) => entry.module !== stored.module)
      .map((entry) => ({
        module: entry.module,
        frid: entry.frid,
        spec: entry.spec,
        acceptanceTests: entry["acceptance tests"],
        build: entry.build,
      })),
    functionalities: Object.fromEntries(
      own.map((entry) => [
        entry.frid,
        {
          frid: entry.frid,
          specHash: entry.specHash ?? "",
          spec: entry.spec,
          acceptanceTests: entry["acceptance tests"],
          renderedAt: entry.renderedAt ?? "",
          unitTests: entry.unitTests ?? "failed",
          conformance: entry.conformance,
          files: entry.files,
          testCommand: entry.testCommand,
        },
      ]),
    ),
  };
}

/** A build recorded in the first format, so an existing build is not mistaken for none. */
function fromLegacy(legacy: LegacyState): BuildState {
  const entries = Object.values(legacy.functionalities).sort((a, b) => byFrid(a.frid, b.frid));
  const latest = entries.at(-1)?.specifications;
  return {
    module: legacy.module,
    updatedAt: legacy.updatedAt,
    sections: latest
      ? {
          [DEFINITIONS]: latest[DEFINITIONS] ?? [],
          [NON_FUNCTIONAL_REQUIREMENTS]: latest[NON_FUNCTIONAL_REQUIREMENTS] ?? [],
          [TEST_REQUIREMENTS]: latest[TEST_REQUIREMENTS] ?? [],
        }
      : { ...EMPTY_SECTIONS },
    required: [],
    functionalities: Object.fromEntries(
      entries.map(({ specifications, ...rest }) => [
        rest.frid,
        { ...rest, spec: specifications[FUNCTIONAL_REQUIREMENTS].at(-1) ?? "", acceptanceTests: specifications[ACCEPTANCE_TESTS] },
      ]),
    ),
  };
}

export function readState(buildDir: string): BuildState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(buildDir, STATE_FILE), "utf8"));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;
  if ((raw as { version?: unknown }).version === STATE_VERSION) return fromStored(raw as StoredState);
  if ("functionalities" in raw) return fromLegacy(raw as LegacyState);
  return null;
}

export function writeState(buildDir: string, state: BuildState): void {
  const own = Object.values(state.functionalities).sort((a, b) => byFrid(a.frid, b.frid));
  const stored: StoredState = {
    version: STATE_VERSION,
    module: state.module,
    updatedAt: state.updatedAt,
    ...(state.conformanceCommand ? { conformanceCommand: state.conformanceCommand } : {}),
    ...state.sections,
    [FUNCTIONAL_REQUIREMENTS]: [
      ...state.required.map((entry) => ({
        module: entry.module,
        frid: entry.frid,
        spec: entry.spec,
        ...(entry.acceptanceTests?.length ? { "acceptance tests": entry.acceptanceTests } : {}),
        ...(entry.build ? { build: entry.build } : {}),
      })),
      ...own.map(({ acceptanceTests, ...entry }) => ({
        module: state.module,
        ...entry,
        ...(acceptanceTests?.length ? { "acceptance tests": acceptanceTests } : {}),
      })),
    ],
  };
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(join(buildDir, STATE_FILE), JSON.stringify(stored, null, 2));
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

export type RecordInput = Omit<FunctionalityState, "renderedAt"> & {
  renderedAt?: string;
  /** The shared sections as of this build. Omitted: kept as they were. */
  sections?: SharedSections;
  /** The required modules' specs as of this build. Omitted: kept as they were. */
  required?: RequiredSpec[];
};

export function recordFunctionality(buildDir: string, moduleName: string, input: RecordInput): BuildState {
  const { sections, required, ...entry } = input;
  const state: BuildState = readState(buildDir) ?? {
    module: moduleName,
    updatedAt: "",
    sections: { ...EMPTY_SECTIONS },
    required: [],
    functionalities: {},
  };

  state.module = moduleName;
  if (sections !== undefined) state.sections = sections;
  if (required !== undefined) state.required = mergeRequired(state.required, required);

  // A later write about the same build - conformance finishing, say - does not know what
  // the render touched. What the render recorded is kept, as long as it was built from the
  // same specification; a new render always brings its own.
  const previous = state.functionalities[entry.frid];
  const sameBuild = previous !== undefined && previous.specHash === entry.specHash;
  state.functionalities[entry.frid] = {
    ...entry,
    files: entry.files ?? (sameBuild ? previous.files : undefined),
    testCommand: entry.testCommand ?? (sameBuild ? previous.testCommand : undefined),
    renderedAt: entry.renderedAt ?? new Date().toISOString(),
  };
  state.updatedAt = new Date().toISOString();

  writeState(buildDir, state);
  return state;
}

/**
 * The required specs as they stand now, keeping how each was built for any entry whose spec
 * has not moved since. Refreshing the list must not forget where the code came from.
 */
function mergeRequired(previous: RequiredSpec[], next: RequiredSpec[]): RequiredSpec[] {
  const before = new Map(previous.map((entry) => [`${entry.module}/${entry.frid}`, entry]));
  return next.map((entry) => {
    const old = before.get(`${entry.module}/${entry.frid}`);
    return old?.build && old.spec === entry.spec ? { ...entry, build: old.build } : entry;
  });
}

/**
 * Record, in the codebase of `host`, that a functionality of one of the modules it requires
 * was regenerated there.
 *
 * The required list is refreshed to the specs as they stand now - that is what this
 * codebase holds after the regeneration - and what earlier regenerations recorded is kept
 * for every entry whose spec has not moved since. Written whether or not it passed: the
 * code changed either way, and the record has to say so.
 */
export function recordRegeneration(
  buildDir: string,
  host: string,
  input: {
    module: string;
    frid: string;
    required: RequiredSpec[];
    build: Omit<FunctionalityState, "frid" | "spec" | "acceptanceTests" | "renderedAt"> & { renderedAt?: string };
  },
): BuildState {
  const state: BuildState = readState(buildDir) ?? {
    module: host,
    updatedAt: "",
    sections: { ...EMPTY_SECTIONS },
    required: [],
    functionalities: {},
  };
  state.required = mergeRequired(state.required, input.required).map((entry) =>
    entry.module === input.module && entry.frid === input.frid
      ? { ...entry, build: { ...input.build, in: host, renderedAt: input.build.renderedAt ?? new Date().toISOString() } }
      : entry,
  );
  state.updatedAt = new Date().toISOString();
  writeState(buildDir, state);
  return state;
}

/**
 * Carry a build's record into the build that is being started on top of its code.
 *
 * The code comes with everything the source module's codebase holds, so the record does
 * too, as the new module's inheritance: the source's own inheritance as it stands, then its
 * own functionalities, each keeping how it was built and marked as built in the source's
 * codebase. Nothing of the new module's own is claimed - it has built nothing yet.
 *
 * The shared sections are the new module's own, from its spec - what it defines and what
 * it imports - not the source's: `requires` passes on functional specs, never
 * implementation reqs. They are known before anything is built, so they are recorded now.
 * A build that already has a record keeps its own functionalities.
 */
export function inheritRecord(
  fromBuildDir: string,
  toBuildDir: string,
  toModule: string,
  sections?: SharedSections,
): BuildState | null {
  const source = readState(fromBuildDir);
  if (source === null) return null;

  const carried: RequiredSpec[] = [
    ...source.required,
    ...Object.values(source.functionalities)
      .sort((a, b) => byFrid(a.frid, b.frid))
      .map(({ frid, spec, acceptanceTests, ...build }) => ({
        module: source.module,
        frid,
        spec,
        acceptanceTests,
        build: { ...build, in: source.module },
      })),
  ];

  const target: BuildState = readState(toBuildDir) ?? {
    module: toModule,
    updatedAt: "",
    sections: { ...EMPTY_SECTIONS },
    required: [],
    functionalities: {},
  };
  target.module = toModule;
  target.required = carried;
  // The conformance tests come up with the code, and so does the command that runs them.
  target.conformanceCommand ??= source.conformanceCommand;
  if (sections !== undefined) target.sections = sections;
  target.updatedAt = new Date().toISOString();
  writeState(toBuildDir, target);
  return target;
}

/**
 * Rewrite a build's record to the specs as they now stand, after a change was rendered in it.
 *
 * Functionalities are numbered by position, so a change that adds or removes specs moves the
 * numbers: the record keeps exactly the functionalities the spec now has, and nothing under
 * a number that no longer exists. What a functionality's earlier render recorded - its file
 * changes, its test command - is kept where its spec did not change.
 */
export function rewriteRecord(
  buildDir: string,
  moduleName: string,
  input: {
    sections: SharedSections;
    required: RequiredSpec[];
    functionalities: Array<Omit<FunctionalityState, "renderedAt"> & { renderedAt?: string }>;
  },
): BuildState {
  const previous = readState(buildDir);
  const now = new Date().toISOString();
  const state: BuildState = {
    module: moduleName,
    updatedAt: now,
    conformanceCommand: previous?.conformanceCommand,
    sections: input.sections,
    required: mergeRequired(previous?.required ?? [], input.required),
    functionalities: Object.fromEntries(
      input.functionalities.map((entry) => {
        const before = previous?.functionalities[entry.frid];
        const same = before !== undefined && before.spec === entry.spec;
        return [
          entry.frid,
          {
            ...entry,
            files: entry.files ?? (same ? before.files : undefined),
            testCommand: entry.testCommand ?? (same ? before.testCommand : undefined),
            renderedAt: entry.renderedAt ?? (same ? before.renderedAt : now),
          },
        ];
      }),
    ),
  };
  writeState(buildDir, state);
  return state;
}

/** Remember the command that just ran the codebase's whole conformance suite, and passed. */
export function recordConformanceCommand(buildDir: string, command: string): void {
  const state = readState(buildDir);
  if (state === null || state.conformanceCommand === command) return;
  state.conformanceCommand = command;
  state.updatedAt = new Date().toISOString();
  writeState(buildDir, state);
}

/**
 * Record a conformance verdict in the codebase it was reached in - on the functionality's
 * own entry when it is this module's, on its required entry when it belongs to a module below.
 */
export function recordConformance(
  buildDir: string,
  module: string,
  frid: string,
  conformance: "passed" | "failed",
): void {
  const state = readState(buildDir);
  if (state === null) return;
  if (module === state.module) {
    const own = state.functionalities[frid];
    if (own === undefined) return;
    own.conformance = conformance;
  } else {
    const entry = state.required.find((spec) => spec.module === module && spec.frid === frid);
    if (entry === undefined) return;
    entry.build = entry.build
      ? { ...entry.build, conformance }
      : { in: state.module, specHash: "", renderedAt: new Date().toISOString(), unitTests: "passed", conformance };
  }
  state.updatedAt = new Date().toISOString();
  writeState(buildDir, state);
}

export type PendingReason = "never built" | "specification changed" | "unit tests were failing";

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

  const state = readState(buildDir);
  const pending: Pending[] = [];

  for (const frid of all.slice(0, limit)) {
    const built = state?.functionalities[frid];
    if (built === undefined) {
      pending.push({ frid, reason: "never built" });
      continue;
    }
    if (ownSpec(built) !== ownSpec(specStateFor(tree, frid))) {
      pending.push({ frid, reason: "specification changed" });
      continue;
    }
    if (built.unitTests !== "passed") {
      pending.push({ frid, reason: "unit tests were failing" });
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
