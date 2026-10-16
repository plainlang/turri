import { sweepOrphanedGroups } from "./regenerate/shell.ts";
import { createInterface } from "node:readline/promises";
import { relative, resolve, sep } from "node:path";
import {
  configForSpec,
  inheritModel,
  modelOnly,
  modelSpec,
  projectModels,
  readProjectConfig,
  roleModel,
  ROLE_THINKING,
  splitModelSpec,
  type ProjectConfig,
} from "./config.ts";
import { PACKAGE_ROOT } from "./environment.ts";
import { c } from "./module-report.ts";
import { tryItCommand } from "./regenerate/delivery.ts";
import { describeDiagnosis, diagnoseFailure } from "./regenerate/diagnose.ts";
import { createJobRegistry, pulseName, type Job } from "./regenerate/jobs.ts";
import type { SpecGap } from "./regenerate/notes.ts";
import { conformanceChooser } from "./regenerate/choose-conformance.ts";
import { createWorkLoop, describeModules, functionalityCompletion, promptOf, type DriftReport, type ModuleStatus, type WorkLoop } from "./regenerate/loop.ts";
import { MODULES_DIR, projectDirOf } from "./regenerate/paths.ts";
import { exportModule } from "./regenerate/release.ts";
import { listFiles } from "./regenerate/testing.ts";
import { startRunReport, type ModuleState, type RunReporter } from "./run-report.ts";
import { configKeyOptions, optionValue } from "./cli-options.ts";

/**
 * What every command that builds - `turri regenerate`, `conform`, `spec-diff` - does around its own
 * request of the work loop, as the chat does it: the project's models, a job that fails run once more and, failing again,
 * diagnosed, a line as each job starts and ends; then the loop run until nothing more can start, how each job ended,
 * and exit 1 when any failed or a module is not complete. With `dryRun`, the work is planned and the prompt of the first job each codebase would
 * start printed, and nothing runs.
 */
export async function runLoop(options: {
  plainFile: string;
  /** Where the code is exported to as the run ends, however it ends: the furthest-built codebase's last commit. */
  buildDir?: string;
  /** The run report's file (`--report`): see run-report.ts. */
  report?: string;
  /** The command, as the report gives it: its name and its arguments. */
  command?: string[];
  dryRun?: boolean;
  /** Start over, unasked, a codebase that has to be on a module it now requires (`--start-over`). */
  startOver?: boolean;
  /** The request: bring up, regenerate, conformance. */
  ask: (loop: WorkLoop) => Promise<ModuleStatus[]>;
}): Promise<never> {
  const plainFile = resolve(options.plainFile);
  // What a turri that was killed left running - commands' process groups - stopped before anything starts.
  const orphans = sweepOrphanedGroups();
  if (orphans > 0) console.log(`Stopped ${orphans} process group${orphans === 1 ? "" : "s"} a turri that was killed left running.`);
  const project = { ...readProjectConfig(process.cwd()), ...Object.fromEntries(Object.entries(configForSpec(plainFile)).filter(([, value]) => value !== undefined)) };
  // The models as the config has them - with a command's own options read as its keys (headlessOptions), as the chat reads them.
  const model = modelSpec(projectModels(project).coding);
  const projectDir = projectDirOf(plainFile);
  const buildDir = options.buildDir !== undefined && options.dryRun !== true ? resolve(options.buildDir) : undefined;
  if (buildDir !== undefined) refuseBuildDir(buildDir, projectDir);

  // The code, exported into --build-dir as the process exits - however it exits - before the report's last write.
  let exported: Record<string, unknown> | undefined;
  if (buildDir !== undefined) {
    process.once("exit", () => {
      exported = exportCode(plainFile, buildDir);
      console.error(exported.exported === true ? `The code is in ${buildDir} (${String(exported.module)} at ${String(exported.commit)}).` : `Nothing exported to ${buildDir}: ${String(exported.why)}`);
    });
  }
  const report =
    options.report !== undefined && options.dryRun !== true
      ? startRunReport({
          file: options.report,
          command: options.command ?? process.argv.slice(2),
          specFile: plainFile,
          projectDir,
          ...(buildDir !== undefined ? { buildDir } : {}),
          conformanceTests: conformanceLabel(project.conformanceTests),
          review: project.review === true,
          models: reportModels(project, model),
        })
      : undefined;
  try {
    return await runLoopReporting({ ...options, plainFile, project, model, projectDir, reporter: report, exported: () => exported });
  } catch (error) {
    report?.crashed(error);
    throw error;
  }
}

