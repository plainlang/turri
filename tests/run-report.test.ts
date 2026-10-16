import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conformanceOption, overrideConfig, projectModels, readProjectConfig, reviewOption, roleModel } from "../src/config.ts";
import { parseArgs } from "../src/cli-options.ts";
import { headlessOptions, moduleStates } from "../src/loop-cli.ts";
import { reportModelEvent, reportUsage } from "../src/regenerate/activity.ts";
import { createJobRegistry } from "../src/regenerate/jobs.ts";
import { recordHistory } from "../src/regenerate/lineage.ts";
import { chainSpec, functionalityCompletion } from "../src/regenerate/loop.ts";
import { writeCodeRecord, writeTestsRecord } from "../src/regenerate/records.ts";
import { resolveRequiresChain } from "../src/regenerate/requires.ts";
import { startRunReport, writeAtomically, type UsageTotals } from "../src/run-report.ts";

const TURRI = resolve("bin/turri.mjs");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-report-"));
});
afterEach(() => {
  overrideConfig({});
  rmSync(dir, { recursive: true, force: true });
});

const spent = (input: number, output: number, cost: number) => ({ input, output, cacheRead: input * 10, cacheWrite: input * 2, cost });

/** A report that is never written as the process exits: the test asks for it. */
function report(file = join(dir, "report.json")) {
  return startRunReport({
    file,
    command: ["regenerate", "app.plain"],
    specFile: join(dir, "app.plain"),
    projectDir: dir,
    conformanceTests: "off",
    models: { harness: { model: "p/big", thinking: "medium" }, coding: { model: "p/small", thinking: "low" }, judge: { model: "p/big", thinking: "medium" } },
    onExit: false,
  });
}

describe("the run report's usage", () => {
  it("adds up to the pulses' own usage - what their lines print - and the calls made outside any pulse", async () => {
    const reporter = report();
    const registry = createJobRegistry();
    reporter.attach({ jobs: () => registry.list() });
    // Two pulses, their agents' calls reported as pi.ts reports them: the job's usage, and the event beside it.
    const pulse = (kind: string, calls: Array<ReturnType<typeof spent>>, landed: boolean) =>
      registry.start({
        kind,
        summary: kind,
        module: "app",
        run: async () => {
          reportModelEvent({ kind: "turn", model: "p/small:low", role: "coding", label: "app coding agent" });
          for (const usage of calls) {
            reportUsage(usage);
            reportModelEvent({ kind: "call", model: "p/small:low", role: "coding", label: "app coding agent", usage, ms: 1500 });
          }
          return { report: "done", details: { landed } };
        },
      });
    const code = pulse("regenerate", [spent(100, 20, 0.5), spent(200, 30, 0.25)], true);
    const tests = pulse("conformance", [spent(50, 5, 0.125)], false);
    await registry.wait(code.id);
    await registry.wait(tests.id);
    // The planner, outside any pulse.
    reportModelEvent({ kind: "turn", model: "p/big:medium", role: "planner" });
    reportModelEvent({ kind: "call", model: "p/big:medium", role: "planner", usage: spent(1000, 100, 2), ms: 4000 });

    const built = reporter.build() as {
      usage: Record<"total" | "in_pulses" | "outside_pulses", UsageTotals> & Record<"by_model" | "by_role" | "by_pulse_kind", Record<string, UsageTotals>>;
      pulses: { counts: Record<string, number>; list: Array<{ kind: string; landed: boolean; usage: UsageTotals }> };
    };
    const jobTokens = registry.list().reduce((sum, job) => sum + job.usage.input, 0);
    expect(built.usage.in_pulses.input_tokens).toBe(jobTokens);
    expect(built.usage.in_pulses).toMatchObject({ input_tokens: 350, output_tokens: 55, cache_read_tokens: 3500, cache_write_tokens: 700, cost_usd: 0.875, llm_calls: 3, agent_turns: 2, model_seconds: 4.5 });
    expect(built.usage.outside_pulses).toMatchObject({ input_tokens: 1000, output_tokens: 100, cost_usd: 2, llm_calls: 1, agent_turns: 1, model_seconds: 4 });
    expect(built.usage.total).toMatchObject({ input_tokens: 1350, output_tokens: 155, cost_usd: 2.875, llm_calls: 4, agent_turns: 3 });
    expect(built.usage.by_model["p/small:low"]).toMatchObject({ input_tokens: 350, llm_calls: 3 });
    expect(built.usage.by_role.planner).toMatchObject({ input_tokens: 1000, cost_usd: 2 });
    expect(built.usage.by_pulse_kind.code).toMatchObject({ input_tokens: 300, llm_calls: 2, agent_turns: 1 });
    expect(built.usage.by_pulse_kind.conformance).toMatchObject({ input_tokens: 50, llm_calls: 1 });
    expect(built.pulses.counts).toMatchObject({ total: 2, landed: 1, failed: 0, rolled_back: 1, running: 0 });
    expect(built.pulses.list.map((one) => [one.kind, one.landed, one.usage.input_tokens])).toEqual([
      ["code", true, 300],
      ["conformance", false, 50],
    ]);
  });
});

