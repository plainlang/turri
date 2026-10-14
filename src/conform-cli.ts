import { parseArgs } from "./cli-options.ts";
import { headlessOptions, runLoop } from "./loop-cli.ts";

const USAGE = `usage: turri conform <file.plain> [frid ...] [options]

Writes and runs the black-box conformance tests of a module's functional specs - those named, or
every one - on the code as it is built, as the chat's conform does, whatever the config's
conformance-tests says: from the spec's test reqs and acceptance tests, with the whole suite the
module inherits, a failure fixed in the test or the code, whichever is wrong. Every functional spec
tested goes in one pulse, as far as the size guardrail lets.

  --one-by-one             a pulse a functional spec instead
  --harness-model <p/id>   config.turri.yaml's harness-model for this run: the planner, the conformance chooser, a diagnosis
  --coding-model <p/id>    its coding-model, --model too: the agents that build
  --judge-model <p/id>     its judge-model: the judge and the test review
  --review <true|false>    its review: whether the code and its tests are reviewed once they pass
  --build-dir <dir>        as the run ends, export the code there (see turri regenerate --help)
  --report <file.json>     write a report of the run there (see turri regenerate --help)`;

const { positional, options } = parseArgs(process.argv.slice(2), ["--one-by-one"], USAGE, ["--build-dir", "--report", "--harness-model", "--judge-model", "--review"]);
const { report, buildDir } = headlessOptions(options, false);
const [plainFile, ...frids] = positional;
if (plainFile === undefined) {
  console.error(USAGE);
  process.exit(1);
}
runLoop({
  plainFile,
  ...(buildDir !== undefined ? { buildDir } : {}),
  ...(report !== undefined ? { report } : {}),
  command: ["conform", ...process.argv.slice(2)],
  ask: (loop) =>
    loop.conformance(plainFile, {
      ...(frids.length > 0 ? { frids } : {}),
      ...(options["one-by-one"] !== undefined ? { separately: true } : {}),
    }),
}).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
