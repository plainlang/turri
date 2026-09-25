import { describe, expect, it } from "vitest";
import { createProgressTracker, progressBar } from "../../src/render/progress.ts";
import type { ChainEntry } from "../../src/render/requires.ts";

const chain = [
  { moduleName: "base", frids: ["1"], buildDir: "", plainFile: "", requires: null },
  { moduleName: "middle", frids: ["1", "2"], buildDir: "", plainFile: "", requires: "base" },
  { moduleName: "top", frids: ["1"], buildDir: "", plainFile: "", requires: "middle" },
] as ChainEntry[];

function started() {
  const t = createProgressTracker();
  t.onChainEvent({ type: "chain", chain });
  return t;
}

describe("progressBar", () => {
  it("is fixed width so the lines do not jump", () => {
    expect(progressBar(0, 4)).toBe("[··········]");
    expect(progressBar(2, 4)).toBe("[█████·····]");
    expect(progressBar(4, 4)).toBe("[██████████]");
  });

  it("is empty when there is nothing to count", () => {
    expect(progressBar(0, 0)).toBe("");
  });
});

describe("the progress tracker", () => {
  it("shows nothing before the chain is known", () => {
    expect(createProgressTracker().lines()).toEqual([]);
  });

  it("lists every module as queued once the chain arrives", () => {
    const lines = started().lines();
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.includes("queued"))).toBe(true);
  });

  it("follows the module being built and its functionality", () => {
    const t = started();
    t.onChainEvent({ type: "module_start", module: "base", index: 1, total: 3 });
    t.onModuleEvent({ type: "functionality_start", frid: "1", index: 1, total: 1 });
    t.onModuleEvent({ type: "phase", frid: "1", phase: "conformance" });

    expect(t.lines()[0]).toContain("• base");
    expect(t.lines()[0]).toContain("functionality 1 · conformance");
    expect(t.summary()).toBe("base (1/3) · functionality 1 · conformance");
  });

  it("advances the bar as functionalities finish", () => {
    const t = started();
    t.onChainEvent({ type: "module_start", module: "middle", index: 2, total: 3 });
    t.onModuleEvent({ type: "functionality_done", frid: "1" });

    expect(t.lines()[1]).toContain("[█████·····] 1/2");
  });

  it("reports files copied in from the required module", () => {
    const t = started();
    t.onChainEvent({ type: "copied", from: "base", to: "middle", files: 14 });
    t.onChainEvent({ type: "module_start", module: "middle", index: 2, total: 3 });

    expect(t.lines()[1]).toContain("14 files copied in");
  });

  it("counts regression repairs", () => {
    const t = started();
    t.onChainEvent({ type: "module_start", module: "base", index: 1, total: 3 });
    t.onModuleEvent({ type: "repair", frids: ["1"] });
    t.onModuleEvent({ type: "repair", frids: ["1"] });

    expect(t.lines()[0]).toContain("2 repairs");
  });

  it("marks a module built, and one that was skipped", () => {
    const t = started();
    t.onChainEvent({ type: "module_skipped", module: "base" });
    t.onChainEvent({ type: "module_start", module: "middle", index: 2, total: 3 });
    t.onChainEvent({ type: "module_done", module: "middle", passed: true });

    expect(t.lines()[0]).toContain("– base");
    expect(t.lines()[0]).toContain("already built");
    expect(t.lines()[1]).toContain("✓ middle");
  });

  it("marks a module that stopped", () => {
    const t = started();
    t.onChainEvent({ type: "module_start", module: "base", index: 1, total: 3 });
    t.onChainEvent({ type: "module_done", module: "base", passed: false });

    expect(t.lines()[0]).toContain("✗ base");
  });

  it("is done only when no module is left queued or building", () => {
    const t = started();
    expect(t.done()).toBe(false);

    for (const module of ["base", "middle", "top"]) {
      t.onChainEvent({ type: "module_start", module, index: 1, total: 3 });
      t.onChainEvent({ type: "module_done", module, passed: true });
    }
    expect(t.done()).toBe(true);
    expect(t.summary()).toBe("3/3 modules");
  });

  it("ignores functionality events with no module building", () => {
    const t = started();
    expect(() => t.onModuleEvent({ type: "functionality_done", frid: "1" })).not.toThrow();
    expect(t.lines()[0]).toContain("queued");
  });
});

describe("a long chain, compact", () => {
  const long = Array.from({ length: 19 }, (_, i) => ({
    moduleName: `m${String(i + 1).padStart(2, "0")}`,
    plainFile: `/x/m${i + 1}.plain`,
    buildDir: `/x/m${i + 1}`,
    requires: i === 0 ? null : `m${String(i).padStart(2, "0")}`,
    frids: ["1", "2"],
  })) as ChainEntry[];

  function fiveBuiltSixthBuilding() {
    const t = createProgressTracker();
    t.onChainEvent({ type: "chain", chain: long });
    for (const [index, entry] of long.slice(0, 6).entries()) {
      t.onChainEvent({ type: "module_start", module: entry.moduleName, index: index + 1, total: long.length });
      if (index < 5) t.onChainEvent({ type: "module_done", module: entry.moduleName, passed: true });
    }
    return t;
  }

  it("counts what is built, keeps the module being built, and puts the rest on one counted line", () => {
    const lines = fiveBuiltSixthBuilding().compactLines();
    expect(lines[0]).toBe("5/19 modules built");
    expect(lines[1]).toMatch(/^• m06 /);
    expect(lines[2]).toMatch(/^ {2}queued \(13\): m07 → m08 → .* → m19$/);
    expect(lines.at(-1)).toContain("ctrl+o");
    expect(lines.length).toBeLessThanOrEqual(10);
  });

  it("keeps a module that stopped in full", () => {
    const t = fiveBuiltSixthBuilding();
    t.onChainEvent({ type: "module_done", module: "m06", passed: false });
    expect(t.compactLines().some((line) => line.startsWith("✗ m06"))).toBe(true);
  });

  it("still lists every module in full, for ctrl+o", () => {
    expect(fiveBuiltSixthBuilding().lines()).toHaveLength(19);
  });

  it("shows a short chain in full either way", () => {
    const t = started();
    expect(t.compactLines()).toEqual(t.lines());
  });
});

describe("the functional spec being built, in the progress widget", () => {
  it("shows its first line, and all of it when expanded", async () => {
    const { createProgressTracker } = await import("../../src/render/progress.ts");
    const progress = createProgressTracker();
    progress.onChainEvent({ type: "chain", chain: [{ moduleName: "rt_tuples", frids: ["1", "2"] }] } as never);
    progress.onChainEvent({ type: "module_start", module: "rt_tuples", index: 1, total: 1 } as never);
    progress.onModuleEvent({ type: "functionality_start", frid: "2", index: 2, total: 2, spec: "A :Tuple: supports arithmetic.\n  - Adding two tuples adds each component." });

    expect(progress.compactLines()).toContain("    │ A :Tuple: supports arithmetic.  (+1 line · ctrl+o)");
    expect(progress.lines()).toEqual(expect.arrayContaining(["    │ A :Tuple: supports arithmetic.", "    │   - Adding two tuples adds each component."]));

    progress.onModuleEvent({ type: "functionality_done", frid: "2" });
    expect(progress.lines().join("\n")).not.toContain("supports arithmetic");
  });
});
