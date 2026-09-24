import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Conformance and rendering are stubbed: they record where they were asked to work. */
const conformanceRuns: Array<{ plainFile: string; frid: string; buildDir: string; conformanceDir: string }> = [];
vi.mock("../../src/render/conformance.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/render/conformance.ts")>();
  return {
    ...actual,
    renderConformanceTests: async (options: { plainFile: string; frid: string; buildDir: string; conformanceDir: string }) => {
      conformanceRuns.push({ plainFile: options.plainFile, frid: options.frid, buildDir: options.buildDir, conformanceDir: options.conformanceDir });
      return {
        moduleName: "x", frid: options.frid, buildDir: options.buildDir, conformanceDir: options.conformanceDir, prompt: "", response: "",
        files: [], runs: [{ command: "sh check.sh", exitCode: 0 }], passed: true, codeChanged: false, testRemovals: [],
      };
    },
  };
});
vi.mock("../../src/render/render.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/render/render.ts")>();
  return {
    ...actual,
    renderFunctionality: async (options: { frid: string; buildDir: string }) => ({
      moduleName: "top", frid: options.frid, buildDir: options.buildDir, prompt: "", response: "", files: [], added: [],
      functionality: "", runs: [{ command: "true", exitCode: 0 }], passed: true, testRemovals: [],
    }),
  };
});

const { renderConformanceSuite } = await import("../../src/render/conformance-suite.ts");
const { ensureRegressionPasses, renderModule } = await import("../../src/render/module.ts");
const { copyRequiredCode, requiredFunctionalSpecs } = await import("../../src/render/requires.ts");
const { readState, recordConformanceCommand, recordFunctionality, specStateFor } = await import("../../src/render/state.ts");
const { plainFileParser } = await import("../../src/plain/parser.ts");
const { resolveTemplateDirs } = await import("../../src/render/render.ts");

let dir: string;
let cwd: string;
const module_ = (specs: string[], requires?: string) =>
  `${requires ? `---\nrequires:\n  - ${requires}\n---\n\n` : ""}***implementation reqs***\n\n- Python.\n\n` +
  `***test reqs***\n\n- Shell scripts.\n\n***functional specs***\n\n${specs.join("\n\n")}\n`;
const file = (name: string) => join(dir, `${name}.plain`);
const buildOf = (name: string) => join(dir, "plain_modules", name, "code");
const testsOf = (name: string) => join(dir, "plain_modules", name, "tests");

function built(name: string) {
  const [moduleName, tree] = plainFileParser(`${name}.plain`, resolveTemplateDirs(file(name)));
  mkdirSync(buildOf(name), { recursive: true });
  writeFileSync(join(buildOf(name), "app.sh"), `echo ${name}\n`);
  for (const frid of ["1", "2"].slice(0, (tree["functional specs"] as unknown[]).length)) {
    recordFunctionality(buildOf(name), moduleName, { frid, ...specStateFor(tree, frid), unitTests: "passed", required: requiredFunctionalSpecs(file(name)) });
  }
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "plainwright-conf-tip-")));
  cwd = process.cwd();
  process.chdir(dir);
  writeFileSync(file("base"), module_(["- Base one.", "- Base two."]));
  writeFileSync(file("top"), module_(["- Top one."], "base"));
  conformanceRuns.length = 0;
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

describe("conformance for a module that later modules are built on", () => {
  it("is written and run in the latest codebase, and recorded there", async () => {
    for (const name of ["base", "top"]) built(name);
    const before = readState(buildOf("base"))!.functionalities["2"]!.conformance;

    const result = await renderConformanceSuite({ plainFile: file("base"), frids: ["2"] });

    expect(conformanceRuns).toEqual([{ plainFile: file("base"), frid: "2", buildDir: buildOf("top"), conformanceDir: testsOf("top") }]);
    expect(result.codebaseOf).toBe("top");
    const entry = readState(buildOf("top"))!.required.find((spec) => spec.module === "base" && spec.frid === "2")!;
    expect(entry.build?.conformance).toBe("passed");
    expect(readState(buildOf("base"))!.functionalities["2"]!.conformance).toBe(before);
  });

  it("stays with the module itself while nothing is built on it", async () => {
    built("base");
    await renderConformanceSuite({ plainFile: file("base"), frids: ["1"] });
    expect(conformanceRuns[0]).toMatchObject({ buildDir: buildOf("base"), conformanceDir: testsOf("base") });
  });
});

describe("the tests already in a codebase", () => {
  it("come up the chain with the command that runs them", () => {
    built("base");
    mkdirSync(testsOf("base"), { recursive: true });
    writeFileSync(join(testsOf("base"), "check.sh"), "exit 0\n");
    recordConformanceCommand(buildOf("base"), "sh check.sh");

    copyRequiredCode(buildOf("base"), buildOf("top"), "top");
    expect(readState(buildOf("top"))!.conformanceCommand).toBe("sh check.sh");
  });

  it("are run with that command when no other is given, and said not to have run when there is none", async () => {
    built("top");
    mkdirSync(testsOf("top"), { recursive: true });
    writeFileSync(join(testsOf("top"), "check.sh"), "exit 0\n");
    const [, tree] = plainFileParser("top.plain", resolveTemplateDirs(file("top")));
    const run = () =>
      ensureRegressionPasses({ buildDir: buildOf("top"), conformanceRoot: join(dir, "plain_modules"), moduleName: "top", frids: ["1"], tree, required: [], command: null, maxRounds: 0 });

    expect(await run()).toMatchObject({ passed: true, unrun: true });
    recordConformanceCommand(buildOf("top"), "sh check.sh");
    const ran = await run();
    expect(ran.runs.map((r) => [r.command, r.exitCode])).toEqual([["sh check.sh", 0]]);
  });

  it("are kept passing by a render that writes no conformance tests of its own", async () => {
    built("top");
    mkdirSync(testsOf("top"), { recursive: true });
    writeFileSync(join(testsOf("top"), "check.sh"), "exit 0\n");
    recordConformanceCommand(buildOf("top"), "sh check.sh");
    writeFileSync(file("top"), module_(["- Top one.", "- Top two."], "base"));

    const result = await renderModule({ plainFile: file("top"), buildDir: buildOf("top"), conformance: false });

    expect(conformanceRuns).toEqual([]);
    expect(result.outcomes.at(-1)!.regression?.runs.map((r) => r.command)).toEqual(["sh check.sh"]);
    expect(result.passed).toBe(true);
  });
});
