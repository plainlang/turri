import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { configForSpec, modelSpec, projectModels, readProjectConfig } from "./config.ts";
import { createDeployState } from "./release-tools.ts";
import { runReleaseAgent } from "./release-agent.ts";
import { listDeployed, runningDeployed, stopDeployed } from "./grow/release.ts";

const USAGE = `usage: turri release [file.plain] [options]

Releases the module on top of the spec's requires chain, which holds the code of the ones below, and
has an agent start it here, on this machine. The module's code, as its last commit has it, always
goes in dist/<module> first. The agent looks for guidance on how this project releases it - what
--guidance says, the project's AGENTS.md - and follows it from there when there is some: an
integration its host application takes with the host's own scripts, say. When there is none, it
reads how the code in dist runs, installs what it needs, and starts what serves. Either way it asks
nothing, and stays in the foreground with the servers' output; Ctrl-C stops them.

The project's config.turri.yaml gives the defaults: module (the file when none is given) and
harness-model (the agent's model).

  --in-module <module>     the codebase to take, when modules built on this one branch
  --guidance <text>        how this project releases it: the scripts to run, in order
  --model <provider/id>    the agent's model (default: harness-model)`;

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

const PROBLEMS = "If you are having problems, use chat mode to deploy: run turri and ask to try it.";

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let model: string | undefined;
  let inModule: string | undefined;
  let guidance: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--model" || arg === "--harness-model") model = argv[++i];
    else if (arg === "--in-module") inModule = argv[++i];
    else if (arg === "--guidance") guidance = argv[++i];
    else if (arg.startsWith("-")) {
      console.error(`unknown option: ${arg}\n\n${USAGE}`);
      process.exit(1);
    } else positional.push(arg);
  }
  return { plainFile: positional[0], model, inModule, guidance };
}

/** Follow every running server's output, prefixed with its name, until Ctrl-C or they have all ended. */
function followLogs(): Promise<void> {
  const offsets = new Map<string, number>();
  return new Promise((done) => {
    const tick = () => {
      const running = runningDeployed();
      for (const item of listDeployed()) {
        let size = 0;
        try {
          size = statSync(item.log).size;
        } catch {
          continue;
        }
        const from = offsets.get(item.log) ?? 0;
        if (size <= from) continue;
        const buffer = Buffer.alloc(size - from);
        const fd = openSync(item.log, "r");
        readSync(fd, buffer, 0, buffer.length, from);
        closeSync(fd);
        offsets.set(item.log, size);
        for (const line of buffer.toString("utf8").split("\n").filter((l) => l !== "")) console.log(`${c.cyan(`[${item.name}]`)} ${line}`);
      }
      if (running.length === 0) {
        clearInterval(timer);
        console.log(c.dim("Everything it started has ended."));
        done();
      }
    };
    const timer = setInterval(tick, 500);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const named = args.plainFile ?? readProjectConfig(process.cwd()).module;
  if (named === undefined) {
    console.error(`${USAGE}\n\nNo file given, and config.turri.yaml names no module.`);
    process.exit(1);
  }
  const plainFile = resolve(named);
  // A release follows steps - a script, a start command: the coding model does that well, thinking low.
  const model = args.model ?? modelSpec(projectModels(configForSpec(plainFile)).coding);

  const state = createDeployState();
  const stopAll = async () => {
    const stopped = await stopDeployed();
    if (stopped.length > 0) console.log(c.dim(`\nStopped ${stopped.join(", ")}.`));
  };
  process.on("SIGINT", () => {
    void stopAll().then(() => process.exit(0));
  });

  console.log(c.dim(`\nworking out how to start it${model !== undefined ? ` (${model})` : ""}…\n`));
  await runReleaseAgent({
    plainFile,
    cwd: process.cwd(),
    state,
    ...(model !== undefined ? { model } : {}),
    ...(args.inModule !== undefined ? { inModule: args.inModule } : {}),
    ...(args.guidance !== undefined ? { guidance: args.guidance } : {}),
    onDelta: (delta) => process.stdout.write(delta),
  });
  console.log(`\n\n${c.dim(PROBLEMS)}`);

  if (runningDeployed().length === 0) process.exit(0);
  console.log(c.green(c.bold("\nRunning - Ctrl-C stops it.")) + c.dim(" Its output follows.\n"));
  await followLogs();
  process.exit(0);
}

main().catch(async (error) => {
  await stopDeployed();
  console.error(error instanceof Error ? error.message : error);
  console.error(`\n${PROBLEMS}`);
  process.exit(1);
});
