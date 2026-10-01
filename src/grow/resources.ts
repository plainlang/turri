import { readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { openFrom } from "../plain/files.ts";
import { collectLinkedResources, type MarshalledPlainSource } from "../plain/spec.ts";
import { scriptKind } from "./test-scripts.ts";

export interface LoadedResource {
  text: string;
  target: string;
  /** What the agent reads in <linked resources>: the file's text, or - an image - where to find it. */
  content: string;
  /** An image: sent to the agent with its first message, not as text. */
  image?: ResourceImage;
}

/** A linked image as a model is sent it. */
export interface ResourceImage {
  type: "image";
  data: string;
  mimeType: string;
}

const MAX_RESOURCE_CHARS = 8000;

/** The images a spec can link, by extension: a model reading images is sent them as they are. */
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

/** The largest image a model provider takes in one piece. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** The MIME type of a linked image, by its extension; undefined for any other file. */
export function imageTypeOf(target: string): string | undefined {
  return IMAGE_TYPES[extname(target).toLowerCase()];
}

/** A linked image too large to send, or unreadable: the job stops, saying which file and why. */
export class LinkedImageError extends Error {}

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
    // A testing script reaches an agent as one - whole, and only when it is run on its work -
    // not as a resource, cut short and whether it is used or not.
    if (scriptKind(resource.target) !== undefined) continue;
    const mimeType = imageTypeOf(resource.target);
    if (mimeType !== undefined) {
      const image = loadImage(templateDirs, resource.target, mimeType);
      if (image === undefined) continue;
      const number = loaded.filter((other) => other.image !== undefined).length + 1;
      loaded.push({ text: resource.text, target: resource.target, content: `[an image: attached to your first message, image ${number}]`, image });
      continue;
    }
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

/** The images among loaded resources, in the order the prompt numbers them. */
export function resourceImages(resources: LoadedResource[]): ResourceImage[] {
  return resources.flatMap((resource) => (resource.image !== undefined ? [resource.image] : []));
}

/** A linked image's bytes, found as a text resource is: the template folders first, then the current directory. */
function loadImage(templateDirs: string[], target: string, mimeType: string): ResourceImage | undefined {
  for (const path of [...templateDirs.map((dir) => join(dir, target)), target]) {
    let size: number;
    try {
      if (!statSync(path).isFile()) continue;
      size = statSync(path).size;
    } catch {
      continue;
    }
    if (size > MAX_IMAGE_BYTES) {
      throw new LinkedImageError(
        `The linked image ${target} is ${(size / 1024 / 1024).toFixed(1)} MB - a model takes images up to ${MAX_IMAGE_BYTES / 1024 / 1024} MB. Make it smaller, or link a smaller one.`,
      );
    }
    return { type: "image", data: readFileSync(path).toString("base64"), mimeType };
  }
  return undefined;
}