describe("the run report's spec gaps", () => {
  it("lists each gap a pulse's agents met, with its pulse and whether that pulse landed", async () => {
    const reporter = report();
    const registry = createJobRegistry();
    reporter.attach({ jobs: () => registry.list() });
    const pulse = (pulse: number, landed: boolean, specGaps?: Array<{ question: string; assumption: string }>) =>
      registry.start({ kind: "regenerate", summary: "app", module: "app", pulse, run: async () => ({ report: "done", details: { landed, ...(specGaps !== undefined ? { specGaps } : {}) } }) });
    const first = pulse(1, true, [{ question: "Are names case-sensitive?", assumption: "Names are case-sensitive" }]);
    const quiet = pulse(2, true);
    const second = pulse(3, false, [{ question: "What happens to an archived contact?", assumption: "It is left as synced" }]);
    for (const job of [first, quiet, second]) await registry.wait(job.id);

    expect((reporter.build() as { spec_gaps: unknown }).spec_gaps).toEqual([
      { module: "app", pulse: 1, pulse_id: first.id, landed: true, question: "Are names case-sensitive?", assumption: "Names are case-sensitive" },
      { module: "app", pulse: 3, pulse_id: second.id, landed: false, question: "What happens to an archived contact?", assumption: "It is left as synced" },
    ]);
  });

  it("is an empty list when no agent met one", () => {
    expect((report().build() as { spec_gaps: unknown }).spec_gaps).toEqual([]);
  });
});

describe("how the run report says the run ended", () => {
  it("is running until the run ends, then what the run decided - unless a crash came after", () => {
    const reporter = report();
    expect((reporter.build() as { outcome: { status: string } }).outcome.status).toBe("running");
    reporter.end("incomplete", "app needs a start over");
    expect((reporter.build(1) as { outcome: unknown }).outcome).toMatchObject({ status: "incomplete", exit_code: 1, error: "app needs a start over" });
    reporter.crashed(new Error("the disk is full"));
    expect((reporter.build(1) as { outcome: unknown }).outcome).toMatchObject({ status: "crashed", error: "the disk is full" });
  });

  it("calls an exit on a signal's code, the run not ended, interrupted", () => {
    expect((report().build(143) as { outcome: unknown }).outcome).toMatchObject({ status: "interrupted", signal: "SIGTERM", exit_code: 143 });
    expect((report().build(130) as { outcome: unknown }).outcome).toMatchObject({ status: "interrupted", signal: "SIGINT" });
  });

  it("is written as a process stopped by SIGTERM exits, the way turri's own handler exits", async () => {
    const file = join(dir, "out", "report.json");
    const child = join(dir, "child.ts");
    writeFileSync(
      child,
      [
        `import { startRunReport } from ${JSON.stringify(resolve("src/run-report.ts"))};`,
        `startRunReport({ file: ${JSON.stringify(file)}, command: ["regenerate"], specFile: "app.plain", projectDir: ${JSON.stringify(dir)}, conformanceTests: "off", models: { harness: {}, coding: {}, judge: {} } });`,
        `process.on("SIGTERM", () => process.exit(143));`,
        `console.log("ready");`,
        `setInterval(() => {}, 1000);`,
      ].join("\n"),
    );
    const proc = spawn(process.execPath, [child], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((done) => proc.stdout.once("data", () => done()));
    // Written as it started: a run killed outright still leaves one.
    expect(JSON.parse(readFileSync(file, "utf8")).outcome.status).toBe("running");
    const code = await new Promise<number | null>((done) => {
      proc.once("exit", (exit) => done(exit));
      proc.kill("SIGTERM");
    });
    expect(code).toBe(143);
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written.outcome).toMatchObject({ status: "interrupted", signal: "SIGTERM", exit_code: 143 });
    expect(written.finished_at).not.toBeNull();
    expect(written.schema_version).toBe(1);
  });
});

describe("writing the run report", () => {
  it("replaces the file whole, leaving nothing beside it", () => {
    const file = join(dir, "deep", "report.json");
    writeAtomically(file, "{\"a\":1}\n");
    writeAtomically(file, "{\"a\":2}\n");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ a: 2 });
    expect(readdirSync(join(dir, "deep"))).toEqual(["report.json"]);
  });
});

