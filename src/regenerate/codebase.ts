import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NOTES_FILE } from "./notes.ts";
import { RECORD_FILE } from "./records.ts";
import { listFiles } from "./testing.ts";

/**
 * What a render agent is told about the code before it starts.
 *
 * Every render is a fresh session, and without this each one begins by rediscovering the
 * codebase - listing directories, grepping for where things are - which on a long module is
 * the same exploration repeated once per functionality, getting longer as the code does. The
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

/** Whether the work has written nothing in `root` since `atStart` - its working notes and the build record aside. */
export function wroteNothing(root: string, atStart: Map<string, string>): boolean {
  const { added, changed, removed } = diffFiles(atStart, digestFiles(root));
  return [...added, ...changed, ...removed].every((file) => file === NOTES_FILE || file === RECORD_FILE);
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

/** The map of the codebase as it stands - or null when there is no code yet. */
export function codebaseMap(buildDir: string): string | null {
  const files = listFiles(buildDir);
  if (files.length === 0) return null;
  return [`Files (${files.length}):`, ...fileTree(files)].join("\n");
}
