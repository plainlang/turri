import { listFrids, renderFunctionality } from "./render/render.ts";
import { describeStop } from "./render/stop-report.ts";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

const USAGE = `usage: npm run render -- <file.plain> [frid] [options]

  --build-dir <dir>      where the agent works (default: plain_modules/<module>/code)
  --template-dir <dir>   extra template directory (repeatable)
  --list                 list the functionality IDs and exit
  --dry-run              print the prompt without starting an agent
  --model <provider/id>  model for the agent, e.g. google/gemini-2.5-pro
  --no-try-it            skip working out how to try it once it is built

  PLAIN_TEMPLATE_DIRS    colon-separated template directories (e.g. the standard library)`;

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const templateDirs: string[] = [];
  let buildDir: string | undefined;
  let list = false;
  let dryRun = false;
  let tryIt = true;
  let model: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--build-dir") buildDir = argv[++i];
    else if (arg === "--template-dir") templateDirs.push(argv[++i]!);
    else if (arg === "--list") list = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--model") model = argv[++i];
    else if (arg === "--no-try-it") tryIt = false;
    else if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg.startsWith("-")) {
      console.error(`unknown option: ${arg}\n\n${USAGE}`);
      process.exit(1);
    } else positional.push(arg);
  }

  return { plainFile: positional[0], frid: positional[1], templateDirs, buildDir, list, dryRun, model, tryIt };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.plainFile) {
    console.error(USAGE);
    process.exit(1);
  }

  if (args.list) {
    const { moduleName, frids } = listFrids(args.plainFile, args.templateDirs);
    console.log(c.bold(moduleName));
    for (const frid of frids) console.log(`  ${frid}`);
    return;
  }

  const result = await renderFunctionality({
    plainFile: args.plainFile,
    frid: args.frid,
    templateDirs: args.templateDirs,
    buildDir: args.buildDir,
    dryRun: args.dryRun,
    model: args.model,
    tryIt: args.tryIt,
    onDelta: (delta) => process.stdout.write(delta),
    onRun: (command, exitCode) =>
      console.log(
        `\n${exitCode === 0 ? c.green("pass") : c.red(`exit ${exitCode}`)} ${c.dim(command)}`,
      ),
  });

  if (args.dryRun) {
    console.log(result.prompt);
    return;
  }

  const headline = result.passed
    ? c.green(c.bold("unit tests pass"))
    : c.red(c.bold(result.runs.length === 0 ? "tests were never run" : "unit tests not passing"));
  console.log(`\n\n${headline} ${c.dim(`${result.moduleName} functionality ${result.frid}`)}`);
  console.log(c.dim(`  build dir: ${result.buildDir}`));
  for (const file of result.files) console.log(c.dim(`    ${file}`));
  console.log(c.dim(`  test runs: ${result.runs.length}`));

  if (result.testRemovals.length > 0) {
    console.log(`\n${c.yellow(c.bold("tests were removed during this run"))}`);
    for (const removal of result.testRemovals) {
      console.log(
        c.dim(
          removal.deleted
            ? `    ${removal.file} deleted (~${removal.before} tests)`
            : `    ${removal.file} ~${removal.before} -> ~${removal.after} tests`,
        ),
      );
    }
    console.log(c.dim("  the agent was challenged on each; its justification is in the report above"));
  }

  if (!result.passed) {
    console.log(`\n${describeStop({ moduleName: result.moduleName, frid: result.frid, at: "unit tests", runs: result.runs, attempts: result.attempts })}`);
  }

  process.exit(result.passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
