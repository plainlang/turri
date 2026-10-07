import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { collectLinkedResources, type MarshalledPlainSource } from "../plain/spec.ts";
import { scriptKind } from "./test-scripts.ts";

export interface LoadedResource {
  text: string;
  target: string;
  /** What the agent reads in <linked resources>: the file's text, or - an image - where to find it. */
  content: string;
  /** An image: sent to the agent with its first message, not as text. */
  image?: ResourceImage;
  /** Where the file is: copy_resource copies it whole from here. */
  source?: string;
  /** Its text was cut for the prompt: how long it is whole. */
  cutFrom?: number;
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
    const source = [...templateDirs.map((dir) => join(dir, resource.target)), resource.target].find((path) => isFileAt(path));
    if (source === undefined) continue;
    let content = readFileSync(source, "utf8");
    const whole = content.length;
    if (whole > MAX_RESOURCE_CHARS) {
      content = `${content.slice(0, MAX_RESOURCE_CHARS)}\n... [cut here: ${whole} characters whole - copy_resource puts the whole file at its code-copy path, to read it there]`;
    }
    loaded.push({ text: resource.text, target: resource.target, content, source: resolve(source), ...(whole > MAX_RESOURCE_CHARS ? { cutFrom: whole } : {}) });
  }
  return loaded;
}

function isFileAt(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Where in a codebase a linked resource's one copy goes: its path, without the steps up and the leading `./`. */
export function codeCopyOf(target: string): string {
  return target
    .split(/[\\/]/)
    .filter((part) => part !== "" && part !== "." && part !== "..")
    .join("/");
}

/**
 * `copy_resource`: a linked resource copied whole into the agent's own folder - at its code-copy path, or where it
 * says - by the harness, byte for byte. The agent's prompt shows a long resource cut short, and the file itself is
 * outside its walls: copied, it reads the whole of it there, and the code or the tests use that one copy.
 */
export function createCopyResourceTool(options: { resources: LoadedResource[]; dir: string }): ToolDefinition {
  const root = resolve(options.dir);
  const copyable = options.resources.filter((resource) => resource.source !== undefined && resource.image === undefined);
  return defineTool({
    name: "copy_resource",
    label: "Copy a linked resource",
    description:
      "Copy a linked resource whole into your folder - at its code-copy path unless you give another, inside your folder - " +
      "byte for byte. Use it for a resource the code or the tests need as a file, and to read one the prompt shows cut short.",
    promptSnippet: "copy_resource: a linked resource copied whole into your folder, at its code-copy path",
    parameters: Type.Object({
      path: Type.String({ description: "The resource's path, as <linked resources> gives it" }),
      to: Type.Optional(Type.String({ description: "Where in your folder, relative to it - its code-copy path when left out" })),
    }),
    async execute(_id, params) {
      const { path, to } = params as { path: string; to?: string };
      const resource = copyable.find((candidate) => candidate.target === path || codeCopyOf(candidate.target) === codeCopyOf(path));
      if (resource === undefined) {
        const known = copyable.map((candidate) => candidate.target).join(", ");
        return { content: [{ type: "text" as const, text: `No linked resource ${path}. ${known !== "" ? `The ones you have: ${known}.` : "You have none to copy."}` }], details: {} };
      }
      const target = resolve(root, to ?? codeCopyOf(resource.target));
      const inside = relative(root, target);
      if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
        return { content: [{ type: "text" as const, text: `Not copied: ${to} is not inside your folder, ${root}.` }], details: {} };
      }
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(resource.source!, target);
      const size = statSync(target).size;
      return { content: [{ type: "text" as const, text: `Copied ${resource.target} whole to ${inside} (${size} bytes). Read it there.` }], details: {} };
    },
  }) as ToolDefinition;
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
