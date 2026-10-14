import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createEnvironment } from "./liquid.ts";

/** Ports of the Python reference implementation's file helpers this parser needs. */

export function openFrom(dirs: string[], fileName: string): string | null {
  for (const dir of dirs) {
    const fullPath = join(dir, fileName);
    try {
      if (!statSync(fullPath).isFile()) continue;
    } catch {
      continue;
    }
    return readFileSync(fullPath, "utf8");
  }
  return null;
}

const MAX_BASE64_BLOB_LENGTH = 8192;
const BASE64_BLOB_PATTERN = new RegExp(
  `(?:data:[\\w.+-]+/[\\w.+-]+;base64,)?[A-Za-z0-9+/_-]{${MAX_BASE64_BLOB_LENGTH},}={0,2}`,
);

/** First contiguous base64 blob at or above the threshold, or null. */
export function findLargeBase64Blob(text: string): string | null {
  const match = BASE64_BLOB_PATTERN.exec(text);
  return match ? match[0] : null;
}

/**
 * Render once against the filesystem to discover which templates the source pulls in.
 *
 * The rendered text is discarded by the caller; what matters is the map of template
 * name to raw source, which is what the second (real) render is given so that it does
 * not touch the filesystem again.
 */
export function getLoadedTemplates(
  templateDirs: string[],
  plainSource: string,
): [string, Record<string, string>] {
  const loadedTemplates: Record<string, string> = {};

  const engine = createEnvironment({
    strictVariables: true,
    loadTemplateSource: (name) => {
      const source = openFrom(templateDirs, name);
      if (source === null) return null;
      loadedTemplates[name] = source;
      return source;
    },
  });

  let rendered: string;
  try {
    rendered = engine.parseAndRenderSync(plainSource, {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/undefined variable/i.test(message)) {
      throw new Error(`Undefined liquid variable: ${message}`);
    }
    throw error;
  }

  return [rendered, loadedTemplates];
}