/** A spec of its own functional specs, requiring another or not. */
function spec(name: string, specs: string[], requires?: string): string {
  const file = join(dir, `${name}.plain`);
  writeFileSync(
    file,
    `${requires !== undefined ? `---\nrequires:\n  - ${requires}\n---\n\n` : ""}***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n${specs.map((text) => `- ${text}`).join("\n\n")}\n`,
  );
  return file;
}

describe("the functional specs completed", () => {
  it("counts each module's in the furthest-built codebase - what its record has as the spec has it now", () => {
    spec("base", ["Base one.", "Base two."]);
    const app = spec("app", ["App one.", "App two.", "App three."], "base");
    const chain = resolveRequiresChain(app, [], undefined, { allowNoFunctionalities: true });
    // app's codebase: built on all of base, and its own first two - the third not landed yet.
    const tree = chainSpec(chain).tree;
    const own = tree["functional specs"] as unknown[];
    writeCodeRecord(chain[1]!.buildDir, { ...tree, "functional specs": own.slice(0, 2) });
    mkdirSync(join(chain[1]!.buildDir, "src"), { recursive: true });
    // Conformance tests written for app's first.
    writeTestsRecord(join(dir, "plain_modules", "app", "tests"), { "functional specs": [{ markdown: "- App one.", frid: "1" }] });

    const [counted] = functionalityCompletion(app);
    expect(counted!.codebase).toBe(chain[1]!.buildDir);
    expect(counted!.modules).toEqual([
      { module: "base", specified: 2, completed: 2, conformanceTested: 0, incomplete: [] },
      { module: "app", specified: 3, completed: 2, conformanceTested: 1, incomplete: ["3"] },
    ]);

    // base's second spec says something else now: what app's code has of it is not what the spec says.
    spec("base", ["Base one.", "Base two, changed."]);
    expect(functionalityCompletion(app)[0]!.modules[0]).toMatchObject({ completed: 1, incomplete: ["2"] });
  });

  it("counts nothing completed where nothing is built", () => {
    const app = spec("app", ["App one."]);
    expect(functionalityCompletion(app)[0]!.modules).toEqual([{ module: "app", specified: 1, completed: 0, conformanceTested: 0, incomplete: ["1"] }]);
  });
});

describe("each codebase's state", () => {
  it("is complete only with nothing left to regenerate, and says why when it is not", () => {
    const base = { plainFile: "x.plain", scheduled: [] };
    expect(
      moduleStates([
        { ...base, module: "a", code: null, conformance: undefined },
        { ...base, module: "b", code: null, conformance: { fresh: false, add: [], patch: [], again: [], delete: [], mechanical: true } },
        { ...base, module: "c", code: null, conformance: null, why: "pulse 1 did not land" },
        { ...base, module: "d", code: null, conformance: null, startOver: { requires: ["base"], codebases: ["d"] } },
        { ...base, module: "e", code: null, conformance: null, running: { jobId: "j", title: "t" } },
      ]),
    ).toEqual([
      { module: "a", state: "complete" },
      { module: "b", state: "incomplete", why: "its conformance tests are not written for what is built" },
      { module: "c", state: "halted", why: "pulse 1 did not land" },
      { module: "d", state: "start_over_needed", why: "built without base, which it now requires: run with --start-over" },
      { module: "e", state: "running" },
    ]);
  });
});

