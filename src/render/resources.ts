import { readFileSync } from "node:fs";
import { openFrom } from "../plain/files.ts";
import { collectLinkedResources, type MarshalledPlainSource } from "../plain/spec.ts";

export interface LoadedResource {
  text: string;
  target: string;
  content: string;
}

const MAX_RESOURCE_CHARS = 8000;

/**
 * Load the resources linked from the specifications in scope for one functionality.
 *
 * `collectLinkedResources` stops at the requested FRID, so a resource introduced by a
 * later functionality is not pulled into this prompt.
 */
export function loadLinkedResources(
  tree: MarshalledPlainSource,
  /** Up to and including this functionality. Null: the whole module. */
  frid: string | null,
  templateDirs: string[],
): LoadedResource[] {
  const collected: Array<{ text: string; target: string; sections: string[] }> = [];
  collectLinkedResources(tree, collected, null, true, frid);

  const loaded: LoadedResource[] = [];
  for (const resource of collected) {
    let content = openFrom(templateDirs, resource.target);
    if (content === null) {
      try {
        content = readFileSync(resource.target, "utf8");
      } catch {
        continue;
      }
    }
    if (content.length > MAX_RESOURCE_CHARS) {
      content = `${content.slice(0, MAX_RESOURCE_CHARS)}\n... [truncated, ${content.length} characters total]`;
    }
    loaded.push({ text: resource.text, target: resource.target, content });
  }
  return loaded;
}
