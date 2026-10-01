import { existsSync, readdirSync, renameSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { LEGACY_NAME } from "../legacy.ts";
import { commitPaths, HISTORY_DIR, refreshExcludes } from "./lineage.ts";
import { NOTES_FILE } from "./notes.ts";
import { MODULES_DIR, whenProjectFound } from "./paths.ts";
import { RECORD_FILE } from "./records.ts";

/** What turri's files were called before it had its name, by what they are called now. */
export const LEGACY_FILES = {
  scratch: `.${LEGACY_NAME}`,
  record: `.${LEGACY_NAME}.json`,
  notes: `.${LEGACY_NAME}-notes.md`,
};

const migrated = new Set<string>();

/** Move `from` to `to` when only `from` is there. Says whether it moved. */
function moveOver(from: string, to: string): boolean {
  if (!existsSync(from) || existsSync(to)) return false;
  try {
    renameSync(from, to);
    return true;
  } catch {
    return false;
  }
}

/**
 * A folder moved over to its new name - or, the new one there already (a log written before this ran), what it does not
 * have of the old one moved into it, and the old one taken away once it is empty.
 */
function mergeOver(from: string, to: string): void {
  if (!existsSync(from)) return;
  if (moveOver(from, to)) return;
  try {
    if (!statSync(from).isDirectory() || !statSync(to).isDirectory()) return;
    for (const name of readdirSync(from)) {
      const inside = join(from, name);
      if (!existsSync(join(to, name))) moveOver(inside, join(to, name));
      else if (statSync(inside).isDirectory()) mergeOver(inside, join(to, name));
    }
    if (readdirSync(from).length === 0) rmdirSync(from);
  } catch {
    /* left as it is: nothing is lost by it */
  }
}

/**
 * A project built before turri had its name, brought over to the names it uses now - once a process, and only what
 * is still under an old name: the project's scratch and the VM's (`.plainwright` → `.turri`), and in each module the
 * records and the working notes (`.plainwright.json` → `.turri.json`, `.plainwright-notes.md` → `.turri-notes.md`),
 * committed to the module's history on their own, so the history goes on from them. `plain_modules` and `.plaingit`
 * are the ***plain language's, and keep their names.
 */
export function migrateProject(projectDir: string): void {
  if (migrated.has(projectDir)) return;
  migrated.add(projectDir);
  mergeOver(join(projectDir, LEGACY_FILES.scratch), join(projectDir, ".turri"));
  const modules = join(projectDir, MODULES_DIR);
  mergeOver(join(modules, LEGACY_FILES.scratch), join(modules, ".turri"));
  let names: string[];
  try {
    names = readdirSync(modules);
  } catch {
    return;
  }
  for (const name of names) {
    const moduleDir = join(modules, name);
    if (!existsSync(join(moduleDir, HISTORY_DIR))) continue;
    const paths: string[] = [];
    for (const [part, from, to] of [
      ["code", LEGACY_FILES.record, RECORD_FILE],
      ["tests", LEGACY_FILES.record, RECORD_FILE],
      ["code", LEGACY_FILES.notes, NOTES_FILE],
    ] as const) {
      if (moveOver(join(moduleDir, part, from), join(moduleDir, part, to))) paths.push(`${part}/${from}`, `${part}/${to}`);
    }
    refreshExcludes(moduleDir);
    commitPaths(moduleDir, paths, `turri's files under the names they have now: ${RECORD_FILE} and ${NOTES_FILE}, which were ${LEGACY_FILES.record} and ${LEGACY_FILES.notes}`);
  }
}

// Every project found from now on is brought over the first time it is.
whenProjectFound(migrateProject);
