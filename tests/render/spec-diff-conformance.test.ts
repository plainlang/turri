import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The conformance agent, stubbed: it records what it was given, and leaves a labelled test where it was asked to. */
const conformanceRuns: Array<{ plainFile: string; frid: string; buildDir: string; conformanceDir: string; diff?: string; module?: string; specs?: string }> = [];
let passing = true;
vi.mock("../../src/render/conformance.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/render/conformance.ts")>();
  return {
    ...actual,
    renderConformanceTests: async (options: {
      plainFile: string; frid: string; buildDir: string; conformanceDir: string; diff?: string;
      spec?: { moduleName: string; tree: Record<string, unknown> };
    }) => {
      conformanceRuns.push({
        plainFile: options.plainFile, frid: options.frid, buildDir: options.buildDir, conformanceDir: options.conformanceDir,
        diff: options.diff, module: options.spec?.moduleName, specs: JSON.stringify(options.spec?.tree),
      });
      mkdirSync(options.conformanceDir, { recursive: true });
      writeFileSync(join(options.conformanceDir, "check_1.sh"), "# conformance tests of functionality 1\nexit 0\n");
      return {
        moduleName: options.spec?.moduleName ?? "x", frid: options.frid, buildDir: options.buildDir, conformanceDir: options.conformanceDir,
        prompt: "", response: "Brought the tests in line.", files: ["check_1.sh"], runs: [{ command: "sh check.sh", exitCode: passing ? 0 : 1 }],
        passed: passing, rounds: 1, codeChanged: false, testRemovals: [],
      };
    },
  };
});

const { renderSpecDiffConformance, describeSpecDiffConformance } = await import("../../src/render/spec-change-conformance.ts");
const { readBuiltTree, recordBuiltFunctionality } = await import("../../src/render/state.ts");
const { plainFileParser } = await import("../../src/plain/parser.ts");
const { resolveTemplateDirs } = await import("../../src/render/render.ts");

let dir: string;
const module_ = (specs: string[], requires?: string, testReqs = true) =>
  `${requires ? `---\nrequires:\n  - ${requires}\n---\n\n` : ""}***implementation reqs***\n\n- Python.\n\n` +
  `${testReqs ? "***test reqs***\n\n- Shell scripts.\n\n" : ""}***functional specs***\n\n${specs.join("\n\n")}\n`;
const file = (name: string) => join(dir, `${name}.plain`);
const buildOf = (name: string) => join(dir, "plain_modules", name, "code");
const testsOf = (name: string) => join(dir, "plain_modules", name, "tests");
const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout;

function built(name: string) {
  const [moduleName, tree] = plainFileParser(`${name}.plain`, resolveTemplateDirs(file(name)));
  mkdirSync(buildOf(name), { recursive: true });
  writeFileSync(join(buildOf(name), "app.sh"), `echo ${name}\n`);
  for (const frid of ["1", "2"].slice(0, (tree["functional specs"] as unknown[]).length)) {
    recordBuiltFunctionality(buildOf(name), tree, frid);
  }
}

