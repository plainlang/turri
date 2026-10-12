import { sweepOrphanedGroups } from "./grow/shell.ts";
import { createInterface } from "node:readline/promises";
import { basename, resolve } from "node:path";
import { configForSpec, modelSpec, projectModels, readProjectConfig } from "./config.ts";
import { PACKAGE_ROOT } from "./environment.ts";
import { c } from "./module-report.ts";
import { tryItCommand } from "./grow/delivery.ts";
import { describeDiagnosis, diagnoseFailure } from "./grow/diagnose.ts";
import { createJobRegistry, type Job } from "./grow/jobs.ts";
import { chooseConformance } from "./grow/choose-conformance.ts";
import type { TouchedSpec } from "./grow/drift.ts";
import { createWorkLoop, describeModules, promptOf, type ModuleStatus, type WorkLoop } from "./grow/loop.ts";
import { projectDirOf } from "./grow/paths.ts";

/**
 * What every command that builds - `turri regenerate`, `regrow`, `conformance`, `spec-diff` - does around its own
 * request of the work loop, as the chat does it: the project's models, a job that fails run once more and, failing again,
 * diagnosed, a line as each job starts and ends; then the loop run until nothing more can start, how each job ended,
 * and exit 1 when any failed. With `dryRun`, the work is planned and the prompt of the first job each codebase would
 * start printed, and nothing runs.
 */
