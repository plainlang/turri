import { parseArgs, runLoop } from "./loop-cli.ts";

const USAGE = `usage: plainwright regenerate <file.plain> <frid> [options]

Builds one functionality again, changed or not: it is taken out of what the code is recorded as built
from, and the module is brought up to its spec - as the chat's regenerate_functionality does. A
functionality whose spec changed needs none of this: plainwright module builds it again by itself.

  --model <provider/id>    model for the agents (default: config.yaml's coding-model)`;

const { positional, options } = parseArgs(process.argv.slice(2), [], USAGE);
const [plainFile, frid] = positional;
if (plainFile === undefined || frid === undefined) {
  console.error(USAGE);
  process.exit(1);
}
runLoop({
  plainFile,
  ...(options.model !== undefined ? { model: options.model } : {}),
  ask: (loop) => loop.regenerate(plainFile, frid, options.model !== undefined ? { model: options.model } : {}),
}).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
