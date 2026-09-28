import { readFileSync } from "node:fs";
import { modelSpec, projectModels, configForSpec } from "./config.ts";
import { projectDirOf } from "./render/paths.ts";
import { describeSpecDiff, renderSpecDiff } from "./render/spec-change.ts";
import { withActivity, type ActivitySink } from "./render/activity.ts";

const USAGE = `usage: plainwright spec-diff <file.plain> <diff-file> [options]

Renders a change to the specs, given as a git diff of the .plain files, into the codebase: the
headless counterpart of render_spec_diff. The diff is applied first, unless it is already in.

  --no-conformance         render the change on its unit tests only; bring the conformance
                           tests in line afterwards (plainwright conformance, or the chat)
  --in <module>            the codebase to render in, when modules built on this one branch
  --model <provider/id>    model for the agents (default: config.yaml's coding-model)`;

function parseArgs(argv: string[]) {
  let plainFile: string | undefined;
  let diffFile: string | undefined;
  let model: string | undefined;
  let inModule: string | undefined;
  let conformance: boolean | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--model") model = argv[++i];
    else if (arg === "--in") inModule = argv[++i];
    else if (arg === "--no-conformance") conformance = false;
    else if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg.startsWith("-")) {
      console.error(`unknown option: ${arg}\n\n${USAGE}`);
      process.exit(1);
    } else if (plainFile === undefined) plainFile = arg;
    else if (diffFile === undefined) diffFile = arg;
  }
  return { plainFile, diffFile, model, inModule, conformance };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.plainFile === undefined || args.diffFile === undefined) {
    console.error(USAGE);
    process.exit(1);
  }
  const plainFile = args.plainFile;
  const diff = readFileSync(args.diffFile, "utf8");

  // As the conformance command shows it: each stage, with the time and the cost so far.
  const started = Date.now();
  let cost = 0;
  const elapsed = () => {
    const seconds = Math.round((Date.now() - started) / 1000);
    return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
  };
  const sink: ActivitySink = {
    stage: (label) => console.log(`\x1b[2m[${elapsed()} · $${cost.toFixed(2)}]\x1b[0m ${label}`),
    activity() {},
    now() {},
    usage: (usage) => void (cost += usage.cost),
    transcript() {},
  };

  const result = await withActivity(sink, () =>
    renderSpecDiff({
      plainFile,
      diff,
      inModule: args.inModule,
      // Off when asked, or when the spec's config turns it off.
      conformance: args.conformance ?? (configForSpec(plainFile).conformanceTests === false ? false : undefined),
      tryIt: false,
      model: args.model ?? modelSpec(projectModels(configForSpec(plainFile)).coding),
    }),
  );
  console.log(`\n${describeSpecDiff(result)}`);
  console.log(`\n${result.passed ? "spec diff rendered" : "spec diff NOT rendered"} · ${elapsed()} · $${cost.toFixed(2)}`);
  process.exit(result.passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