describe("a headless run's options", () => {
  const exits = () =>
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

  it("refuses an option the command does not take, rather than eating the word after it", () => {
    const exit = exits();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => parseArgs(["app.plain", "--to", "3"], [], "usage")).toThrow("exit 1");
    expect(error.mock.calls.at(-1)?.[0]).toContain("No such option: --to");
    expect(parseArgs(["app.plain", "--report=r.json", "--coding-model", "p/m"], [], "usage", ["--report"])).toEqual({ positional: ["app.plain"], options: { report: "r.json", model: "p/m" } });
    // An option where a value should be is not taken as the value: the run would lose it.
    expect(() => parseArgs(["app.plain", "--report", "--start-over"], ["--start-over"], "usage", ["--report"])).toThrow("exit 1");
    expect(error.mock.calls.at(-1)?.[0]).toContain("--report needs a value, not the option --start-over");
    expect(() => parseArgs(["app.plain", "--report"], [], "usage", ["--report"])).toThrow("exit 1");
    expect(parseArgs(["--report=--odd.json"], [], "usage", ["--report"]).options).toEqual({ report: "--odd.json" });
    exit.mockRestore();
    error.mockRestore();
  });

  it("reads --harness-model, --coding-model, --judge-model, --conformance-tests and --review as the config's keys, the config's order kept", () => {
    writeFileSync(join(dir, "config.yaml"), "conformance-tests: false\nreview: true\njudge-model: p/old\nmodels:\n  judge: { model: p/own-judge, thinking: high }\nunittests-script: run_unittests.sh\n");
    const options = { "harness-model": "p/harness", model: "p/coding:low", "judge-model": "p/judge", "conformance-tests": "all", review: "false", report: "r.json" };
    expect(headlessOptions(options, true)).toEqual({ report: "r.json" });
    const config = readProjectConfig(dir);
    expect(config).toMatchObject({
      harnessModel: { model: "p/harness" },
      codingModel: { model: "p/coding", thinking: "low" },
      judgeModel: { model: "p/judge" },
      conformanceTests: true,
      review: false,
      unittestsScript: "run_unittests.sh",
    });
    // A models: entry wins over judge-model, as it does when the file names both.
    expect(roleModel(config, "judge")).toEqual({ model: "p/own-judge", thinking: "high" });
    expect(projectModels(config)).toMatchObject({ harness: { model: "p/harness" }, coding: { model: "p/coding", thinking: "low" } });
  });

  it("takes the config's own values, and only those", () => {
    expect(["all", "true", "chosen", "module", "false"].map(conformanceOption)).toEqual([true, true, "chosen", "module", false]);
    expect(conformanceOption("off")).toBeUndefined();
    expect(["true", "false", "off"].map(reviewOption)).toEqual([true, false, undefined]);
  });

  it("refuses a value it cannot read", () => {
    const exit = exits();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => headlessOptions({ "conformance-tests": "sometimes" }, true)).toThrow("exit 1");
    expect(() => headlessOptions({ review: "maybe" }, true)).toThrow("exit 1");
    expect(() => headlessOptions({ report: undefined }, true)).toThrow("exit 1");
    exit.mockRestore();
    error.mockRestore();
  });
});

describe("turri regenerate, unattended", () => {
  it("stops, with no terminal to ask, at a codebase it would have to start over - and reports why", () => {
    spec("base", ["Base one."]);
    const app = spec("app", ["App one."]);
    const code = join(dir, "plain_modules", "app", "code");
    mkdirSync(code, { recursive: true });
    writeFileSync(join(code, "main.py"), "print(1)\n");
    writeCodeRecord(code, chainSpec(resolveRequiresChain(app, [], undefined, { allowNoFunctionalities: true })).tree);
    recordHistory(code, "app pulse 1 landed");
    // Now it requires base, which its code was not built on.
    spec("app", ["App one."], "base");

    // The whole command a benchmark runs: every model, conformance tests and review given on the command line.
    const command = [
      "regenerate", "app.plain", "--harness-model", "nowhere/big", "--coding-model", "nowhere/small",
      "--conformance-tests", "all", "--review", "false", "--judge-model", "nowhere/judge",
      "--build-dir", "out/build", "--report", "out/report.json",
    ];
    const run = spawnSync(process.execPath, [TURRI, ...command], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("--start-over");
    const written = JSON.parse(readFileSync(join(dir, "out", "report.json"), "utf8"));
    // --coding-model reaches the command as --model: cli.ts reads the one as the other.
    expect(written.command).toEqual(command.map((arg) => (arg === "--coding-model" ? "--model" : arg)));
    expect(written.models).toMatchObject({
      harness: { model: "nowhere/big", thinking: "medium" },
      coding: { model: "nowhere/small", thinking: "low" },
      judge: { model: "nowhere/judge", thinking: "medium" },
    });
    expect(written).toMatchObject({ conformance_tests: "all", review: false });
    expect(written.build_dir_export).toMatchObject({ exported: true, module: "app" });
    expect(readdirSync(join(dir, "out", "build"))).toEqual(["main.py"]);
    expect(written.outcome).toMatchObject({ status: "incomplete", exit_code: 1, modules: [{ module: "app", state: "start_over_needed" }] });
    expect(written.functionalities.total).toEqual({ specified: 2, completed: 1, conformance_tested: 0 });
    expect(written.pulses.counts.total).toBe(0);
  });

  it("refuses a --build-dir that holds the project", () => {
    const app = spec("app", ["App one."]);
    const run = spawnSync(process.execPath, [TURRI, "regenerate", app, "--model", "nowhere/no-model", "--build-dir", dir], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 60_000 });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("holds the project");
    expect(existsSync(join(dir, "app.plain"))).toBe(true);
  });
});
