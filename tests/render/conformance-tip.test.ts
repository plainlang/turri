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
const { ensureRegressionPasses, regenerateFunctionality, renderModule } = await import("../../src/render/module.ts");
const { copyRequiredCode, requiredFunctionalSpecs } = await import("../../src/render/requires.ts");
const { readState, recordFunctionality, specStateFor } = await import("../../src/render/state.ts");
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
  // The project's scripts, in test_scripts/ beside the specs: every check in the suite, run from the build.
  const scripts = () => {
    mkdirSync(join(dir, "test_scripts"), { recursive: true });
    writeFileSync(join(dir, "test_scripts", "run_unittests_sh.sh"), "exit 0\n");
    writeFileSync(
      join(dir, "test_scripts", "run_conformance_tests_sh.sh"),
      'cd "$1" || exit 2\nfor check in $(cd "$2" && find . -name "*.sh" | sort); do sh "$2/$check" || exit 1; done\n',
    );
    return { unit: join(dir, "test_scripts", "run_unittests_sh.sh"), conformance: join(dir, "test_scripts", "run_conformance_tests_sh.sh") };
  };

  it("are run with the project's conformance testing script - and without one, nothing runs them and nothing passes", async () => {
    built("top");
    mkdirSync(testsOf("top"), { recursive: true });
    writeFileSync(join(testsOf("top"), "check.sh"), "exit 0\n");
    const [, tree] = plainFileParser("top.plain", resolveTemplateDirs(file("top")));
    const run = (given: { conformance?: string }) =>
      ensureRegressionPasses({ buildDir: buildOf("top"), conformanceRoot: join(dir, "plain_modules"), moduleName: "top", frids: ["1"], tree, required: [], scripts: given, maxRounds: 0 });

    await expect(run({})).rejects.toThrow("it has no conformance testing script");
    const ran = await run(scripts());
    expect(ran.runs.map((r) => [r.command, r.exitCode])).toEqual([["test_scripts/run_conformance_tests_sh.sh", 0]]);
  });

  it("are kept passing by a render that writes none of its own because its module has no test reqs", async () => {
    built("top");
    scripts();
    mkdirSync(testsOf("top"), { recursive: true });
    writeFileSync(join(testsOf("top"), "check.sh"), "exit 0\n");
    writeFileSync(file("top"), "---\nrequires:\n  - base\n---\n\n***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n- Top one.\n\n- Top two.\n");

    const result = await renderModule({ plainFile: file("top"), buildDir: buildOf("top") });

    expect(conformanceRuns).toEqual([]);
    expect(result.outcomes.at(-1)!.regression?.runs.map((r) => r.command)).toEqual(["test_scripts/run_conformance_tests_sh.sh"]);
    expect(result.passed).toBe(true);
  });

  it("are not run at all when conformance is turned off - the script is ignored, found or not", async () => {
    built("top");
    scripts();
    mkdirSync(testsOf("top"), { recursive: true });
    // It would fail: turned off, nothing runs it.
    writeFileSync(join(testsOf("top"), "check.sh"), "exit 1\n");
    writeFileSync(file("top"), module_(["- Top one.", "- Top two."], "base"));

    const result = await renderModule({ plainFile: file("top"), buildDir: buildOf("top"), conformance: false });

    expect(conformanceRuns).toEqual([]);
    expect(result.outcomes.at(-1)!.regression).toMatchObject({ passed: true, runs: [], conformanceOff: true });
    expect(result.passed).toBe(true);
  });

  it("are not written or run by a regeneration when conformance is turned off", async () => {
    built("top");
    scripts();
    mkdirSync(testsOf("top"), { recursive: true });
    // It would fail: turned off, nothing runs it.
    writeFileSync(join(testsOf("top"), "check.sh"), "exit 1\n");

    const result = await regenerateFunctionality({ plainFile: file("top"), frid: "1", buildDir: buildOf("top"), conformance: false });

    expect(conformanceRuns).toEqual([]);
    expect(result).toMatchObject({ passed: true, stoppedAt: null, regression: { conformanceOff: true, runs: [] } });
  });

  it("stop a build before it starts when the project has no unit testing script", async () => {
    built("top");
    await expect(renderModule({ plainFile: file("top"), buildDir: buildOf("top"), conformance: false })).rejects.toThrow(
      /Stopped before building top: it has no unit testing script[\s\S]*implement-unit-testing-script/,
    );
  });
});
