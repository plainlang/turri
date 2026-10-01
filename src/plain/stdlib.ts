import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModuleDoesNotExistError, PlainSyntaxError } from "./errors.ts";
import { openFrom } from "./files.ts";

/**
 * The ***plain standard library's names. `stdlib/` is a reserved prefix: `stdlib/backend/python-fastapi`
 * is always turri's own template, in its `stdlib/` folder - never a module of the project's. A
 * project that has a module at such a path gets an error, not a quiet choice between the two: which one
 * a spec builds on must never depend on what happens to be on disk beside it.
 *
 * This is turri's, not the reference parser's: the Python parser has no standard library.
 */

export const STDLIB_PREFIX = "stdlib/";

/** The folder `stdlib/` is in: turri's own. */
export const STDLIB_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export function isStdlibModule(moduleName: string): boolean {
  return moduleName.replace(/^\.\//, "").startsWith(STDLIB_PREFIX);
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** A standard library module's text - refused when a folder the spec is resolved from has a module of that name too. */
export function readStdlibModule(moduleName: string, templateDirs: string[]): string {
  const name = moduleName.replace(/^\.\//, "");
  const file = `${name}.plain`;
  const own = join(STDLIB_ROOT, file);
  for (const dir of templateDirs) {
    const local = join(dir, file);
    if (existsSync(local) && !sameFile(local, own)) {
      throw new PlainSyntaxError(
        `Plain syntax error: '${name}' is a reserved name - modules under ${STDLIB_PREFIX} are turri's standard library - ` +
          `but ${local} is a module of that name. Rename it, or the folder it is in.`,
      );
    }
  }
  const text = openFrom([STDLIB_ROOT], file);
  if (text === null) throw new ModuleDoesNotExistError(`Module does not exist (${name}): the standard library has no ${name}.`);
  return text;
}
