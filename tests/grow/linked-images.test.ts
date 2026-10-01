import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MarshalledPlainSource } from "../../src/plain/spec.ts";
import { ModelCannotReadImagesError, refuseIfBlind } from "../../src/pi.ts";
import { imageTypeOf, LinkedImageError, loadLinkedResources, resourceImages } from "../../src/grow/resources.ts";

/** A PNG's signature and header: enough bytes to stand for one. */
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");

function treeLinking(...targets: string[]): MarshalledPlainSource {
  return {
    "functional specs": [
      {
        markdown: "- A :User: sees the dashboard.",
        linked_resources: targets.map((target) => ({ text: target, target })),
      },
    ],
  } as unknown as MarshalledPlainSource;
}

describe("linked images", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "turri-images-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("knows PNG and JPEG by their extension, in any case, and nothing else", () => {
    expect(imageTypeOf("mockup.png")).toBe("image/png");
    expect(imageTypeOf("photo.JPG")).toBe("image/jpeg");
    expect(imageTypeOf("photo.jpeg")).toBe("image/jpeg");
    expect(imageTypeOf("diagram.gif")).toBeUndefined();
    expect(imageTypeOf("api.yaml")).toBeUndefined();
  });

  it("loads a linked image as one to send, numbered, beside the text resources it is linked with", () => {
    writeFileSync(join(dir, "mockup.png"), PNG);
    writeFileSync(join(dir, "api.yaml"), "openapi: 3.0.0\n");
    writeFileSync(join(dir, "photo.jpg"), PNG);

    const loaded = loadLinkedResources(treeLinking("api.yaml", "mockup.png", "photo.jpg"), null, [dir]);

    expect(loaded.map((resource) => resource.target)).toEqual(["api.yaml", "mockup.png", "photo.jpg"]);
    expect(loaded[0]).toEqual({ text: "api.yaml", target: "api.yaml", content: "openapi: 3.0.0\n" });
    expect(loaded[1]!.content).toContain("image 1");
    expect(loaded[2]!.content).toContain("image 2");
    expect(resourceImages(loaded)).toEqual([
      { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
      { type: "image", data: PNG.toString("base64"), mimeType: "image/jpeg" },
    ]);
  });

  it("refuses an image too large for a model to take, naming the file", () => {
    writeFileSync(join(dir, "huge.png"), Buffer.alloc(6 * 1024 * 1024));
    expect(() => loadLinkedResources(treeLinking("huge.png"), null, [dir])).toThrow(LinkedImageError);
    expect(() => loadLinkedResources(treeLinking("huge.png"), null, [dir])).toThrow(/huge\.png/);
  });

  it("refuses a model that cannot read images, saying which and what to do instead", () => {
    const blind = { provider: "acme", id: "text-only", input: ["text"] };
    expect(() => refuseIfBlind(blind, 2)).toThrow(ModelCannotReadImagesError);
    expect(() => refuseIfBlind(blind, 2)).toThrow(/acme\/text-only cannot read images.*coding-model/);
  });

  it("lets a model that reads images have them", () => {
    expect(() => refuseIfBlind({ provider: "acme", id: "sees", input: ["text", "image"] }, 1)).not.toThrow();
  });
});
