import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getFrids, type MarshalledPlainSource } from "../plain/spec.ts";
import { readState } from "./state.ts";
import { listFiles } from "./testing.ts";

/**
 * What a render agent is told about the code before it starts.
 *
 * Every render is a fresh session, and without this each one begins by rediscovering the
 * codebase - listing directories, grepping for where things are - which on a long module is
 * the same exploration repeated once per functionality, growing as the code does. The
 * harness already knows the answers, and knows them exactly: the files, which
 * functionality put which of them there, and the test command that passed. None of it is
 * the agent's recollection, so none of it can be stale.
 */

/** Files by content, so a change is noticed whatever happened to its timestamp. */
export function digestFiles(root: string): Map<string, string> {
  const digests = new Map<string, string>();
  for (const file of listFiles(root)) {
    try {
      digests.set(file, createHash("sha1").update(readFileSync(join(root, file))).digest("hex"));
    } catch {
      // Gone between listing and reading: it is not there to describe.
    }
  }
  return digests;
}

export function diffFiles(
  before: Map<string, string>,
  after: Map<string, string>,
): { added: string[]; changed: string[]; removed: string[] } {
  const added: string[] = [];
  const changed: string[] = [];
  for (const [file, digest] of after) {
    const previous = before.get(file);
    if (previous === undefined) added.push(file);
    else if (previous !== digest) changed.push(file);
  }
  const removed = [...before.keys()].filter((file) => !after.has(file));
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}

/** Beyond this, the tree is summarised by directory rather than listed file by file. */
const MAX_LISTED_FILES = 150;

function fileTree(files: string[]): string[] {
  if (files.length <= MAX_LISTED_FILES) return files.map((file) => `  ${file}`);
  // Too many to list: one line per top-level directory with its file count, and the files
  // at the top level itself, which are usually the entry points.
  const counts = new Map<string, number>();
  const topLevel: string[] = [];
  for (const file of files) {
    const slash = file.indexOf("/");
    if (slash === -1) topLevel.push(file);
    else counts.set(file.slice(0, slash), (counts.get(file.slice(0, slash)) ?? 0) + 1);
  }
  return [
    ...topLevel.map((file) => `  ${file}`),
    ...[...counts].sort(([a], [b]) => a.localeCompare(b)).map(([dir, count]) => `  ${dir}/  (${count} files)`),
  ];
}

function list(files: string[]): string {
  return files.join(", ");
}

/**
 * The map of the codebase as it stands before functionality `frid` is built - or, with no
 * `frid`, as it stands with everything built so far - or null when there is no code yet.
 */
export function codebaseMap(tree: MarshalledPlainSource, buildDir: string, frid?: string): string | null {
  const files = listFiles(buildDir);
  if (files.length === 0) return null;

  const state = readState(buildDir);
  const earlier: string[] = [];
  for (const id of getFrids(tree)) {
    if (id === frid) break;
    earlier.push(id);
  }

  const lines = [`Files (${files.length}):`, ...fileTree(files)];

  // Everything this codebase holds, in the order it was built on: the required modules'
  // functionalities first, then this module's own before the one being built. Those built
  // before this was recorded have nothing to say; one line for all of them, and none at all
  // when that is every one.
  const moduleName = state?.module ?? "";
  const entries = [
    ...(state?.required ?? []).map((spec) => ({ label: `${spec.module} ${spec.frid}`, files: spec.build?.files })),
    ...earlier.map((id) => ({ label: `${moduleName} ${id}`, files: state?.functionalities[id]?.files })),
  ];
  const unrecorded = entries.filter((entry) => entry.files === undefined).map((entry) => entry.label);
  const where = entries.flatMap(({ label, files: recorded }) => {
    if (recorded === undefined) return [];
    const parts = [
      recorded.added.length > 0 ? `added ${list(recorded.added)}` : "",
      recorded.changed.length > 0 ? `changed ${list(recorded.changed)}` : "",
      recorded.removed.length > 0 ? `removed ${list(recorded.removed)}` : "",
    ].filter(Boolean);
    return [`  ${label}: ${parts.length > 0 ? parts.join("; ") : "no file changes"}`];
  });
  if (where.length > 0) {
    if (unrecorded.length > 0) where.push(`  not recorded for ${list(unrecorded)}`);
    lines.push("", "What each implemented functionality did to the files:", ...where);
  }

  // The most recent functionality that recorded one: the command most likely to still work.
  const command = [
    ...(state?.required ?? []).map((spec) => spec.build?.testCommand),
    ...earlier.map((id) => state?.functionalities[id]?.testCommand),
  ]
    .reverse()
    .find((found) => found !== undefined);
  if (command !== undefined) lines.push("", `The unit tests last passed with: ${command}`);

  return lines.join("\n");
}