async function runLoopReporting(
  options: Parameters<typeof runLoop>[0] & {
    project: ProjectConfig;
    model: string | undefined;
    projectDir: string;
    reporter: RunReporter | undefined;
    exported: () => Record<string, unknown> | undefined;
  },
): Promise<never> {
  const { plainFile, project, model, projectDir, reporter: report } = options;

  // Each job as it starts and as it ends - the transcript of each is in .turri/jobs/.
  const seen = new Map<string, string>();
  const registry = createJobRegistry({
    retries: 1,
    diagnose: async (job, failures, jobLog) => {
      const diagnosis = await diagnoseFailure({ job, failures, projectDir, harnessDir: PACKAGE_ROOT, jobLog, model: modelSpec(modelOnly(job.model ?? model)) });
      return diagnosis !== undefined ? describeDiagnosis(diagnosis) : undefined;
    },
    onChange: (job: Job) => {
      const line = job.status === "running" ? `${job.stage ?? "started"}` : job.status;
      if (seen.get(job.id) === line) return;
      seen.set(job.id, line);
      if (job.status === "running") console.log(`${c.cyan(`▶ ${job.id}`)} ${pulseName(job)}${job.stage !== undefined ? c.dim(` - ${job.stage}`) : ""}`);
    },
    onFinish: (job: Job) => {
      const mark = job.status === "succeeded" ? c.green("✓") : job.status === "stopped" ? c.dim("■") : c.red("✗");
      console.log(`${mark} ${job.id} ${pulseName(job)} - ${job.status}`);
      if (job.status !== "succeeded") console.log(c.dim((job.announce ?? job.report ?? job.error ?? "").trim()));
      // Its report is not printed when it succeeds, and nobody is asked here: the spec gaps its agents met are said.
      else for (const gap of (job.details as { specGaps?: SpecGap[] } | undefined)?.specGaps ?? []) console.log(c.yellow(`  spec gap: ${gap.question}`), c.dim(`Meanwhile: ${gap.assumption}`));
      report?.write();
    },
  });
  const planner = modelSpec(projectModels(project).harness);
  const loop = createWorkLoop({
    registry,
    cwd: process.cwd(),
    ...(model !== undefined ? { modelFor: () => model } : {}),
    ...(planner !== undefined ? { plannerModel: planner } : {}),
    ...(options.dryRun === true ? { dryRun: true } : {}),
    // Under conformance-tests: chosen or module, the chooser decides as a pulse ends, as in the chat - on the harness
    // model, else the coding model: never pi's own default, which may be one this account cannot reach.
    onChoose: conformanceChooser({ model: () => planner ?? model, ...(options.dryRun === true ? { dryRun: true } : {}) }),
  });
  report?.attach({
    jobs: () => registry.list(),
    modules: () => moduleStates(loop.drift(plainFile)),
    completion: () => functionalityCompletion(plainFile),
    atExit: () => {
      const exported = options.exported();
      return exported !== undefined ? { build_dir_export: exported } : undefined;
    },
  });
  let planned = await options.ask(loop);
  console.log(describeModules(planned, { for: "command line" }));

  // A codebase built without a module it now requires is started over only when the person says so.
  const toStartOver = planned.filter((status) => status.startOver !== undefined);
  if (toStartOver.length > 0 && options.dryRun !== true) {
    const why = toStartOver
      .map(({ startOver }) => `${startOver!.codebases.join(", ")} was built without ${startOver!.requires.join(", ")}, which it now requires: no change to its code can bring it in.`)
      .join("\n");
    // No terminal and no --start-over: no one to ask, so the run stops here rather than build nothing and say it is done.
    if (options.startOver !== true && process.stdin.isTTY !== true) {
      const message = `${why}\nThere is no terminal to ask whether to start over: run it again with --start-over to start over without asking.`;
      console.error(c.red(message));
      report?.end("incomplete", message);
      process.exit(1);
    }
    const agreed =
      options.startOver === true ||
      (await askAtTerminal(
        "Start over?",
        `${why}\nStarting over takes its code and conformance tests out - they stay in its history - and builds it again from the bottom of the chain.`,
      ));
    if (agreed === true) {
      planned = await loop.startOver(plainFile, model !== undefined ? { model } : {});
      console.log(describeModules(planned, { for: "command line" }));
    }
  }

  if (options.dryRun === true) {
    for (const first of loop.firsts()) {
      console.log(`\n${c.bold(`${first.module}: ${first.planned.title}`)}${first.planned.track === "conformance" ? c.dim(" (conformance)") : ""}`);
      if (first.planned.track === "conformance") {
        console.log(c.dim("A conformance job's prompt is built from what the code it tests holds once it is built: not shown before."));
        continue;
      }
      console.log((await promptOf(first)) ?? "(no task)");
    }
    process.exit(0);
  }

  // Until nothing more starts: a choice is made inside the pulse it follows, so draining waits for it.
  await loop.drain();
  console.log(`\n${describeModules(loop.status(), { for: "command line" })}`);
  const ended = registry.list();
  const failed = ended.filter((job) => job.status === "failed");
  // Complete: every codebase regenerated from the spec as it is, its conformance tests too - nothing halted, nothing
  // waiting for a start over, nothing the planner left out.
  const unfinished = moduleStates(loop.drift(plainFile)).filter((module) => module.state !== "complete");
  const verdict =
    failed.length > 0
      ? c.red(c.bold(`${failed.length} job${failed.length === 1 ? "" : "s"} failed`))
      : unfinished.length > 0
        ? c.red(c.bold(`not complete: ${unfinished.map((module) => `${module.module}${module.why !== undefined ? ` - ${module.why}` : ""}`).join("; ")}`))
        : c.green(c.bold("all jobs done"));
  console.log(`\n${verdict}`);
  for (const job of [...ended].reverse()) console.log(`  ${job.id} ${pulseName(job)}: ${job.status}`);
  if (ended.some((job) => job.status === "succeeded")) console.log(`\n${tryItCommand(plainFile)}`);
  report?.end(failed.length > 0 ? "failed" : unfinished.length > 0 ? "incomplete" : "completed");
  process.exit(failed.length === 0 && unfinished.length === 0 ? 0 : 1);
}

