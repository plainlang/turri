import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkPlainFile } from "./plain/check.ts";
import { applySpecDiff, revertSpecDiff } from "./grow/regenerate.ts";
import { parseArgs, runLoop } from "./loop-cli.ts";

const USAGE = `usage: turri spec-diff <file.plain> <diff-file> [options]

Applies a change to the specs, given as a git diff of the .plain files, and builds it: the headless
counterpart of regenerate, given a diff. The diff is applied first, unless it is already in; then, as
turri regenerate does, what is left to build is planned into jobs and built.

  --model <provider/id>    model for the agents (default: config.turri.yaml's coding-model)
  --rejuvenate             rejuvenate, without asking, a codebase grown without a module it now requires`;

const { positional, options } = parseArgs(process.argv.slice(2), ["--rejuvenate", "--start-over"], USAGE);
const [plainFile, diffFile] = positional;
if (plainFile === undefined || diffFile === undefined) {
  console.error(USAGE);
  process.exit(1);
}
const diff = readFileSync(diffFile, "utf8");
const cwd = process.cwd();
applySpecDiff(diff, cwd);
const check = checkPlainFile(resolve(plainFile));
if (!check.ok) {
  revertSpecDiff(diff, cwd);
  console.error(`Nothing was changed: with this diff ${plainFile} no longer parses. ${check.error}`);
  process.exit(1);
}
runLoop({
  plainFile,
  ...(options.model !== undefined ? { model: options.model } : {}),
  startOver: options.rejuvenate !== undefined || options["start-over"] !== undefined,
  ask: (loop) => loop.bringUp(plainFile, options.model !== undefined ? { model: options.model } : {}),
}).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
