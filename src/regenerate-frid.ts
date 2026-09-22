import { c, reportEvent } from "./module-report.ts";
import { regenerateFunctionality } from "./render/module.ts";

const USAGE = `usage: npm run regenerate -- <file.plain> <frid> [options]

Rebuilds one functionality whose specification changed, over code that already exists,
then runs the whole module's conformance suite.

  --build-dir <dir>        default: plain_modules/<module>/code
  --conformance-root <dir> default: plain_modules
  --template-dir <dir>     extra template directory (repeatable)
  --model <provider/id>    model for the agents
  --max-regression-rounds  repair attempts per regression failure (default 3)`;

async function main() {
  const argv = process.argv.slice(2);
  const positional: string[] = [];
  const templateDirs: string[] = [];
  const options: Record<string, string | undefined> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--template-dir") templateDirs.push(argv[++i]!);
    else if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg.startsWith("--")) options[arg.slice(2)] = argv[++i];
    else positional.push(arg);
  }

  const [plainFile, frid] = positional;
  if (!plainFile || !frid) {
    console.error(USAGE);
    process.exit(1);
  }

  const result = await regenerateFunctionality({
    plainFile,
    frid,
    templateDirs,
    buildDir: options["build-dir"],
    conformanceRoot: options["conformance-root"],
    model: options.model,
    maxRegressionRounds: options["max-regression-rounds"]
      ? Number(options["max-regression-rounds"])
      : undefined,
    onDelta: (delta) => process.stdout.write(delta),
    onEvent: reportEvent,
  });

  console.log(
    `\n\n${result.passed ? c.green(c.bold("regenerated")) : c.red(c.bold("regeneration incomplete"))} ` +
      c.dim(`${result.moduleName} functionality ${result.frid}`),
  );
  if (result.stoppedAt) console.log(c.dim(`  stopped at: ${result.stoppedAt}`));
  const repairs = result.regression?.repairs.length ?? 0;
  if (repairs > 0) console.log(c.dim(`  regression repairs: ${repairs}`));
  console.log(c.dim(`  build dir: ${result.buildDir}`));

  process.exit(result.passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