export async function runLoop(options: {
  plainFile: string;
  model?: string;
  buildDir?: string;
  dryRun?: boolean;
  /** Start over, unasked, a codebase that has to be on a module it now requires (`--rejuvenate`). */
  startOver?: boolean;
  /** The request: bring up, regenerate, conformance. */
  ask: (loop: WorkLoop) => Promise<ModuleStatus[]>;
}): Promise<never> {
  const plainFile = resolve(options.plainFile);
  // What a turri that was killed left running - commands' process groups - stopped before anything starts.
  const orphans = sweepOrphanedGroups();
  if (orphans > 0) console.log(`Stopped ${orphans} process group${orphans === 1 ? "" : "s"} a turri that was killed left running.`);
  const project = { ...readProjectConfig(process.cwd()), ...Object.fromEntries(Object.entries(configForSpec(plainFile)).filter(([, value]) => value !== undefined)) };
  const model = options.model ?? modelSpec(projectModels(project).coding);
  const projectDir = projectDirOf(plainFile);

  // Each job as it starts and as it ends - the transcript of each is in .turri/jobs/.
  const seen = new Map<string, string>();
  const registry = createJobRegistry({
    retries: 1,
    diagnose: async (job, failures, jobLog) => {
      const diagnosis = await diagnoseFailure({ job, failures, projectDir, harnessDir: PACKAGE_ROOT, jobLog, model: modelSpec(projectModels(project).harness) ?? model });
      return diagnosis !== undefined ? describeDiagnosis(diagnosis) : undefined;
    },
    onChange: (job: Job) => {
      const line = job.status === "running" ? `${job.stage ?? "started"}` : job.status;
      if (seen.get(job.id) === line) return;
      seen.set(job.id, line);
      if (job.status === "running") console.log(`${c.cyan(`▶ ${job.id}`)} ${job.summary}${job.stage !== undefined ? c.dim(` - ${job.stage}`) : ""}`);
    },
    onFinish: (job: Job) => {
      const mark = job.status === "succeeded" ? c.green("✓") : job.status === "stopped" ? c.dim("■") : c.red("✗");
      console.log(`${mark} ${job.id} ${job.summary} - ${job.status}`);
      if (job.status !== "succeeded") console.log(c.dim((job.announce ?? job.report ?? job.error ?? "").trim()));
    },
  });
  const planner = modelSpec(projectModels(project).harness);
  // Under conformance-tests: chosen, the harness model chooses what the chat model would: as the work is planned, and as
  // each code job lands - before it ends, so the choice is scheduled before anything is built on it. A functional spec
  // it passed over is not offered again for the same text.
  const choosing: Promise<unknown>[] = [];
  const offered = new Set<string>();
  const decide = async (plainFile: string, specs: TouchedSpec[], budget?: number): Promise<string[]> => {
    const fresh = specs.filter((touched) => !offered.has(`${plainFile}\n${touched.frid}\n${touched.text}`));
    if (fresh.length === 0 || options.dryRun === true) return [];
    for (const touched of fresh) offered.add(`${plainFile}\n${touched.frid}\n${touched.text}`);
    try {
      const chosen = await chooseConformance({ plainFile, specs: fresh, ...(planner !== undefined ? { model: planner } : {}), ...(budget !== undefined ? { budget } : {}) });
      const name = basename(plainFile);
      if (chosen.frids.length === 0) console.log(`conformance for ${name}: none of fs ${fresh.map((touched) => touched.frid).join(", ")} chosen - ${chosen.why}`);
      else console.log(`conformance for ${name}: fs ${chosen.frids.join(", ")} chosen - ${chosen.why}`);
      return chosen.frids;
    } catch (error) {
      console.log(c.red(`choosing the conformance tests failed: ${error instanceof Error ? error.message : String(error)}`));
      return [];
    }
  };
  const loop = createWorkLoop({
    registry,
    cwd: process.cwd(),
    ...(options.buildDir !== undefined ? { buildDir: resolve(options.buildDir) } : {}),
    ...(model !== undefined ? { modelFor: () => model } : {}),
    ...(planner !== undefined ? { plannerModel: planner } : {}),
    ...(options.dryRun === true ? { dryRun: true } : {}),
    onChoose: decide,
  });
  let planned = await options.ask(loop);
  console.log(describeModules(planned, { for: "command line" }));
  // Chosen as the work is planned: bound as bind binds them, while the first jobs start.
  for (const status of planned) {
    if (status.toChoose === undefined) continue;
    const { plainFile: file, toChoose, chooseBudget } = status;
    if (chooseBudget === 0) continue;
    choosing.push(decide(file, toChoose, chooseBudget).then((frids) => (frids.length > 0 ? loop.conformance(file, { frids, ...(model !== undefined ? { model } : {}) }) : undefined)));
  }

  // A codebase built without a module it now requires is started over only when the person says so.
  const toStartOver = planned.filter((status) => status.startOver !== undefined);
  if (toStartOver.length > 0 && options.dryRun !== true) {
    const why = toStartOver
      .map(({ startOver }) => `${startOver!.codebases.join(", ")} was built without ${startOver!.requires.join(", ")}, which it now requires: no change to its code can bring it in.`)
      .join("\n");
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

  // Until nothing more starts: a choice made as the last job ended schedules conformance jobs of its own.
  for (;;) {
    await loop.drain();
    const pending = choosing.splice(0);
    if (pending.length === 0) break;
    await Promise.all(pending);
  }
  console.log(`\n${describeModules(loop.status(), { for: "command line" })}`);
  const ended = registry.list();
  const failed = ended.filter((job) => job.status === "failed");
  console.log(`\n${failed.length === 0 ? c.green(c.bold("all jobs done")) : c.red(c.bold(`${failed.length} job${failed.length === 1 ? "" : "s"} failed`))}`);
  for (const job of [...ended].reverse()) console.log(`  ${job.id} ${job.summary}: ${job.status}`);
  if (ended.some((job) => job.status === "succeeded")) console.log(`\n${tryItCommand(plainFile)}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

/** A command's arguments: the positional ones, and `--name value` / `--flag` options - `--coding-model` is `--model`. */
export function parseArgs(argv: string[], flags: string[], usage: string): { positional: string[]; options: Record<string, string | undefined> } {
  const positional: string[] = [];
  const options: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      console.log(usage);
      process.exit(0);
    } else if (flags.includes(arg)) options[arg.slice(2)] = "yes";
    else if (arg.startsWith("--")) options[arg === "--coding-model" ? "model" : arg.slice(2)] = argv[++i];
    else positional.push(arg);
  }
  return { positional, options };
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
