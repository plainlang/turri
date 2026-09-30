import { resolve } from "node:path";
import { configForSpec, modelSpec, projectModels, readProjectConfig } from "./config.ts";
import { PACKAGE_ROOT } from "./environment.ts";
import { c } from "./module-report.ts";
import { tryItCommand } from "./render/delivery.ts";
import { describeDiagnosis, diagnoseFailure } from "./render/diagnose.ts";
import { createJobRegistry, type Job } from "./render/jobs.ts";
import { createWorkLoop, describeModules, type ModuleStatus, type WorkLoop } from "./render/loop.ts";
import { projectDirOf } from "./render/paths.ts";
import { renderSpecDiff } from "./render/spec-change.ts";

/**
 * What every command that builds - `plainwright module`, `regenerate`, `conformance`, `spec-diff` - does around its own
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
  /** The request: bring up, regenerate, conformance. */
  ask: (loop: WorkLoop) => Promise<ModuleStatus[]>;
}): Promise<never> {
  const plainFile = resolve(options.plainFile);
  const project = { ...readProjectConfig(process.cwd()), ...Object.fromEntries(Object.entries(configForSpec(plainFile)).filter(([, value]) => value !== undefined)) };
  const model = options.model ?? modelSpec(projectModels(project).coding);
  const projectDir = projectDirOf(plainFile);

  // Each job as it starts and as it ends - the transcript of each is in .plainwright/jobs/.
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
  const loop = createWorkLoop({
    registry,
    cwd: process.cwd(),
    ...(options.buildDir !== undefined ? { buildDir: resolve(options.buildDir) } : {}),
    ...(model !== undefined ? { modelFor: () => model } : {}),
    ...(planner !== undefined ? { plannerModel: planner } : {}),
    ...(options.dryRun === true ? { dryRun: true } : {}),
  });
  const planned = await options.ask(loop);
  console.log(describeModules(planned));

  if (options.dryRun === true) {
    for (const first of loop.firsts()) {
      console.log(`\n${c.bold(`${first.module}: ${first.planned.title}`)}${first.planned.track === "conformance" ? c.dim(" (conformance)") : ""}`);
      if (first.planned.track === "conformance") {
        console.log(c.dim("A conformance job's prompt is built from what the code it tests holds once it is built: not shown before."));
        continue;
      }
      // The coding agent's task, built as the render builds it - and all it did rolled back.
      const result = await renderSpecDiff({
        plainFile: first.plainFile,
        diff: first.planned.step.textDiff,
        applied: "already applied",
        spec: first.spec,
        cases: first.planned.cases,
        dryRun: true,
      });
      console.log(result.task ?? "(no task)");
    }
    process.exit(0);
  }

  await loop.drain();
  console.log(`\n${describeModules(loop.status())}`);
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
