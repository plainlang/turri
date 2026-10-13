import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { writtenByConversation } from "./conversation-writes.ts";
import { isCredentialFile } from "./credentials.ts";
import { RECORD_FILE } from "./records.ts";

/**
 * The audit after every agent command, on every platform: the net under the command check and the OS sandbox.
 *
 * Inside the project, what the command's role may not change is put back as it was before it ran - a changed file
 * restored, a new one removed, a deleted one brought back: the specs, the config, the testing scripts, every credential
 * file, the code record, the module's lineage, the other modules, and the folders the role only reads. Small files are
 * kept before the command and put back from that copy; another module is put back as its last commit has it - unless a
 * pulse is at work in it, whose writes are not this command's to undo. The role's own work is left alone, and the pulse
 * goes on. Outside the project nothing can be put back: that is the OS sandbox's. Nor is a change the conversation
 * itself made while the command ran - the person's model editing a spec beside a pulse (`conversation-writes.ts`): that
 * is left, not taken for the command's.
 *
 * What changed is seen cheaply: each file's size and modification time before and after, skipping dependencies and
 * build output, and contents compared only where those differ.
 */

export interface AuditScope {
  /** The project: the folder holding the specs, the config, the testing scripts and plain_modules. */
  project: string;
  /** The module the agent works in: `plain_modules/<module>`. */
  module: string;
  /** The role's roots it may write - its own work, left alone but for the record and credential files in it. */
  write: string[];
  /** The role's roots it only reads: put back whole. */
  readOnly: string[];
  /** Whether a pulse is at work in another module - what changes there is that pulse's, and left. */
  busy?: (moduleDir: string) => boolean;
}

export interface AuditResult {
  /** Put back as it was, by path from the project. */
  putBack: string[];
  /** Changed where a pulse is at work, and left - for the job log. */
  left: string[];
  /** Changed, and nothing to put it back from. */
  lost: string[];
  /** Changed by the conversation itself while the command ran, and left. */
  conversation: string[];
}

/** Folders never looked in: dependencies, build output, caches, histories, turri's scratch. */
const SKIPPED = new Set([
  "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", "target", "build",
  "dist", ".gradle", ".m2", ".cargo", ".next", "coverage", ".git", ".turri", ".plaingit", ".idea", ".vscode",
]);

/** A file kept whole before the command - at most this big. */
const MAX_KEPT = 1024 * 1024;

interface Seen {
  size: number;
  mtimeMs: number;
}

/** A tree's files by path, with their size and time - and, where kept, what they held. */
interface Tree {
  root: string;
  files: Map<string, Seen>;
  /** What the files held, for those put back from a copy. */
  kept?: Map<string, Buffer>;
  /** How it is put back: from the copy, or from the module's last commit. */
  from: "copy" | { lineage: string };
  /** Only its record and credential files are watched: the role writes the rest. */
  watchOnly?: boolean;
  /** Another module a pulse is at work in: what changes there is left. */
  busy?: boolean;
}

export interface AuditSnapshot {
  scope: AuditScope;
  trees: Tree[];
  /** When it was taken: a change the conversation made since is the conversation's, not the command's. */
  at: number;
}

