import { checkPlainTargets, formatCheckResults } from "./plain/check.ts";

const USAGE = `usage: plainwright check <file.plain | directory> [options]

Validates a ***plain specification statically: parses it, resolves its imports and
required modules, and reports every error without rendering anything.

  --template-dir <dir>   extra template directory (repeatable)
  --json                 machine-readable output

  PLAIN_TEMPLATE_DIRS    colon-separated template directories`;

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

const argv = process.argv.slice(2);
const templateDirs: string[] = [];
const positional: string[] = [];
let json = false;

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]!;
  if (arg === "--template-dir") templateDirs.push(argv[++i]!);
  else if (arg === "--json") json = true;
  else if (arg === "-h" || arg === "--help") {
    console.log(USAGE);
    process.exit(0);
  } else positional.push(arg);
}

const target = positional[0] ?? ".";
const results = checkPlainTargets(target, templateDirs);

if (results.length === 0) {
  console.error(`No .plain files found in ${target}.`);
  process.exit(1);
}

if (json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const output = formatCheckResults(results)
    .split("\n")
    .map((line) =>
      line.startsWith("PASS") ? c.green(line) : line.startsWith("FAIL") ? c.red(line) : c.dim(line),
    )
    .join("\n");
  console.log(output);

  const failed = results.filter((r) => !r.ok).length;
  console.log(
    `\n${failed === 0 ? c.green(c.bold("all specs valid")) : c.red(c.bold(`${failed} of ${results.length} failed`))}`,
  );
}

process.exit(results.every((r) => r.ok) ? 0 : 1);
