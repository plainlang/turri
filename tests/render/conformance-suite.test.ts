import { describe, expect, it } from "vitest";
import { resolveConformanceTargets } from "../../src/render/conformance-suite.ts";
import type { ChainEntry } from "../../src/render/requires.ts";
import type { MarshalledPlainSource } from "../../src/plain/spec.ts";

const chain = [
  { moduleName: "base", frids: ["1", "2"], buildDir: "/b/base", plainFile: "/s/base.plain", requires: null },
  { moduleName: "middle", frids: ["1"], buildDir: "/b/middle", plainFile: "/s/middle.plain", requires: "base" },
  { moduleName: "top", frids: ["1", "2", "3", "4"], buildDir: "/b/top", plainFile: "/s/top.plain", requires: "middle" },
] as ChainEntry[];

/** A tree whose only job is to answer getRenderRange for the named module. */
const treeFor = (entry: ChainEntry): MarshalledPlainSource => ({
  "functional specs": entry.frids.map((frid) => ({ markdown: `- ${frid}` })),
});

const pick = (selection: Parameters<typeof resolveConformanceTargets>[1]) =>
  resolveConformanceTargets(chain, selection, treeFor).map((t) => [t.moduleName, t.frids] as const);

describe("choosing what to write conformance tests for", () => {
  it("defaults to the whole named module, and leaves its requires alone", () => {
    expect(pick({})).toEqual([["top", ["1", "2", "3", "4"]]]);
  });

  it("takes one functionality", () => {
    expect(pick({ frids: ["3"] })).toEqual([["top", ["3"]]]);
  });

  it("takes several, in specification order rather than the order asked", () => {
    expect(pick({ frids: ["4", "2"] })).toEqual([["top", ["2", "4"]]]);
  });

  it("takes a range, inclusive of both ends", () => {
    expect(pick({ range: "2,3" })).toEqual([["top", ["2", "3"]]]);
  });

  it("takes a single-id range", () => {
    expect(pick({ range: "2" })).toEqual([["top", ["2"]]]);
  });

  it("takes the whole chain, every module whole", () => {
    expect(pick({ chain: true })).toEqual([
      ["base", ["1", "2"]],
      ["middle", ["1"]],
      ["top", ["1", "2", "3", "4"]],
    ]);
  });

  it("applies a functionality selection only to the module that was named", () => {
    // The modules underneath are taken whole: picking functionality 3 of `top` says
    // nothing about which of `base`'s functionalities matter.
    expect(pick({ chain: true, frids: ["3"] })).toEqual([
      ["base", ["1", "2"]],
      ["middle", ["1"]],
      ["top", ["3"]],
    ]);
  });

  it("rejects a functionality the module does not have", () => {
    expect(() => pick({ frids: ["9"] })).toThrow(/Functionality 9 does not exist in top/);
  });

  it("names what is available when the selection is wrong", () => {
    expect(() => pick({ frids: ["9"] })).toThrow(/Available: 1, 2, 3, 4/);
  });

  it("carries each module's own build directory", () => {
    const targets = resolveConformanceTargets(chain, { chain: true }, treeFor);
    expect(targets.map((t) => t.buildDir)).toEqual(["/b/base", "/b/middle", "/b/top"]);
  });
});
