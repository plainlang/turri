import { parseArgs, runLoop } from "./loop-cli.ts";

const USAGE = `usage: plainwright conformance <file.plain> [frid ...] [options]

Writes and runs the black-box conformance tests of a module's functional specs - those named, or
every one - on the code as it is built, as the chat's render_conformance does, whatever the config's
conformance-tests says: from the spec's test reqs and acceptance tests, with the whole suite the
module inherits, a failure fixed in the test or the code, whichever is wrong.

  --model <provider/id>    model for the agents (default: config.yaml's coding-model)`;

const { positional, options } = parseArgs(process.argv.slice(2), [], USAGE);
const [plainFile, ...frids] = positional;
if (plainFile === undefined) {
  console.error(USAGE);
  process.exit(1);
}
runLoop({
  plainFile,
  ...(options.model !== undefined ? { model: options.model } : {}),
  ask: (loop) => loop.conformance(plainFile, { ...(frids.length > 0 ? { frids } : {}), ...(options.model !== undefined ? { model: options.model } : {}) }),
}).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
