import { renderConformanceTests } from "./render/conformance.ts";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

const USAGE = `usage: npm run conformance -- <file.plain> [frid] [options]

Writes black-box conformance tests for a functionality that has already been rendered.

  --build-dir <dir>        the rendered code under test (default: build/<module>)
  --conformance-dir <dir>  where the tests are written (default: conformance/<module>)
  --template-dir <dir>     extra template directory (repeatable)
  --dry-run                print the prompt without starting an agent
  --model <provider/id>    model for the agents, e.g. google/gemini-2.5-pro

  PLAIN_TEMPLATE_DIRS      colon-separated template directories`;

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const templateDirs: string[] = [];
  let buildDir: string | undefined;
  let conformanceDir: string | undefined;
  let dryRun = false;
  let model: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--build-dir") buildDir = argv[++i];
    else if (arg === "--conformance-dir") conformanceDir = argv[++i];
    else if (arg === "--template-dir") templateDirs.push(argv[++i]!);
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--model") model = argv[++i];
    else if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg.startsWith("-")) {
      console.error(`unknown option: ${arg}\n\n${USAGE}`);
      process.exit(1);
    } else positional.push(arg);
  }

  return { plainFile: positional[0], frid: positional[1], templateDirs, buildDir, conformanceDir, dryRun, model };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.plainFile) {
    console.error(USAGE);
    process.exit(1);
  }

  const result = await renderConformanceTests({
    plainFile: args.plainFile,
    frid: args.frid,
    templateDirs: args.templateDirs,
    buildDir: args.buildDir,
    conformanceDir: args.conformanceDir,
    dryRun: args.dryRun,
    model: args.model,
    onDelta: (delta) => process.stdout.write(delta),
    onRun: (command, exitCode) =>
      console.log(
        `\n${exitCode === 0 ? c.green("pass") : c.red(`exit ${exitCode}`)} ${c.dim(command)}`,
      ),
    onTriage: (verdict) =>
      console.log(
        `\n${c.yellow(c.bold(verdict.fault))} ${c.dim(verdict.reasoning.split("\n")[0] ?? "")}`,
      ),
  });

  if (args.dryRun) {
    console.log(result.prompt);
    return;
  }

  const passed = result.passed;
  console.log(
    `\n\n${passed ? c.green(c.bold("conformance tests pass")) : c.red(c.bold("conformance tests not passing"))} ` +
      c.dim(`${result.moduleName} functionality ${result.frid}`),
  );
  console.log(c.dim(`  tests in:  ${result.conformanceDir}`));
  for (const file of result.files) console.log(c.dim(`    ${file}`));
  console.log(c.dim(`  against:   ${result.buildDir}`));
  console.log(c.dim(`  runs:      ${result.runs.length}`));

  if (result.triage.length > 0) {
    console.log(c.dim(`  triage:    ${result.triage.map((v) => v.fault).join(", ")}`));
  }
  if (result.codeFixes.length > 0) {
    console.log(c.dim(`  code fixes: ${result.codeFixes.length} (the implementation was changed)`));
  }
  if (result.testRemovals.length > 0) {
    console.log(`\n${c.yellow(c.bold("conformance tests were removed during this run"))}`);
    for (const removal of result.testRemovals) {
      console.log(
        c.dim(
          removal.deleted
            ? `    ${removal.file} deleted (~${removal.before} tests)`
            : `    ${removal.file} ~${removal.before} -> ~${removal.after} tests`,
        ),
      );
    }
  }

  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