/** How each codebase stands, from what is left to regenerate there. */
export function moduleStates(reports: DriftReport[]): ModuleState[] {
  return reports.map((report): ModuleState => {
    const state: ModuleState["state"] =
      report.running !== undefined
        ? "running"
        : report.startOver !== undefined
          ? "start_over_needed"
          : report.why !== undefined
            ? "halted"
            : report.code === null && (report.conformance === null || report.conformance === undefined) && report.scheduled.length === 0
              ? "complete"
              : "incomplete";
    const why =
      state === "start_over_needed"
        ? `built without ${report.startOver!.requires.join(", ")}, which it now requires: run with --start-over`
        : state === "incomplete"
          ? report.code !== null && report.code !== undefined
            ? "its code is not regenerated from the spec as it is"
            : "its conformance tests are not written for what is built"
          : report.why;
    return { module: report.module, state, ...(why !== undefined ? { why } : {}) };
  });
}

/**
 * A --build-dir the export would wipe something in: the project, a folder holding it, or one inside plain_modules.
 * Anything else is the export's own, its contents replaced as the run ends.
 */
function refuseBuildDir(buildDir: string, projectDir: string): void {
  const within = (dir: string, of: string) => dir === of || dir.startsWith(`${of}${sep}`);
  const why = within(projectDir, buildDir)
    ? "it holds the project, and the export replaces what is in it"
    : within(buildDir, resolve(projectDir, MODULES_DIR))
      ? `it is inside ${MODULES_DIR}, which turri regenerates in`
      : undefined;
  if (why === undefined) return;
  console.error(`--build-dir ${buildDir} cannot be used: ${why}. Name a folder of its own - the code is exported there as the run ends.`);
  process.exit(1);
}

