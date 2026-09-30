import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Every render and conformance run, as asked for - the agents themselves are stubbed. */
const renders: Array<{ plainFile: string; frid: string; buildDir: string; in?: string }> = [];

vi.mock("../../src/render/render.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/render/render.ts")>();
  return {
    ...actual,
    renderFunctionality: async (options: {
      plainFile: string; frid: string; buildDir: string; regenerate?: { in?: { moduleName: string } };
    }) => {
      renders.push({ plainFile: options.plainFile, frid: options.frid, buildDir: options.buildDir, in: options.regenerate?.in?.moduleName });
      // What it built is recorded as the real one records it - in the codebase it was built in.
      const { recordBuiltFunctionality, recordBuiltRequiredFunctionality } = await import("../../src/render/state.ts");
      const { plainFileParser } = await import("../../src/plain/parser.ts");
      const [moduleName, tree] = plainFileParser(options.plainFile.split("/").pop()!, actual.resolveTemplateDirs(options.plainFile));
      if (options.regenerate?.in !== undefined) {
        recordBuiltRequiredFunctionality(options.buildDir, moduleName, options.frid, (tree["functional specs"] as Array<{ markdown: string }>)[Number(options.frid) - 1]!);
      } else {
        recordBuiltFunctionality(options.buildDir, tree, options.frid);
      }
      return {
        moduleName: "x", frid: options.frid, buildDir: options.buildDir, prompt: "", response: "", files: [], added: [],
        functionality: "", runs: [{ command: "true", exitCode: 0 }], passed: true, testRemovals: [],
      };
    },
  };
});
vi.mock("../../src/render/conformance.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/render/conformance.ts")>();
  return {
    ...actual,
    renderConformanceTests: async (options: { frid: string; buildDir: string }) => ({
      moduleName: "x", frid: options.frid, buildDir: options.buildDir, conformanceDir: "", response: "", files: [],
      runs: [{ command: "true", exitCode: 0 }], passed: true, codeChanged: false, testRemovals: [],
    }),
  };
});

const { findCodebaseTip } = await import("../../src/render/requires.ts");
const { regenerateFunctionality, renderChain } = await import("../../src/render/module.ts");
const { readBuiltTree, recordBuiltFunctionality, recordBuiltRequiredFunctionality } = await import("../../src/render/state.ts");
const { plainFileParser } = await import("../../src/plain/parser.ts");
const { resolveTemplateDirs } = await import("../../src/render/render.ts");
const { buildRegeneratePrompt } = await import("../../src/render/prompt.ts");

let dir: string;
let cwd: string;

const module_ = (specs: string[], requires?: string) =>
  `${requires ? `---\nrequires:\n  - ${requires}\n---\n\n` : ""}***implementation reqs***\n\n- Python.\n\n` +
  `***test reqs***\n\n- pytest.\n\n***functional specs***\n\n${specs.join("\n\n")}\n`;

const file = (name: string) => join(dir, `${name}.plain`);
const buildOf = (name: string) => join(dir, "plain_modules", name, "code");

/** Record a module as built from its current spec, the way a render would. */
function built(name: string) {
  const [moduleName, tree] = plainFileParser(`${name}.plain`, resolveTemplateDirs(file(name)));
  mkdirSync(buildOf(name), { recursive: true });
  writeFileSync(join(buildOf(name), "app.py"), `# ${name}\n`);
  for (const frid of ["1", "2"].slice(0, (tree["functional specs"] as unknown[]).length)) {
    recordBuiltFunctionality(buildOf(name), tree, frid);
  }
}

