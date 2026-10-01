import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkPlainFile } from "./plain/check.ts";
import { applySpecDiff, revertSpecDiff } from "./render/spec-change.ts";
import { parseArgs, runLoop } from "./loop-cli.ts";

const USAGE = `usage: plainwright spec-diff <file.plain> <diff-file> [options]

Applies a change to the specs, given as a git diff of the .plain files, and builds it: the headless
counterpart of render_spec_diff. The diff is applied first, unless it is already in; then, as
plainwright module does, what is left to build is planned into jobs and built.

  --model <provider/id>    model for the agents (default: config.yaml's coding-model)
  --start-over             start over, without asking, a codebase built without a module it now requires`;

const { positional, options } = parseArgs(process.argv.slice(2), ["--start-over"], USAGE);
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
  startOver: options["start-over"] !== undefined,
  ask: (loop) => loop.bringUp(plainFile, options.model !== undefined ? { model: options.model } : {}),
}).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
