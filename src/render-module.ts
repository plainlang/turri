import { resolve } from "node:path";
import { projectDirOf } from "./render/paths.ts";
import { CONFIG_FILE, configForSpec, moduleConfigFile, modulesWithConfig, readProjectConfig, modelSpec, projectModels } from "./config.ts";
import { c } from "./module-report.ts";
import { PACKAGE_ROOT } from "./environment.ts";
import { createJobRegistry, type Job } from "./render/jobs.ts";
import { createRenderQueue, describeBroughtUp } from "./render/queue.ts";
import { tryItCommand } from "./render/delivery.ts";
import { describeDiagnosis, diagnoseFailure } from "./render/diagnose.ts";

const USAGE = `usage: plainwright module [file.plain] [options]

Builds the module and everything it requires, bottom first, as jobs in the render queue - as the
chat does: for each module, one render functionality job per functional spec not built yet, each
followed by its conformance tests when they are on, and - when what is built no longer matches the
spec - one render spec diff job first that brings it in line. The queue master reworks them like
any queued job. It runs them all to the end, then says how each went.

The project's config.yaml, in the current directory, gives the defaults: module (the file to
build when none is given), coding-model, and conformance-tests (true or false).

  --only                   build just this module, ignoring what it requires
  --to <frid>              queue functionalities of this module only up to this id
  --build-dir <dir>        default: plain_modules/<module>/code
  --model <provider/id>    model for the agents

  PLAIN_TEMPLATE_DIRS      colon-separated template directories`;

/** Options of the build this replaced, and what to do instead. */
const GONE: Record<string, string> = {
  force: "to build a functionality again, use plainwright regenerate",
  from: "every functionality not built is queued; built ones are skipped",
  "conformance-root": "conformance tests are in plain_modules/<module>/tests",
  "max-regression-rounds": "each functionality's conformance job runs the whole suite so far",
  "try-it": "run plainwright deploy to try what is built",
  conformance: `set conformance-tests: in ${CONFIG_FILE}`,
  "no-conformance": `set conformance-tests: false in ${CONFIG_FILE}`,
  "template-dir": "set PLAIN_TEMPLATE_DIRS",
};

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const options: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (["--only", "--force", "--conformance", "--no-conformance", "--try-it"].includes(arg)) options[arg.slice(2)] = "yes";
    else if (arg.startsWith("--")) options[arg.slice(2)] = argv[++i];
    else positional.push(arg);
  }
  return { positional, options };
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  for (const [name, instead] of Object.entries(GONE)) {
    if (options[name] !== undefined) console.log(c.dim(`--${name} is no longer an option: ${instead}.`));
  }
  const config = readProjectConfig(process.cwd());
  const named = positional[0] ?? config.module;
  if (!named) {
    const stacks = modulesWithConfig(process.cwd());
    console.error(
      stacks.length > 0
        ? `${USAGE}\n\nNo file given, and this project has modules with configs of their own - ${stacks.map((module) => `${module} (${moduleConfigFile(module)})`).join(", ")}: name the one to build.`
        : `${USAGE}\n\nNo file given, and ${CONFIG_FILE} names no module.`,
    );
    process.exit(1);
  }
  const plainFile = resolve(named);
  const project = { ...config, ...Object.fromEntries(Object.entries(configForSpec(plainFile)).filter(([, value]) => value !== undefined)) };
  const model = options.model ?? modelSpec(projectModels(project).coding);
  const projectDir = projectDirOf(plainFile);

  // Each job as it starts and as it ends - the transcript of each is in .plainwright/jobs/.
  const seen = new Map<string, string>();
  const registry = createJobRegistry({
    // As in the chat: a job that fails is run once more; failing again, it and every job behind it fail, and why is worked out.
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
  const queue = createRenderQueue({ registry, cwd: process.cwd(), ...(options["build-dir"] !== undefined ? { buildDir: resolve(options["build-dir"]) } : {}), ...(model !== undefined ? { model } : {}) });
  const brought = queue.bringUpTo(plainFile, {
    ...(options.to !== undefined ? { to: options.to } : {}),
    ...(options.only !== undefined ? { only: true } : {}),
    ...(model !== undefined ? { model } : {}),
  });
  console.log(describeBroughtUp(brought, named));
  await queue.drain();

  const ended = registry.list();
  const failed = ended.filter((job) => job.status === "failed");
  console.log(`\n${failed.length === 0 ? c.green(c.bold("all jobs done")) : c.red(c.bold(`${failed.length} job${failed.length === 1 ? "" : "s"} failed`))}`);
  for (const job of ended) console.log(`  ${job.id} ${job.summary}: ${job.status}`);
  if (ended.some((job) => job.status === "succeeded")) console.log(`\n${tryItCommand(plainFile)}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