beforeEach(() => {
  // Resolved, because the process reports its working directory that way once it is in it.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "plainwright-tip-")));
  cwd = process.cwd();
  process.chdir(dir);
  writeFileSync(file("base"), module_(["- Base one.", "- Base two."]));
  writeFileSync(file("middle"), module_(["- Middle one."], "base"));
  writeFileSync(file("top"), module_(["- Top one."], "middle"));
  renders.length = 0;
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

describe("the codebase a change lands in", () => {
  it("is the module's own while nothing is built on it", () => {
    built("base");
    expect(findCodebaseTip(file("base")).tip.moduleName).toBe("base");
  });

  it("is the furthest-built module whose chain includes it", () => {
    for (const name of ["base", "middle", "top"]) built(name);
    const { tip, chain } = findCodebaseTip(file("base"));
    expect(tip.moduleName).toBe("top");
    expect(chain.map((entry) => entry.moduleName)).toEqual(["base", "middle", "top"]);
  });

  it("is refused, not guessed, when built modules branch - unless named", () => {
    writeFileSync(file("other"), module_(["- Other one."], "base"));
    for (const name of ["base", "middle", "other"]) built(name);
    expect(() => findCodebaseTip(file("base"))).toThrow(/more than one branch: middle, other/);
    expect(findCodebaseTip(file("base"), { inModule: "other" }).tip.moduleName).toBe("other");
  });
});

describe("regenerating a required module's functionality", () => {
  beforeEach(() => {
    for (const name of ["base", "middle", "top"]) built(name);
    writeFileSync(file("base"), module_(["- Base one, changed.", "- Base two."]));
  });

  it("happens in the tip's codebase, and says so", async () => {
    const result = await regenerateFunctionality({ plainFile: file("base"), frid: "1" });
    expect(renders).toEqual([{ plainFile: file("base"), frid: "1", buildDir: buildOf("top"), in: "top" }]);
    expect(result.codebaseOf).toBe("top");
    expect(result.buildDir).toBe(buildOf("top"));
  });

  it("is recorded in the tip's tree, as the required module's spec now has it - and the module's own tree is left alone", () => {
    const before = readBuiltTree(buildOf("base"));
    const [, tree] = plainFileParser("base.plain", resolveTemplateDirs(file("base")));
    recordBuiltRequiredFunctionality(buildOf("top"), "base", "1", (tree["functional specs"] as Array<{ markdown: string }>)[0]!);

    const inherited = readBuiltTree(buildOf("top"))!["required functional specs"] as Array<{ markdown: string; module: string; frid: string }>;
    expect(inherited.find((spec) => spec.module === "base" && spec.frid === "1")!.markdown).toBe("- Base one, changed.");
    expect(inherited.find((spec) => spec.module === "base" && spec.frid === "2")!.markdown).toBe("- Base two.");
    expect(readBuiltTree(buildOf("base"))).toEqual(before);
  });

  it("stays recorded when the tip's own functionality is rendered again later - and a change not rebuilt stays unbuilt", () => {
    const [, base] = plainFileParser("base.plain", resolveTemplateDirs(file("base")));
    recordBuiltRequiredFunctionality(buildOf("top"), "base", "1", (base["functional specs"] as Array<{ markdown: string }>)[0]!);
    writeFileSync(file("base"), module_(["- Base one, changed.", "- Base two, changed too."]));
    const [, tree] = plainFileParser("top.plain", resolveTemplateDirs(file("top")));
    recordBuiltFunctionality(buildOf("top"), tree, "1");
    const inherited = readBuiltTree(buildOf("top"))!["required functional specs"] as Array<{ markdown: string; module: string; frid: string }>;
    expect(inherited.filter((spec) => spec.module === "base").map((spec) => spec.markdown)).toEqual(["- Base one, changed.", "- Base two."]);
  });
});

describe("rendering the chain again after an ancestor changed", () => {
  it("does not rebuild the ancestor, and regenerates only what changed in the tip", async () => {
    for (const name of ["base", "middle", "top"]) built(name);
    writeFileSync(file("base"), module_(["- Base one.", "- Base two, changed."]));

    const result = await renderChain({ plainFile: file("top") });

    expect(renders).toEqual([{ plainFile: file("base"), frid: "2", buildDir: buildOf("top"), in: "top" }]);
    expect(result.outcomes.map((o) => [o.module, o.skipped])).toEqual([
      ["base", true],
      ["middle", true],
      ["top", true],
    ]);
    expect(result.passed).toBe(true);
  });

  it("does nothing when the tip was built on what the specs say now", async () => {
    for (const name of ["base", "middle", "top"]) built(name);
    await renderChain({ plainFile: file("top") });
    expect(renders).toEqual([]);
  });
});

describe("the regeneration prompt", () => {
  const specifications = {
    definitions: [], "implementation reqs": ["- Python."], "test reqs": [], "functional specs": ["- Base one.", "- Base two, changed."],
  };

  it("shows the spec as built beside the spec now, and what else is in the code", () => {
    const prompt = buildRegeneratePrompt({
      moduleName: "base", frid: "2", specifications, linkedResources: [], previous: "- Base two.", codebaseOf: "top",
      implemented: [{ module: "base", frid: "1", spec: "- Base one." }, { module: "top", frid: "1", spec: "- Top one." }],
    });
    expect(prompt).toContain("has changed since it was built");
    expect(prompt).toContain("the codebase of `top` - built on top of `base`");
    expect(prompt).toContain('<functionality module="base" id="2" version="as built">\n- Base two.\n</functionality>');
    expect(prompt).toContain('<functionality module="base" id="2" version="now">\n- Base two, changed.\n</functionality>');
    expect(prompt).toContain('<functionality module="top" id="1" status="implemented">');
    expect(prompt).toContain("including what was built\n  after this functionality");
  });

  it("asks for an implementation when the functionality was added after the codebase was built", () => {
    const prompt = buildRegeneratePrompt({
      moduleName: "base", frid: "2", specifications, linkedResources: [], added: true, codebaseOf: "top", implemented: [],
    });
    expect(prompt).toContain("was added to the `base` specification after this codebase was built");
    expect(prompt).toContain("Implement functionality 2 of module `base` and its unit tests.");
    expect(prompt).not.toContain('version="as built"');
  });
});

describe("rendering the chain after its specs were split into a new module below", () => {
  it("builds the new module, then the one above again from scratch on it - its old code in its history", async () => {
    const { writeTestScripts } = await import("../test-scripts.ts");
    const { existsSync } = await import("node:fs");
    const { historyLog, recordHistory } = await import("../../src/render/history.ts");
    writeTestScripts(dir);
    writeFileSync(file("shop"), module_(["- Shop one.", "- Shop two."]));
    built("shop");
    recordHistory(buildOf("shop"), "built shop");
    // Shop one moves into catalog, which shop now requires.
    writeFileSync(file("catalog"), module_(["- Shop one."]));
    writeFileSync(file("shop"), module_(["- Shop two."], "catalog"));

    const result = await renderChain({ plainFile: file("shop") });

    expect(result.passed).toBe(true);
    expect(renders.map((render) => [render.plainFile, render.frid, render.buildDir])).toEqual([
      [file("catalog"), "1", buildOf("catalog")],
      [file("shop"), "1", buildOf("shop")],
    ]);
    expect(existsSync(join(buildOf("shop"), "app.py"))).toBe(false);
    expect(historyLog(buildOf("shop"))).toMatch(/start from catalog[\s\S]*start from scratch: it now requires catalog[\s\S]*built shop/);
  });
});

describe("a regeneration that leaves its conformance tests to the job behind it", () => {
  it("lands on its unit tests - no conformance tests of its own, no suite - and says the job behind it has them", async () => {
    for (const name of ["base", "middle", "top"]) built(name);
    writeFileSync(file("base"), module_(["- Base one, changed.", "- Base two."]));
    const result = await regenerateFunctionality({ plainFile: file("base"), frid: "1", conformanceLater: true });
    expect(result).toMatchObject({ passed: true, stoppedAt: null, conformanceLater: true });
    expect(result.conformance).toBeUndefined();
    expect(result.regression).toBeUndefined();
    expect(renders).toHaveLength(1);
  });
});