/** A change to a .plain file as git writes it - and the file put back, so the diff is still to be applied. */
function diffOf(name: string, content: string): string {
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "specs");
  writeFileSync(file(name), content);
  const diff = git("diff", "--", `${name}.plain`);
  git("checkout", "--", `${name}.plain`);
  return diff;
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "plainwright-spec-diff-conformance-")));
  writeFileSync(file("base"), module_(["- Base one.", "- Base two."]));
  writeFileSync(file("top"), module_(["- Top one."], "base"));
  // The project's scripts: every check in the suite, run from the build.
  mkdirSync(join(dir, "test_scripts"), { recursive: true });
  writeFileSync(join(dir, "test_scripts", "run_unittests_sh.sh"), "exit 0\n");
  writeFileSync(
    join(dir, "test_scripts", "run_conformance_tests_sh.sh"),
    'cd "$1" || exit 2\nfor check in $(cd "$2" && find . -name "*.sh" | sort); do sh "$2/$check" || exit 1; done\n',
  );
  conformanceRuns.length = 0;
  passing = true;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("conformance for a spec diff", () => {
  it("applies the diff and brings the tests of the latest codebase in line with it, even for a change to a module it requires", async () => {
    for (const name of ["base", "top"]) built(name);
    const diff = diffOf("base", module_(["- Base one.", "- Base two, now with a limit of ten."]));

    const result = await renderSpecDiffConformance({ plainFile: file("base"), diff, cwd: dir });

    // The change went into the file, and the tests into top's codebase - where base's code now lives.
    expect(readFileSync(file("base"), "utf8")).toContain("now with a limit of ten");
    expect(result.diff).toBe("applied");
    expect(conformanceRuns).toHaveLength(1);
    expect(conformanceRuns[0]).toMatchObject({ plainFile: file("top"), buildDir: buildOf("top"), conformanceDir: testsOf("top"), diff, module: "top" });
    // Given the spec as it stands with the change in.
    expect(conformanceRuns[0]!.specs).toContain("now with a limit of ten");
    // The whole suite ran, and passed; top's labelled functionality is recorded as passing.
    expect(result.regression?.passed).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.tested).toEqual(["1"]);
    // Nothing was rendered: the record still says what the code was built from.
    const inherited = readBuiltTree(buildOf("top"))!["required functional specs"] as Array<{ markdown: string; module: string; frid: string }>;
    expect(inherited.find((spec) => spec.module === "base" && spec.frid === "2")!.markdown).toBe("- Base two.");
    // The tests it wrote are committed.
    expect(existsSync(join(testsOf("top"), "check_1.sh"))).toBe(true);
    expect(describeSpecDiffConformance(result)).toContain("in line with the spec change");
  });

  it("stops at a conformance step that does not pass, and undoes it", async () => {
    built("base");
    passing = false;
    const diff = diffOf("base", module_(["- Base one.", "- Base two, now with a limit of ten."]));
    const result = await renderSpecDiffConformance({ plainFile: file("base"), diff, cwd: dir });
    expect(result).toMatchObject({ passed: false, stoppedAt: "conformance" });
    expect(result.regression).toBeUndefined();
    expect(existsSync(join(testsOf("base"), "check_1.sh"))).toBe(false);
  });

  it("tests a change with no functional spec written yet - a definition - rather than refusing it", async () => {
    const none = "***implementation reqs***\n\n- Python.\n\n***test reqs***\n\n- Shell scripts.\n";
    writeFileSync(file("base"), none);
    mkdirSync(buildOf("base"), { recursive: true });
    writeFileSync(join(buildOf("base"), "app.sh"), "echo base\n");
    const diff = diffOf("base", "***definitions***\n\n- :User: is a person.\n\n" + none);

    const result = await renderSpecDiffConformance({ plainFile: file("base"), diff, cwd: dir });

    expect(conformanceRuns).toHaveLength(1);
    expect(conformanceRuns[0]).toMatchObject({ frid: undefined, diff, module: "base" });
    expect(result.passed).toBe(true);
  });

  it("tests a change with no functional spec written yet - a definition - rather than refusing it", async () => {
    const none = "***implementation reqs***\n\n- Python.\n\n***test reqs***\n\n- Shell scripts.\n";
    writeFileSync(file("base"), none);
    mkdirSync(buildOf("base"), { recursive: true });
    writeFileSync(join(buildOf("base"), "app.sh"), "echo base\n");
    const diff = diffOf("base", "***definitions***\n\n- :User: is a person.\n\n" + none);

    const result = await renderSpecDiffConformance({ plainFile: file("base"), diff, cwd: dir });

    expect(conformanceRuns).toHaveLength(1);
    expect(conformanceRuns[0]).toMatchObject({ frid: undefined, diff, module: "base" });
    expect(result.passed).toBe(true);
  });

  it("needs test reqs to write conformance tests from", async () => {
    writeFileSync(file("base"), module_(["- Base one."], undefined, false));
    built("base");
    const diff = diffOf("base", module_(["- Base one, changed."], undefined, false));
    await expect(renderSpecDiffConformance({ plainFile: file("base"), diff, cwd: dir })).rejects.toThrow("has no test reqs");
    expect(conformanceRuns).toHaveLength(0);
  });
});

describe("the work loop's conformance jobs", () => {
  it("write the tests of what the code is built from, run the whole suite with them, and record and commit what they are written for", async () => {
    const { createWorkLoop } = await import("../../src/render/loop.ts");
    const { createJobRegistry } = await import("../../src/render/jobs.ts");
    const { readRecord, writeCodeRecord } = await import("../../src/render/records.ts");
    const { recordHistory, historyLog } = await import("../../src/render/history.ts");
    // The code, as a render lands it: its record, committed.
    const run = async (job: { buildDir: string; spec: { tree: object }; planned: { title: string } }) => {
      mkdirSync(job.buildDir, { recursive: true });
      writeFileSync(join(job.buildDir, "app.sh"), "echo base\n", { flag: "a" });
      writeCodeRecord(job.buildDir, job.spec.tree as never);
      recordHistory(job.buildDir, job.planned.title);
      return { landed: true, report: "built" };
    };
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, conformanceOn: () => true, run: run as never });
    await loop.bringUp(file("base"));
    await loop.drain();

    // A conformance job after each code job: the conformance agent given the spec whole - its test reqs with it.
    expect(conformanceRuns).toHaveLength(2);
    expect(conformanceRuns[0]!.specs).toContain("Shell scripts.");
    expect(conformanceRuns[0]).toMatchObject({ buildDir: buildOf("base"), conformanceDir: testsOf("base") });
    const tested = JSON.stringify(readRecord(testsOf("base")));
    expect(tested).toContain("Base one.");
    expect(tested).toContain("Base two.");
    expect(tested).toContain("Shell scripts.");
    expect(historyLog(buildOf("base"))).toContain("conformance tests:");
  });

  it("leave nothing of a conformance job that does not pass, and go on building the code", async () => {
    const { createWorkLoop } = await import("../../src/render/loop.ts");
    const { createJobRegistry } = await import("../../src/render/jobs.ts");
    const { readRecord, writeCodeRecord } = await import("../../src/render/records.ts");
    const { recordHistory } = await import("../../src/render/history.ts");
    passing = false;
    const built: string[] = [];
    const run = async (job: { buildDir: string; spec: { tree: object }; planned: { title: string } }) => {
      built.push(job.planned.title);
      mkdirSync(job.buildDir, { recursive: true });
      writeFileSync(join(job.buildDir, "app.sh"), "echo base\n", { flag: "a" });
      writeCodeRecord(job.buildDir, job.spec.tree as never);
      recordHistory(job.buildDir, job.planned.title);
      return { landed: true, report: "built" };
    };
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, conformanceOn: () => true, run: run as never });
    await loop.bringUp(file("base"));
    await loop.drain();
    expect(built).toHaveLength(2);
    expect(readRecord(testsOf("base"))).toBeNull();
    expect(existsSync(join(testsOf("base"), "check_1.sh"))).toBe(false);
    expect(loop.status()[0]!.why).toMatch(/did not pass/);
  });
});
