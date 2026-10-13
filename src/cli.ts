#!/usr/bin/env node
/**
 * One entry point, so the tools can be used from wherever the specification lives.
 *
 * Paths are resolved against the current working directory, and a .plain file's linked
 * resources are too - so the intended use is to `cd` to the module and name the file,
 * rather than to run from this repo and reach across with absolute paths.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODING_MODEL_ENV, chatModels } from "./chat-models.ts";
import { readProjectConfig } from "./config.ts";
import { extensionInstalledGlobally, PACKAGE_ROOT, themesInstalledGlobally } from "./environment.ts";
import { dropNoise } from "./quiet.ts";

/**
 * Start pi with this project's extension and themes already wired in.
 *
 * Saves both a global pi install and the `-e <absolute path>` that a project-local
 * extension otherwise needs before the project is trusted.
 */
/**
 * Where this file is, and how its siblings are named: the sources in a clone (`src/*.ts`), the compiled files in an
 * installed package (`dist/*.js`).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const OWN_EXTENSION = import.meta.url.endsWith(".ts") ? ".ts" : ".js";

/** Whether pi is installed where Node finds it - beside turri, or wherever npm hoisted it. */
function piInstalled(): boolean {
  try {
    import.meta.resolve("@earendil-works/pi-coding-agent");
    return true;
  } catch {
    return false;
  }
}

/** The theme `turri` starts in. */
const DEFAULT_THEME = "turri-dark";

function chat(args: string[]): never {
  if (!piInstalled()) {
    console.error(`pi is not installed beside turri (${PACKAGE_ROOT}). Run npm install there, or install turri again.`);
    process.exit(1);
  }
  // pi itself, through a launcher that leaves out pi's startup header - see pi-launch.ts.
  const launcher = join(HERE, `pi-launch${OWN_EXTENSION}`);

  // Loading the same extension twice is an error in pi, not a no-op, so the explicit -e is left out while an older
  // turri's file still loads turri into every pi - turri doctor offers to remove it.
  const extension = extensionInstalledGlobally()
    ? []
    : ["-e", join(HERE, `extension${OWN_EXTENSION}`)];
  const themes = themesInstalledGlobally() ? [] : ["--theme", join(PACKAGE_ROOT, ".pi", "themes")];
  // turri's own theme, unless this run names another. For this run only: pi's settings
  // are left as they are, so a plain `pi` keeps its theme.
  const useTheme = args.some((arg) => arg === "--use-theme" || arg.startsWith("--use-theme=")) ? [] : ["--use-theme", DEFAULT_THEME];

  // The model the person talks to, and the one every render runs on - see chat-models.ts.
  const { piArgs, codingModel } = chatModels(args, readProjectConfig(process.cwd()));

  // Fullscreen: pi owns the viewport, so the conversation stays where it is scrolled to while the
  // jobs redraw - in the terminal's own scrollback, every redraw pulls it back to the bottom.
  const tuiMode = args.some((arg) => arg === "--tui-mode" || arg.startsWith("--tui-mode=")) ? [] : ["--tui-mode", "fullscreen"];

  const result = spawnSync(process.execPath, [launcher, ...extension, ...themes, ...useTheme, ...tuiMode, ...piArgs], {
    stdio: "inherit",
    cwd: process.cwd(),
    env: codingModel ? { ...process.env, [CODING_MODEL_ENV]: codingModel } : process.env,
  });
  process.exit(result.status ?? 1);
}

const COMMANDS: Record<string, { module: string; blurb: string; args?: string[] }> = {
  regenerate: { module: "./regenerate-cli.ts", blurb: "regenerate a module and its chain from the spec as it is (with frids: regenerate those again)" },
  glimpse: { module: "./regenerate-cli.ts", blurb: "plan the work and print the first job's prompt, starting nothing", args: ["--dry-run"] },
  drift: { module: "./drift-cli.ts", blurb: "what is left to regenerate: how far the code has drifted from its spec" },
  conform: { module: "./conform-cli.ts", blurb: "write and run a module's conformance tests" },
  "spec-diff": { module: "./spec-diff-cli.ts", blurb: "apply a change to the specs, given as a git diff, and regenerate it" },
  validate: { module: "./validate-cli.ts", blurb: "validate a ***plain spec, regenerating nothing" },
  lineage: { module: "./lineage-cli.ts", blurb: "a module's lineage: what was regenerated into it, and when" },
  release: { module: "./release-cli.ts", blurb: "release what is regenerated to dist/<module> and activate it on this machine" },
  cultivate: { module: "./cultivate-cli.ts", blurb: "run a gated skill" },
};

