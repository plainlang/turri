import { CONFIG_FILE, readProjectConfig } from "./config.ts";
import { parseArgs } from "./cli-options.ts";
import { headlessOptions, runLoop } from "./loop-cli.ts";

const USAGE = `usage: turri regenerate [file.plain] [frid ...] [options]

Regenerates the module's code from its spec as it is now, and everything it requires, bottom first, as
the chat does: what is left to regenerate - from what each module's code was regenerated from to its
spec now - is planned into jobs, and they run one after the other until the code is regenerated from
the spec, each followed by the conformance tests of what it regenerated when they are on. Then it says
how each went. With functional specs named, those are regenerated though their spec did not change - as regenerate
does in the chat with functionalities named: their code rewritten or started over, doing what the spec says.

The project's config.turri.yaml, in the current directory, gives the defaults: module (the file to
build when none is given), coding-model (the agents that build), harness-model (the planner), and
conformance-tests. It exits 0 only when every module is complete: regenerated from the spec as it is,
its conformance tests too when they are on.

  --dry-run                plan the work and print the prompt of the first job, and run nothing (turri glimpse)
  --start-over             start over, without asking, a codebase regenerated without a module it now requires -
                           with no terminal to ask and without it, the run stops there
  --from-scratch           delete the module's code and conformance tests (its lineage keeps them) and regenerate all of it
  --harness-model <p/id>   config.turri.yaml's harness-model for this run: the planner, the conformance chooser, a diagnosis
  --coding-model <p/id>    its coding-model, --model too: the agents that build; p/id:level for how hard a model thinks
  --judge-model <p/id>     its judge-model: the judge and the test review
  --review <true|false>    its review: whether the code and its tests are reviewed once they pass
  --conformance-tests <all|chosen|module|false>
                           its conformance-tests: which conformance tests are written and run
  --build-dir <dir>        as the run ends, however it ends, export the code there: the furthest-built codebase's
                           last commit, which holds every module it requires - the folder's contents are replaced
  --report <file.json>     write a report of the run there - outcome, usage, pulses, functional specs completed -
                           as it starts, as each pulse ends and as it exits (docs/headless.md)

  PLAIN_TEMPLATE_DIRS      colon-separated template directories`;

const { positional, options } = parseArgs(process.argv.slice(2), ["--dry-run", "--start-over", "--from-scratch"], USAGE, ["--build-dir", "--report", "--conformance-tests", "--harness-model", "--judge-model", "--review"]);
const { report, buildDir } = headlessOptions(options, true);
const named = positional[0] ?? readProjectConfig(process.cwd()).module;
// Functional specs named after the file: regenerated again though their spec did not change.
const again = positional.slice(1);
if (!named) {
  console.error(`${USAGE}\n\nNo file given, and ${CONFIG_FILE} names no module.`);
  process.exit(1);
}
// A dry run starts nothing, and from scratch deletes before it plans: the two do not go together.
if (options["from-scratch"] !== undefined && options["dry-run"] !== undefined) {
  console.error("--from-scratch deletes the module's code before anything is planned: it cannot be a dry run.");
  process.exit(1);
}
runLoop({
  plainFile: named,
  ...(buildDir !== undefined ? { buildDir } : {}),
  ...(report !== undefined ? { report } : {}),
  command: ["regenerate", ...process.argv.slice(2)],
  dryRun: options["dry-run"] !== undefined,
  startOver: options["start-over"] !== undefined,
  ask: (loop) =>
    again.length > 0
      ? loop.regenerateAgain(named, again)
      : options["from-scratch"] !== undefined
        ? loop.fromScratch(named)
        : loop.bringUp(named),
}).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
