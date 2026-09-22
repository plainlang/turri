import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getFrids,
  getHashValue,
  getSpecificationsForFrid,
  type MarshalledPlainSource,
  ACCEPTANCE_TESTS,
  FUNCTIONAL_REQUIREMENTS,
  type Specifications,
} from "../plain/spec.ts";

/**
 * What a build directory already contains, in terms of the specification it was built from.
 *
 * The full specification of each functionality is stored, not just a hash of it. The hash
 * answers "has this changed"; the specification answers "what was this code actually built
 * from", which is the question you have when the code and the spec disagree. It is a few
 * hundred kilobytes for a large module - nothing next to the build itself.
 *
 * It is written into the build directory itself - `plain_modules/<module>/code` - so it
 * lives in the codebase it describes and is committed with it. A state file kept outside
 * the codebase can be cleared without the code changing, and then nothing knows which
 * functionalities the code already holds.
 */

export const STATE_FILE = ".plainwright.json";

export interface FunctionalityState {
  frid: string;
  /** Hash of the whole context it was rendered from. A record, not what staleness uses. */
  specHash: string;
  /** The exact context this functionality was rendered from. */
  specifications: Specifications;
  renderedAt: string;
  unitTests: "passed" | "failed";
  conformance?: "passed" | "failed" | "skipped";
}

export interface BuildState {
  module: string;
  updatedAt: string;
  functionalities: Record<string, FunctionalityState>;
}

export function readState(buildDir: string): BuildState | null {
  try {
    return JSON.parse(readFileSync(join(buildDir, STATE_FILE), "utf8")) as BuildState;
  } catch {
    return null;
  }
}

export function writeState(buildDir: string, state: BuildState): void {
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(join(buildDir, STATE_FILE), JSON.stringify(state, null, 2));
}

/** The specification a functionality would be rendered from right now, and its hash. */
export function specStateFor(
  tree: MarshalledPlainSource,
  frid: string,
): { specHash: string; specifications: Specifications } {
  const [specifications] = getSpecificationsForFrid(tree, frid);
  return { specHash: getHashValue(specifications), specifications };
}

export function recordFunctionality(
  buildDir: string,
  moduleName: string,
  entry: Omit<FunctionalityState, "renderedAt"> & { renderedAt?: string },
): BuildState {
  const state: BuildState = readState(buildDir) ?? {
    module: moduleName,
    updatedAt: "",
    functionalities: {},
  };

  state.module = moduleName;
  state.functionalities[entry.frid] = { ...entry, renderedAt: entry.renderedAt ?? new Date().toISOString() };
  state.updatedAt = new Date().toISOString();

  writeState(buildDir, state);
  return state;
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
function ownSpec(specifications: Specifications): string {
  return JSON.stringify([
    specifications[FUNCTIONAL_REQUIREMENTS].at(-1) ?? "",
    specifications[ACCEPTANCE_TESTS] ?? [],
  ]);
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
    if (ownSpec(built.specifications) !== ownSpec(specStateFor(tree, frid).specifications)) {
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