/** The furthest-built codebase's last commit, exported into `dir` - or why nothing was. */
function exportCode(plainFile: string, dir: string): Record<string, unknown> {
  try {
    const deployment = exportModule(plainFile, undefined, dir);
    const files = listFiles(dir).length;
    // Its history began, and nothing landed in it yet: only the harness's own files, which are left out.
    if (files === 0) return { exported: false, dir, why: `nothing has landed in ${deployment.moduleName} yet: its codebase holds no code` };
    return { exported: true, dir, module: deployment.moduleName, commit: deployment.commit, files };
  } catch (error) {
    return { exported: false, dir, why: error instanceof Error ? error.message : String(error) };
  }
}

/** `conformance-tests:` as the report says it - not set is false. */
function conformanceLabel(setting: ProjectConfig["conformanceTests"]): string {
  return setting === true ? "all" : setting === "chosen" || setting === "module" ? setting : "false";
}

/** The models of the three roles as this run uses them: the coding model given, the others as they fall back - each with the level it thinks at. */
function reportModels(project: ProjectConfig, model: string | undefined): Record<"harness" | "coding" | "judge", { model?: string; thinking?: string }> {
  const coding = splitModelSpec(model);
  const harness = projectModels(project).harness ?? modelOnly(model);
  // As the judge's agent finds it: its models: entry over judge-model over models.default, else the coding model's.
  const judge = inheritModel(roleModel(project, "judge"), modelOnly(model)) ?? {};
  const choice = (given: { model?: string; thinking?: string }, fallback: string | undefined) => ({
    ...(given.model !== undefined ? { model: given.model } : {}),
    ...((given.thinking ?? fallback) !== undefined ? { thinking: given.thinking ?? fallback } : {}),
  });
  return {
    harness: choice(harness, ROLE_THINKING.planner),
    coding: choice(coding, ROLE_THINKING.coding),
    judge: choice(judge, ROLE_THINKING.judge),
  };
}

/**
 * The options every command that regenerates takes for a headless run: `--report` and `--build-dir`, and the config's
 * own keys (configKeyOptions) - `--harness-model`, `--coding-model` (`--model`), `--judge-model`, `--review` and, where
 * `conformance` is true, `--conformance-tests` - read as if config.turri.yaml had them. Exits on a value it cannot read.
 */
export function headlessOptions(options: Record<string, string | undefined>, conformance: boolean): { report?: string; buildDir?: string } {
  configKeyOptions(options, { conformance, review: true });
  const report = optionValue(options, "report");
  const buildDir = optionValue(options, "build-dir");
  return { ...(report !== undefined ? { report } : {}), ...(buildDir !== undefined ? { buildDir } : {}) };
}

/** Yes or no at the terminal - or undefined when there is none, and so no one to ask. */
async function askAtTerminal(title: string, body: string): Promise<boolean | undefined> {
  if (process.stdin.isTTY !== true) return undefined;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`\n${c.bold(title)}\n${body}\n\n${c.bold("Go ahead? [y/N] ")}`);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}
