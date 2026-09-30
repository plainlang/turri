import { CONFIG_FILE, moduleConfigFile, modulesWithConfig, readProjectConfig } from "./config.ts";
import { c } from "./module-report.ts";
import { parseArgs, runLoop } from "./loop-cli.ts";

const USAGE = `usage: plainwright module [file.plain] [options]

Builds the module and everything it requires, bottom first, as the chat does: what is left to build
- from what each module's code is built from to its spec as it is - is planned into jobs, and they
run one after the other until the code is built from the spec, each followed by the conformance
tests of what it built when they are on. Then it says how each went.

The project's config.yaml, in the current directory, gives the defaults: module (the file to
build when none is given), coding-model (the agents that build), harness-model (the planner), and
conformance-tests.

  --dry-run                plan the work and print the prompt of the first job, and run nothing
  --build-dir <dir>        default: plain_modules/<module>/code
  --model <provider/id>    model for the agents

  PLAIN_TEMPLATE_DIRS      colon-separated template directories`;

/** Options of the build this replaced, and what to do instead. */
const GONE: Record<string, string> = {
  force: "to build a functionality again, use plainwright regenerate",
  only: "every module the spec requires is built, bottom first",
  to: "the whole spec is built: stop the jobs to stop partway",
  from: "every functionality not built is queued; built ones are skipped",
  "conformance-root": "conformance tests are in plain_modules/<module>/tests",
  "max-regression-rounds": "each conformance job runs the whole suite",
  "try-it": "run plainwright deploy to try what is built",
  conformance: `set conformance-tests: in ${CONFIG_FILE}, or plainwright conformance`,
  "no-conformance": `set conformance-tests: false in ${CONFIG_FILE}`,
  "template-dir": "set PLAIN_TEMPLATE_DIRS",
};

const { positional, options } = parseArgs(process.argv.slice(2), ["--only", "--force", "--conformance", "--no-conformance", "--try-it", "--dry-run"], USAGE);
for (const [name, instead] of Object.entries(GONE)) {
  if (options[name] !== undefined) console.log(c.dim(`--${name} is no longer an option: ${instead}.`));
}
const named = positional[0] ?? readProjectConfig(process.cwd()).module;
if (!named) {
  const stacks = modulesWithConfig(process.cwd());
  console.error(
    stacks.length > 0
      ? `${USAGE}\n\nNo file given, and this project has modules with configs of their own - ${stacks.map((module) => `${module} (${moduleConfigFile(module)})`).join(", ")}: name the one to build.`
      : `${USAGE}\n\nNo file given, and ${CONFIG_FILE} names no module.`,
  );
  process.exit(1);
}
runLoop({
  plainFile: named,
  ...(options.model !== undefined ? { model: options.model } : {}),
  ...(options["build-dir"] !== undefined ? { buildDir: options["build-dir"] } : {}),
  dryRun: options["dry-run"] !== undefined,
  ask: (loop) => loop.bringUp(named, options.model !== undefined ? { model: options.model } : {}),
}).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
