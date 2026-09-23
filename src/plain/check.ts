import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { plainFileParser, PLAIN_SOURCE_FILE_EXTENSION } from "./parser.ts";
import { getFrids, type MarshalledPlainSource } from "./spec.ts";
import { resolveTemplateDirs } from "../render/render.ts";

/**
 * Static validation of a .plain file, using this repo's own parser.
 *
 * This is the check that used to mean running the renderer with `--dry-run`: it parses the
 * specification, resolves its imports and required modules, and reports every error the
 * parser can see without generating anything. Nothing is rendered and nothing is spent.
 */

export interface CheckResult {
  file: string;
  ok: boolean;
  moduleName?: string;
  frids?: string[];
  requiredModules?: string[];
  /** The parser's own message, verbatim - it names the line and the construct. */
  error?: string;
  errorType?: string;
}

export function checkPlainFile(file: string, templateDirs: string[] = []): CheckResult {
  const path = resolve(file);

  if (extname(path) !== PLAIN_SOURCE_FILE_EXTENSION) {
    return {
      file,
      ok: false,
      error: `Not a ${PLAIN_SOURCE_FILE_EXTENSION} file.`,
      errorType: "UsageError",
    };
  }
  if (!existsSync(path)) {
    return { file, ok: false, error: "File does not exist.", errorType: "UsageError" };
  }

  try {
    const dirs = resolveTemplateDirs(path, templateDirs);
    // A module with no functional specs yet is valid - it is how every module starts, and how
    // an import module always is. It is reported, not failed.
    const [moduleName, tree, requiredModules] = plainFileParser(basename(path), dirs, { allowNoFunctionalities: true });
    return {
      file,
      ok: true,
      moduleName,
      frids: [...getFrids(tree as MarshalledPlainSource)],
      requiredModules,
    };
  } catch (error) {
    return {
      file,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      errorType: error instanceof Error ? error.name : "Error",
    };
  }
}

/** Every `.plain` file directly in a directory, or the single file given. */
export function resolvePlainTargets(target: string): string[] {
  const path = resolve(target);
  if (existsSync(path) && statSync(path).isDirectory()) {
    return readdirSync(path)
      .filter((entry) => entry.endsWith(PLAIN_SOURCE_FILE_EXTENSION))
      .sort()
      .map((entry) => join(path, entry));
  }
  return [path];
}

export function checkPlainTargets(target: string, templateDirs: string[] = []): CheckResult[] {
  return resolvePlainTargets(target).map((file) => checkPlainFile(file, templateDirs));
}

/** One line per file, plus the parser's message under any that failed. */
export function formatCheckResults(results: CheckResult[]): string {
  const lines: string[] = [];
  for (const result of results) {
    const name = basename(result.file);
    if (result.ok) {
      const frids = result.frids ?? [];
      const requires =
        result.requiredModules && result.requiredModules.length > 0
          ? `, requires ${result.requiredModules.join(", ")}`
          : "";
      lines.push(
        frids.length === 0
          ? `PASS  ${name}  no functional specs yet${requires}`
          : `PASS  ${name}  ${frids.length} functionalit${frids.length === 1 ? "y" : "ies"} (${frids.join(", ")})${requires}`,
      );
    } else {
      lines.push(`FAIL  ${name}  ${result.errorType ?? "Error"}`);
      for (const line of (result.error ?? "").split("\n")) lines.push(`        ${line}`);
    }
  }
  return lines.join("\n");
}
