import { configForSpec, modelSpec, projectModels } from "./config.ts";
import { renderConformanceSuite } from "./render/conformance-suite.ts";
import { withActivity, type ActivitySink } from "./render/activity.ts";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

const USAGE = `usage: plainwright conformance <file.plain> [frid...] [options]

Writes black-box conformance tests for code that already exists. Rendering and conformance
are separate jobs: a codebase can be built and given its conformance suite later.

  <frid...>                one or more functionality ids. Default: the whole module
  --range <a,b>            a range of functionalities, inclusive
  --all                    every functionality of this module (the default)
  --chain                  every module this one requires, each in full
  --regression             run each module's merged suite afterwards

  --build-dir <dir>        the rendered code under test (default: plain_modules/<module>/code)
  --conformance-root <dir> where suites are written (default: plain_modules/<module>/tests)
  --template-dir <dir>     extra template directory (repeatable)
  --dry-run                print the prompt without starting an agent
  --model <provider/id>    model for the agents, e.g. google/gemini-2.5-pro
  --judge-model <provider/id>
                           model for the judge and the test review (default: judge-model
                           in config.yaml, else the agents' model)

  PLAIN_TEMPLATE_DIRS      colon-separated template directories`;

function parseArgs(argv: string[]) {
  const frids: string[] = [];
  const templateDirs: string[] = [];
  let plainFile: string | undefined;
  let range: string | undefined;
  let buildDir: string | undefined;
  let conformanceRoot: string | undefined;
  let model: string | undefined;
  let judgeModel: string | undefined;
  let all = false;
  let chain = false;
  let regression = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--build-dir") buildDir = argv[++i];
    else if (arg === "--conformance-root") conformanceRoot = argv[++i];
    else if (arg === "--template-dir") templateDirs.push(argv[++i]!);
    else if (arg === "--range") range = argv[++i];
    else if (arg === "--model") model = argv[++i];
    else if (arg === "--judge-model") judgeModel = argv[++i];
    else if (arg === "--all") all = true;
    else if (arg === "--chain") chain = true;
    else if (arg === "--regression") regression = true;
    else if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg.startsWith("-")) {
      console.error(`unknown option: ${arg}\n\n${USAGE}`);
      process.exit(1);
    } else if (plainFile === undefined) plainFile = arg;
    else frids.push(arg);
  }

  return { plainFile, frids, range, all, chain, regression, templateDirs, buildDir, conformanceRoot, model, judgeModel };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.plainFile) {
    console.error(USAGE);
    process.exit(1);
  }

  // What an unattended run shows as it goes: each stage, with the time and what the models have cost so far.
  const started = Date.now();
  let cost = 0;
  const elapsed = () => {
    const seconds = Math.round((Date.now() - started) / 1000);
    return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
  };
  const sink: ActivitySink = {
    stage: (label) => console.log(c.dim(`[${elapsed()} · $${cost.toFixed(2)}]`) + ` ${label}`),
    activity() {},
    now() {},
    usage: (usage) => void (cost += usage.cost),
    transcript() {},
  };

  const plainFile = args.plainFile;
  const result = await withActivity(sink, () => renderConformanceSuite({
    plainFile,
    frids: args.frids.length > 0 ? args.frids : undefined,
    range: args.range,
    all: args.all,
    chain: args.chain,
    regression: args.regression,
    templateDirs: args.templateDirs,
    buildDir: args.buildDir,
    conformanceRoot: args.conformanceRoot,
    // The project's config.yaml gives the default.
    model: args.model ?? modelSpec(projectModels(configForSpec(plainFile)).coding),
    judgeModel: args.judgeModel,
    onDelta: (delta) => process.stdout.write(delta),
    onEvent: (event) => {
      if (event.type === "targets") {
        const total = event.targets.reduce((n, t) => n + t.frids.length, 0);
        console.log(`\n${c.bold("conformance targets")} ${c.dim(`(${total})`)}`);
        for (const target of event.targets) {
          console.log(c.dim(`  ${target.moduleName}: ${target.frids.join(", ")}`));
        }
      } else if (event.type === "start") {
        console.log(
          `\n${c.bold(`> ${event.module} functionality ${event.frid}`)} ${c.dim(`(${event.index}/${event.total})`)}`,
        );
      } else if (event.type === "done") {
        console.log(event.passed ? c.green("  pass") : c.red("  fail"));
      }
    },
  }));

  const written = result.outcomes.length;
  const failed = result.outcomes.filter((o) => o.result && !o.result.passed).length;

  console.log(
    `\n\n${result.passed ? c.green(c.bold("conformance suite passes")) : c.red(c.bold("conformance suite not passing"))}`,
  );
  console.log(c.dim(`  written: ${written}, failing: ${failed} · ${elapsed()} · $${cost.toFixed(2)}`));
  for (const [moduleName, regression] of Object.entries(result.regression)) {
    console.log(c.dim(`  regression ${moduleName}: ${regression.passed ? "pass" : "fail"}`));
  }

  process.exit(result.passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
