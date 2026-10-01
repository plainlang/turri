import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Credentials are the person's: no agent writes them. A run that needs one and does not have it is told
 * so - by its judge, to the person - rather than given one an agent made up, which every later run then
 * fails on without anyone seeing why.
 *
 * A credential file is a `.env` or one of its variants (`.env.local`, `.env.test`); a template of one -
 * `.env.example`, `.env.sample`, `.env.template`, `.env.dist` - holds no secret and is not one.
 */
export function isCredentialFile(path: string): boolean {
  const name = basename(path);
  if (name === ".env") return true;
  const variant = /^\.env\.(.+)$/.exec(name)?.[1];
  return variant !== undefined && !["example", "sample", "template", "dist"].includes(variant.toLowerCase());
}

/** What an agent is told when it tries to write one. */
export function credentialRefusal(path: string): string {
  return (
    `${basename(path)} holds credentials, and they are the person's to provide - never an agent's to write, ` +
    "not even a placeholder: a made-up one makes every later run fail without anyone seeing why. If the software or its " +
    "tests need a credential that is missing or rejected, say so - in submit_work - and name the variable."
  );
}

/** Folders a credential file is never looked for in: dependencies, caches, histories. */
const SKIPPED = new Set(["node_modules", ".venv", "venv", ".git", ".plaingit", "cache", "logs", "__pycache__", ".pytest_cache", "target", "build", "dist", ".gradle", ".m2"]);
const DEPTH = 5;

/** The credential files under `roots`, with what each holds: what an agent's command is checked against. */
export function credentialFiles(roots: string[]): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(dir, name);
      let isDir: boolean;
      try {
        isDir = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (depth < DEPTH && !SKIPPED.has(name)) visit(path, depth + 1);
      } else if (isCredentialFile(path)) {
        try {
          found.set(path, readFileSync(path, "utf8"));
        } catch {
          /* unreadable: nothing to put back */
        }
      }
    }
  };
  for (const root of roots) visit(root, 0);
  return found;
}

/**
 * Undo what a command did to the credential files under `roots`, from what they held before it: one it made is
 * removed, one it changed or removed is put back. Says which it put back.
 */
export function restoreCredentialFiles(before: Map<string, string>, roots: string[]): string[] {
  const after = credentialFiles(roots);
  const restored: string[] = [];
  for (const [path, text] of after) {
    if (before.get(path) === text) continue;
    if (before.has(path)) writeFileSync(path, before.get(path)!);
    else rmSync(path, { force: true });
    restored.push(path);
  }
  for (const [path, text] of before) {
    if (after.has(path) || existsSync(path)) continue;
    writeFileSync(path, text);
    restored.push(path);
  }
  return restored;
}
