import { readProjectConfig } from "./config.ts";
import { c, reportEvent } from "./module-report.ts";
import { regenerateFunctionality, describeRegenerationStop } from "./render/module.ts";

const USAGE = `usage: plainwright regenerate <file.plain> <frid> [options]

Rebuilds one functionality over code that already exists - after its spec changed, or as it
is - without rebuilding the ones before it. It works in the codebase the functionality now
lives in: the furthest-built module whose requires chain includes it. Then runs every
conformance test in that codebase.

To change what it does, change its spec first: the spec is what the code is built from.

  --in <module>            the codebase to rebuild in, when modules built on this one branch
  --model <provider/id>    model for the agents
  --max-regression-rounds  repair attempts per regression failure (default 20)
  --build-dir <dir>        default: plain_modules/<module>/code
  --conformance-root <dir> default: plain_modules
  --template-dir <dir>     extra template directory (repeatable)`;

/** Options that take a value. Anything else starting with -- is a mistake, and says so. */
const VALUED = new Set(["in", "model", "max-regression-rounds", "build-dir", "conformance-root"]);

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
    } else if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (!VALUED.has(name)) {
        console.error(`unknown option: ${arg}\n\n${USAGE}`);
        process.exit(1);
      }
      options[name] = argv[++i];
    } else positional.push(arg);
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
    // The project's config.yaml gives the default.
    model: options.model ?? readProjectConfig(process.cwd()).codingModel,
    inModule: options.in,
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
  if (result.codebaseOf) console.log(c.dim(`  rebuilt in ${result.codebaseOf}'s codebase`));
  const stop = describeRegenerationStop(result);
  if (stop !== undefined) console.log(`\n${stop}\n`);
  const repairs = result.regression?.repairs.length ?? 0;
  if (repairs > 0) console.log(c.dim(`  regression repairs: ${repairs}`));
  console.log(c.dim(`  build dir: ${result.buildDir}`));

  process.exit(result.passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
