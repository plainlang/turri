import { c, reportEvent } from "./module-report.ts";
import { renderChain } from "./render/module.ts";
import { describeChain } from "./render/requires.ts";

const USAGE = `usage: npm run module -- <file.plain> [options]

Builds the module and everything it requires, bottom first. A required module's code is
copied into the build before this module starts, so it is finished first.

Within each module, a functionality advances only when its unit tests pass, its own
conformance tests pass, and every earlier functionality's conformance tests still pass
alongside it.

  --no-conformance         skip conformance tests (they need test reqs)
  --conformance            require conformance tests, failing if there are no test reqs
  --only                   build just this module, ignoring what it requires
  --force                  rebuild modules that are already complete
  --from <frid>            start here, treating earlier functionalities as already built
  --to <frid>              stop after this functionality
  --build-dir <dir>        default: plain_modules/<module>/code
  --conformance-root <dir> default: plain_modules
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
    } else if (arg === "--only" || arg === "--force" || arg === "--conformance" || arg === "--no-conformance") {
      options[arg.slice(2)] = "yes";
    }
    else if (arg.startsWith("--")) options[arg.slice(2)] = argv[++i];
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

  const result = await renderChain({
    plainFile,
    templateDirs,
    force: options.force !== undefined,
    skipRequires: options.only !== undefined,
    conformance:
      options["no-conformance"] !== undefined ? false : options.conformance !== undefined ? true : undefined,
    onChainEvent: (event) => {
      if (event.type === "chain") {
        console.log(`\n${c.bold("build chain")}\n${describeChain(event.chain)}`);
      } else if (event.type === "module_start") {
        console.log(`\n${c.bold(c.cyan(`══ ${event.module}`))} ${c.dim(`(${event.index}/${event.total})`)}`);
      } else if (event.type === "module_skipped") {
        console.log(`\n${c.dim(`── ${event.module}: already built, skipping`)}`);
      } else if (event.type === "copied") {
        console.log(c.dim(`   copied ${event.files} files from ${event.from}`));
      } else if (event.type === "module_done") {
        console.log(event.passed ? c.green(`   ${event.module} complete`) : c.red(`   ${event.module} incomplete`));
      }
    },
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
    `\n\n${result.passed ? c.green(c.bold("chain complete")) : c.red(c.bold("chain incomplete"))}`,
  );
  for (const outcome of result.outcomes) {
    if (outcome.skipped) {
      console.log(c.dim(`  ${outcome.module}: already built`));
      continue;
    }
    const inner = outcome.result;
    const detail = inner
      ? `${inner.completed.length}/${inner.frids.length} functionalities` +
        (outcome.copied > 0 ? `, ${outcome.copied} files copied in` : "")
      : "not started";
    console.log(
      `  ${outcome.module}: ${inner?.passed ? c.green("done") : c.red("incomplete")} ${c.dim(detail)}`,
    );
  }

  process.exit(result.passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
