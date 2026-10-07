import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { configForSpec, modelSpec, projectModels, readProjectConfig } from "./config.ts";
import { createDeployState, createDeployTools, DEPLOY_TOOLS } from "./release-tools.ts";
import { hostDirOf, listDeployed, runningDeployed, shortPath, stopDeployed } from "./grow/release.ts";
import { projectDirOf } from "./grow/paths.ts";
import { ask, BEGIN, createExecutor } from "./pi.ts";

const USAGE = `usage: turri release [file.plain] [options]

Releases the module on top of the spec's requires chain, which holds the code of the ones below, and
has an agent start it here, on this machine. The module's code, as its last commit has it, always
goes in dist/<module> first. The agent looks for guidance on how this project releases it - what
--guidance says, the project's AGENTS.md - and follows it from there when there is some: an
integration its host application takes with the host's own scripts, say. When there is none, it
reads how the code in dist runs, installs what it needs, and starts what serves. Either way it asks
nothing, and stays in the foreground with the servers' output; Ctrl-C stops them.

The project's config.yaml gives the defaults: module (the file when none is given) and
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

type AnyTool = ToolDefinition<any, any, any>;

const PROBLEMS = "If you are having problems, use chat mode to deploy: run turri chat and ask to try it.";

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

/** The person's own shell, in the deployed folder: it installs and runs what the release needs. */
function hostBash(dir: string): AnyTool {
  const bash: AnyTool = createBashToolDefinition(dir);
  return {
    ...bash,
    description: `${bash.description}\n\nIt runs on the person's own machine, in ${shortPath(dir)}. Never start a server here: activate does.`,
  };
}

/** A file tool that writes, refused inside plain_modules: the built code is the spec's to change, never a release's. */
function outsideBuiltCode(tool: AnyTool, dir: string): AnyTool {
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const path = resolve(dir, String((params as { path?: unknown }).path ?? ""));
      if (relative(dir, path).split(sep).includes("plain_modules")) {
        throw new Error(`Not written: ${shortPath(path)} is built code. A release never changes it - a fix belongs in the spec.`);
      }
      return tool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

/** What the project says of itself, for the agent to find release guidance in: its AGENTS.md, where turri runs and in the host codebase - once each, whole. */
function projectNotes(dirs: string[]): string[] {
  const files = [...new Set(dirs.map((dir) => join(dir, "AGENTS.md")))].filter((file) => existsSync(file));
  return files.map((file) => {
    const text = readFileSync(file, "utf8");
    const shown = text.length > 40_000 ? `${text.slice(0, 40_000)}\n… [the rest of ${shortPath(file)} is not shown]` : text;
    return `<file path="${shortPath(file)}">\n${shown.trimEnd()}\n</file>`;
  });
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
  const tools = createDeployTools({ cwd: process.cwd(), state, defaultPlainFile: () => plainFile });
  // It decides itself whether there is guidance, and releases: from the host codebase, which holds dist too.
  const dir = hostDirOf(plainFile, process.cwd());
  const notes = projectNotes([process.cwd(), dir, projectDirOf(plainFile)]);

  const stopAll = async () => {
    const stopped = await stopDeployed();
    if (stopped.length > 0) console.log(c.dim(`\nStopped ${stopped.join(", ")}.`));
  };
  process.on("SIGINT", () => {
    void stopAll().then(() => process.exit(0));
  });

  const fileTools: AnyTool[] = [
    createReadToolDefinition(dir),
    createLsToolDefinition(dir),
    createGrepToolDefinition(dir),
    createFindToolDefinition(dir),
    // A guided release may say to change the host - a registration, an import.
    outsideBuiltCode(createEditToolDefinition(dir), dir),
    outsideBuiltCode(createWriteToolDefinition(dir), dir),
  ];
  const allTools: AnyTool[] = [...fileTools, hostBash(dir), ...tools];
  const executor = await createExecutor({
    // Its sessions are kept in the project, not in the folder it deploys.
    cwd: projectDirOf(plainFile),
    customTools: allTools,
    tools: [...fileTools.map((tool) => tool.name), "bash", ...DEPLOY_TOOLS],
    model,
    role: "release",
    system: [
      "You get software that was just built running on the person's own machine, so they can try it. They are at this terminal.",
      `Your file tools and your shell start in ${dir}. Your shell is the person's own - not a sandbox.`,
    ].join("\n"),
    task: [
      `Release ${shortPath(plainFile)} for the person to try, with the release tool, then do what it says.`,
      "",
      "First ask yourself: is there guidance for how this project releases it - what the person said below, the project's",
      "notes below, or anything else you find? If there is, call release with it as guidance, in full: the code is put in",
      "dist/<module>, and the guidance takes it on from there. If there is none, call release without guidance: the code is",
      "put in dist/<module> and started from there, as best it can be.",
      ...(args.inModule !== undefined ? ["", `Release the codebase of module ${args.inModule}: pass in_module.`] : []),
      ...(args.guidance !== undefined ? ["", "What the person said of how to release it:", args.guidance] : []),
      ...(notes.length > 0 ? ["", "The project's notes:", ...notes] : []),
      "",
      "The person is at the terminal, and reads what you say last.",
    ].join("\n"),
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
