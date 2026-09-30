import { closeSync, openSync, readSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  createBashToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { configForSpec, modelSpec, projectModels, readProjectConfig } from "./config.ts";
import { createDeployState, createDeployTools, DEPLOY_TOOLS, refuseInstall, type Approve } from "./deploy-tools.ts";
import { listDeployed, runningDeployed, shortPath, stopDeployed } from "./render/deploy.ts";
import { projectDirOf } from "./render/paths.ts";
import { ask, BEGIN, createExecutor } from "./pi.ts";

const USAGE = `usage: plainwright deploy [file.plain] [options]

Puts the module's code, as its last commit has it, in dist/<module> - the module on top of the
spec's requires chain, which holds the code of the ones below - and has an agent start it here, on
this machine: it reads how the code runs, checks the toolchains it needs, asks before it installs
anything, and starts what serves. It stays in the foreground with the servers' output; Ctrl-C stops
them. Without a terminal to ask, nothing is installed.

The project's config.yaml gives the defaults: module (the file when none is given) and
harness-model (the agent's model).

  --in-module <module>     the codebase to take, when modules built on this one branch
  --model <provider/id>    the agent's model (default: harness-model)`;

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

type AnyTool = ToolDefinition<any, any, any>;

const PROBLEMS = "If you are having problems, use chat mode to deploy: run plainwright chat and ask to try it.";

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let model: string | undefined;
  let inModule: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--model" || arg === "--harness-model") model = argv[++i];
    else if (arg === "--in-module") inModule = argv[++i];
    else if (arg.startsWith("-")) {
      console.error(`unknown option: ${arg}\n\n${USAGE}`);
      process.exit(1);
    } else positional.push(arg);
  }
  return { plainFile: positional[0], model, inModule };
}

/** Yes or no at the terminal - or undefined when there is none, and so no one to ask. */
const askAtTerminal: Approve = async (title, body) => {
  if (process.stdin.isTTY !== true) return undefined;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`\n\n${c.bold(title)}\n${body}\n\n${c.bold("Go ahead? [y/N] ")}`);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
};

/** The person's own shell, in the deployed folder - installing nothing they did not agree to. */
function hostBash(dir: string): AnyTool {
  const bash: AnyTool = createBashToolDefinition(dir);
  return {
    ...bash,
    description: `${bash.description}\n\nIt runs on the person's own machine, in ${shortPath(dir)}. Never start a server here: start_deployed does.`,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const refused = refuseInstall((params as { command: string }).command);
      if (refused !== undefined) throw new Error(refused);
      return bash.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
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
    console.error(`${USAGE}\n\nNo file given, and config.yaml names no module.`);
    process.exit(1);
  }
  const plainFile = resolve(named);
  const model = args.model ?? modelSpec(projectModels(configForSpec(plainFile)).harness);

  const state = createDeployState();
  const [deploy, ...rest] = createDeployTools({ cwd: process.cwd(), state, approve: askAtTerminal, defaultPlainFile: () => plainFile });
  // Deployed by the harness first, as the chat's deploy tool does: the agent starts from what it says.
  const exported = await deploy!.execute("deploy", { plain_file: plainFile, ...(args.inModule !== undefined ? { in_module: args.inModule } : {}) }, undefined, undefined, undefined as never);
  const deployed = (exported.content[0] as { text: string }).text;
  const dir = state.current!.dir;
  console.log(deployed.split("\n\n")[0]);

  const stopAll = async () => {
    const stopped = await stopDeployed();
    if (stopped.length > 0) console.log(c.dim(`\nStopped ${stopped.join(", ")}.`));
  };
  process.on("SIGINT", () => {
    void stopAll().then(() => process.exit(0));
  });

  const fileTools: AnyTool[] = [createReadToolDefinition(dir), createLsToolDefinition(dir), createGrepToolDefinition(dir), createFindToolDefinition(dir)];
  const tools: AnyTool[] = [...fileTools, hostBash(dir), ...rest];
  const executor = await createExecutor({
    // Its sessions are kept in the project, not in the folder it deploys.
    cwd: projectDirOf(plainFile),
    customTools: tools,
    tools: [...fileTools.map((tool) => tool.name), "bash", ...DEPLOY_TOOLS.filter((name) => name !== "deploy")],
    model,
    system: [
      "You get software that was just built running on the person's own machine, so they can try it. They are at this terminal.",
      `Your file tools and your shell start in ${dir}: the code, as it was last built. Your shell is the person's own - not a sandbox.`,
    ].join("\n"),
    task: `${deployed}\n\nThe person is at the terminal, and reads what you say last.`,
  });
  try {
    console.log(c.dim(`\nworking out how to start it${model !== undefined ? ` (${model})` : ""}…\n`));
    await ask(executor, BEGIN, (delta) => process.stdout.write(delta));
  } finally {
    executor.dispose();
  }
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