function stat(path: string): Seen | undefined {
  try {
    const found = statSync(path);
    return found.isFile() ? { size: found.size, mtimeMs: found.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

/** Every file under `root` that `wanted` takes, skipping the folders that are never looked in. */
function walk(root: string, wanted: (path: string) => boolean, skip: (dir: string) => boolean = () => false): Map<string, Seen> {
  const files = new Map<string, Seen>();
  const visit = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(dir, name);
      let found;
      try {
        found = statSync(path);
      } catch {
        continue;
      }
      if (found.isDirectory()) {
        if (!SKIPPED.has(name) && !skip(path)) visit(path);
      } else if (found.isFile() && wanted(path)) {
        files.set(path, { size: found.size, mtimeMs: found.mtimeMs });
      }
    }
  };
  if (existsSync(root)) visit(root);
  return files;
}

function keep(files: Map<string, Seen>): Map<string, Buffer> {
  const kept = new Map<string, Buffer>();
  for (const [path, seen] of files) {
    if (seen.size > MAX_KEPT) continue;
    try {
      kept.set(path, readFileSync(path));
    } catch {
      /* unreadable: nothing to put back from */
    }
  }
  return kept;
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

/** What the project's own files are that no agent changes: specs, config, testing scripts, credentials. */
function projectFile(project: string, path: string): boolean {
  const name = basename(path);
  if (isCredentialFile(path)) return true;
  if (name.endsWith(".plain")) return true;
  if (dirname(path) === project && /^config(\.[^.]+)?\.ya?ml$/.test(name)) return true;
  if (relative(project, path).split(sep)[0] === "test_scripts") return true;
  return dirname(path) === project && /^(run_|prepare_environment).*\.sh$/.test(name);
}

/** Take what the audit compares against, before a command runs. */
export function beforeCommand(scope: AuditScope): AuditSnapshot {
  const at = Date.now();
  const modulesRoot = join(scope.project, "plain_modules");
  const trees: Tree[] = [];

  // The project's own files, outside plain_modules.
  const own = walk(scope.project, (path) => projectFile(scope.project, path), (dir) => dir === modulesRoot);
  trees.push({ root: scope.project, files: own, kept: keep(own), from: "copy" });

  // In what the role writes: only the record and credential files are watched.
  for (const root of scope.write) {
    const watched = walk(root, (path) => basename(path) === RECORD_FILE || isCredentialFile(path));
    trees.push({ root, files: watched, kept: keep(watched), from: "copy", watchOnly: true });
  }

  // What the role only reads, and the parts of its own module it does not write at all: all of it, from a copy - they may
  // hold this pulse's work, not yet committed.
  const ownParts = ["code", "tests"].map((part) => join(scope.module, part)).filter((part) => existsSync(part) && !scope.write.includes(part) && !scope.readOnly.includes(part));
  for (const root of [...scope.readOnly, ...ownParts]) {
    const all = walk(root, () => true);
    trees.push({ root, files: all, kept: keep(all), from: "copy" });
  }

  // The module's lineage: its refs and settings - the objects are only ever added to.
  const lineage = join(scope.module, ".plaingit");
  const refs = walk(lineage, (path) => !within(path, join(lineage, "objects")) && !within(path, join(lineage, "logs")));
  trees.push({ root: lineage, files: refs, kept: keep(refs), from: "copy" });

  // The other modules, put back from their last commit.
  if (existsSync(modulesRoot)) {
    for (const name of readdirSync(modulesRoot)) {
      const other = join(modulesRoot, name);
      if (name.startsWith(".") || other === scope.module || !existsSync(join(other, ".plaingit"))) continue;
      const files = walk(other, () => true);
      trees.push({ root: other, files, from: { lineage: other }, busy: scope.busy?.(other) === true });
    }
  }
  return { scope, trees, at };
}

/** The file's last committed content in a module's lineage, or nothing when it was not committed. */
function committed(moduleDir: string, path: string): Buffer | undefined {
  const rel = relative(moduleDir, path).split(sep).join("/");
  const run = spawnSync("git", ["--git-dir", join(moduleDir, ".plaingit"), "show", `HEAD:${rel}`], { maxBuffer: 256 * 1024 * 1024 });
  return run.status === 0 ? (run.stdout as Buffer) : undefined;
}

function put(path: string, content: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** After the command: put back what it changed that its role may not, and say what. */
export function afterCommand(snapshot: AuditSnapshot): AuditResult {
  const { scope } = snapshot;
  const result: AuditResult = { putBack: [], left: [], lost: [], conversation: [] };
  const shown = (path: string) => relative(scope.project, path).split(sep).join("/");
  const modulesRoot = join(scope.project, "plain_modules");

  for (const tree of snapshot.trees) {
    const isLineage = tree.root === join(scope.module, ".plaingit");
    const after =
      tree.root === scope.project
        ? walk(scope.project, (path) => projectFile(scope.project, path), (dir) => dir === modulesRoot)
        : tree.watchOnly === true
          ? walk(tree.root, (path) => basename(path) === RECORD_FILE || isCredentialFile(path))
          : isLineage
            ? walk(tree.root, (path) => !within(path, join(tree.root, "objects")) && !within(path, join(tree.root, "logs")))
            : walk(tree.root, () => true);

    const changed: string[] = [];
    for (const [path, seen] of after) {
      const was = tree.files.get(path);
      if (was === undefined) changed.push(path);
      else if (was.size !== seen.size || was.mtimeMs !== seen.mtimeMs) {
        const kept = tree.kept?.get(path);
        // Touched but the same: nothing to put back.
        if (kept !== undefined && readFileSync(path).equals(kept)) continue;
        changed.push(path);
      }
    }
    for (const path of tree.files.keys()) if (!after.has(path)) changed.push(path);
    // What the conversation wrote meanwhile is its own: left as it is.
    const mine = changed.filter((path) => writtenByConversation(path, snapshot.at));
    result.conversation.push(...mine.map(shown));
    changed.splice(0, changed.length, ...changed.filter((path) => !mine.includes(path)));
    if (changed.length === 0) continue;

    if (tree.busy === true) {
      result.left.push(...changed.map(shown));
      continue;
    }
    for (const path of changed) {
      const existed = tree.files.has(path);
      if (!existed) {
        rmSync(path, { force: true });
        result.putBack.push(shown(path));
        continue;
      }
      const content = tree.from === "copy" ? tree.kept?.get(path) : committed(tree.from.lineage, path);
      if (content === undefined) {
        result.lost.push(shown(path));
        continue;
      }
      put(path, content);
      result.putBack.push(shown(path));
    }
  }
  return result;
}

/** What the agent is told in its command's result, or nothing when the audit put nothing back. */
export function auditMessage(result: AuditResult): string | undefined {
  if (result.putBack.length === 0 && result.lost.length === 0) return undefined;
  const list = (paths: string[]) => (paths.length > 10 ? `${paths.slice(0, 10).join(", ")} and ${paths.length - 10} more` : paths.join(", "));
  const parts: string[] = [];
  if (result.putBack.length > 0) parts.push(`turri put back ${list(result.putBack)} as it was before this command`);
  if (result.lost.length > 0) parts.push(`${list(result.lost)} changed and could not be put back`);
  return (
    `[${parts.join("; ")}: outside what you may change. Your own work is kept. What you need from there is in your ` +
    "prompt; leave it as it is.]"
  );
}
