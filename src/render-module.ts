import { c, reportEvent } from "./module-report.ts";
import { renderModule } from "./render/module.ts";

const USAGE = `usage: npm run module -- <file.plain> [options]

Builds every functionality in order. A functionality advances only when its unit tests
pass, its own conformance tests pass, and every earlier functionality's conformance tests
still pass alongside it.

  --from <frid>            start here, treating earlier functionalities as already built
  --to <frid>              stop after this functionality
  --build-dir <dir>        default: build/<module>
  --conformance-root <dir> default: conformance
  --template-dir <dir>     extra template directory (repeatable)
  --model <provider/id>    model for the agents
  --max-regression-rounds  repair attempts per regression failure (default 3)

  PLAIN_TEMPLATE_DIRS      colon-separated template directories`;

function parseArgs(argv: string[]) {
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

  return { positional, templateDirs, options };
}

async function main() {
  const { positional, templateDirs, options } = parseArgs(process.argv.slice(2));
  const plainFile = positional[0];
  if (!plainFile) {
    console.error(USAGE);
    process.exit(1);
  }

  const result = await renderModule({
    plainFile,
    templateDirs,
    from: options.from,
    to: options.to,
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
    `\n\n${result.passed ? c.green(c.bold("module complete")) : c.red(c.bold("module incomplete"))} ` +
      c.dim(result.moduleName),
  );
  console.log(c.dim(`  functionalities: ${result.frids.join(", ")}`));
  console.log(c.dim(`  completed:       ${result.completed.join(", ") || "none"}`));
  console.log(c.dim(`  build dir:       ${result.buildDir}`));
  console.log(c.dim(`  tests:           ${result.conformanceRoot}/${result.moduleName}/<frid>`));

  for (const outcome of result.outcomes) {
    const repairs = outcome.regression?.repairs.length ?? 0;
    console.log(
      c.dim(
        `    ${outcome.frid}: ${outcome.stoppedAt ? `stopped at ${outcome.stoppedAt}` : "done"}` +
          (repairs > 0 ? `, ${repairs} regression repair${repairs === 1 ? "" : "s"}` : ""),
      ),
    );
  }

  process.exit(result.passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