/** Getting the machine ready, and checking it is. */
const SETUP_COMMANDS: Record<string, string> = {
  "init-config": "write a quick start config.turri.yaml here, from the vendor you use: a strong model to talk to, a smaller one to write the code",
  doctor: "check what turri needs - in a project, what it needs of this machine, and that its models answer",
};

const USAGE = [
  "usage: turri [options]          open the conversation here: pi, with turri's tools and themes loaded",
  "       turri <command> [args]",
  "",
  `  ${"options".padEnd(12)} --harness-model <m>  the model you chat with   --coding-model <m>  the model renders run on`,
  `  ${"".padEnd(12)} --stack <name>  build with config.turri.<name>.yaml over config.turri.yaml - here and in every command`,
  `  ${"".padEnd(12)} --use-theme <t>  another theme than turri-dark - and every option of pi's own`,
  "",
  ...Object.entries(COMMANDS).map(([name, { blurb }]) => `  ${name.padEnd(12)} ${blurb}`),
  "",
  ...Object.entries(SETUP_COMMANDS).map(([name, blurb]) => `  ${name.padEnd(12)} ${blurb}`),
  "",
  "Run `turri <command> --help` for that command's options.",
  "",
  "Paths are relative to the current directory. Run turri from the directory holding the",
  "specification, so that linked resources inside it resolve the way the parser expects.",
].join("\n");

dropNoise();
// --stack <name>, for any command and for the conversation: the stack everything is built with (stacks.ts), taken out
// before the rest is read - a command never sees it.
const argv = await withoutStack(process.argv.slice(2));
const [command, ...rest] = argv;

async function withoutStack(args: string[]): Promise<string[]> {
  const kept: string[] = [];
  let stack: string | undefined;
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    if (arg === "--stack") stack = args[++at] ?? "";
    else if (arg.startsWith("--stack=")) stack = arg.slice("--stack=".length);
    else kept.push(arg);
  }
  if (stack === undefined) return kept;
  const { switchStack } = await import("./stacks.ts");
  try {
    switchStack(process.cwd(), stack);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  return kept;
}

if (command === "-h" || command === "--help") {
  console.log(USAGE);
  process.exit(0);
}

// turri alone is the conversation, and so is turri with pi's options - `turri -c`, `turri --harness-model <m>`. A word
// turri does not know is an error below, not a conversation started on it.
if (command === undefined || command.startsWith("-")) chat(argv);

if (command === "init-config") {
  const { main } = await import("./init-config.ts");
  process.exit(await main(rest));
}

if (command === "doctor") {
  const { main } = await import("./setup.ts");
  process.exit(await main(rest));
}

const entry = COMMANDS[command];
if (entry === undefined) {
  console.error(`unknown command: ${command}\n\n${USAGE}`);
  process.exit(1);
}

// The subcommands parse process.argv themselves, so present it as if they were invoked
// directly. Their agents are the coding agents: --coding-model is their --model.
process.argv = [
  process.argv[0]!,
  process.argv[1]!,
  ...rest.flatMap((arg) =>
    arg === "--coding-model" ? ["--model"] : arg.startsWith("--coding-model=") ? ["--model", arg.slice("--coding-model=".length)] : [arg],
  ),
  ...(entry.args ?? []),
];

// A headless run is stopped by a signal - SIGTERM, SIGHUP, Ctrl-C - whatever else listens for it: it exits, and what
// its agents left running goes with it (shell.ts kills every process group on exit). Left to the libraries' own
// handlers, one ran on for minutes after it was told to stop, building in the same codebase as the run after it.
if (!["validate", "check", "drift", "lineage"].includes(command)) {
  for (const [signal, code] of [["SIGTERM", 143], ["SIGHUP", 129], ["SIGINT", 130]] as const) {
    process.on(signal, () => {
      console.error(`\nstopped (${signal})`);
      process.exit(code);
    });
  }
}
await import(entry.module);
