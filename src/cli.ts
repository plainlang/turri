#!/usr/bin/env node
/**
 * One entry point, so the tools can be used from wherever the specification lives.
 *
 * Paths are resolved against the current working directory, and a .plain file's linked
 * resources are too - so the intended use is to `cd` to the module and name the file,
 * rather than to run from this repo and reach across with absolute paths.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CODING_MODEL_ENV, chatModels } from "./chat-models.ts";
import { readProjectConfig } from "./config.ts";
import { extensionInstalledGlobally, PACKAGE_ROOT, themesInstalledGlobally } from "./environment.ts";

/**
 * Start pi with this project's extension and themes already wired in.
 *
 * Saves both a global pi install and the `-e <absolute path>` that a project-local
 * extension otherwise needs before the project is trusted.
 */
/** The theme `plainwright chat` starts in. */
const DEFAULT_THEME = "forge";

function chat(args: string[]): never {
  if (!existsSync(join(PACKAGE_ROOT, "node_modules", "@earendil-works", "pi-coding-agent"))) {
    console.error(`pi is not installed in ${PACKAGE_ROOT}. Run npm install there first.`);
    process.exit(1);
  }
  // pi itself, through a launcher that leaves out pi's startup header - see pi-launch.ts.
  const launcher = join(PACKAGE_ROOT, "src", "pi-launch.ts");

  // Loading the same extension twice is an error in pi, not a no-op, so the explicit
  // -e is only for the case where it is not already installed globally.
  const extension = extensionInstalledGlobally()
    ? []
    : ["-e", join(PACKAGE_ROOT, "src", "extension.ts")];
  const themes = themesInstalledGlobally() ? [] : ["--theme", join(PACKAGE_ROOT, ".pi", "themes")];
  // plainwright's own theme, unless this run names another. For this run only: pi's settings
  // are left as they are, so a plain `pi` keeps its theme.
  const useTheme = args.some((arg) => arg === "--use-theme" || arg.startsWith("--use-theme=")) ? [] : ["--use-theme", DEFAULT_THEME];

  // The model the person talks to, and the one every render runs on - see chat-models.ts.
  const { piArgs, codingModel } = chatModels(args, readProjectConfig(process.cwd()));

  const result = spawnSync(process.execPath, [launcher, ...extension, ...themes, ...useTheme, ...piArgs], {
    stdio: "inherit",
    cwd: process.cwd(),
    env: codingModel ? { ...process.env, [CODING_MODEL_ENV]: codingModel } : process.env,
  });
  process.exit(result.status ?? 1);
}

const COMMANDS: Record<string, { module: string; blurb: string }> = {
  render: { module: "./render-frid.ts", blurb: "build one functionality (--list to see them)" },
  conformance: { module: "./conformance-frid.ts", blurb: "black-box tests for one functionality" },
  module: { module: "./render-module.ts", blurb: "build every functionality, with the regression gate" },
  regenerate: { module: "./regenerate-frid.ts", blurb: "rebuild a functionality after its spec changed" },
  check: { module: "./check-cli.ts", blurb: "validate a ***plain spec without rendering" },
  skill: { module: "./run.ts", blurb: "run a gated skill" },
};

/** Getting the machine ready, and checking it is. */
const SETUP_COMMANDS: Record<string, string> = {
  setup: "get this machine ready: check everything, and fix what can be fixed here",
  doctor: "check what plainwright needs, without changing anything",
  "vm-image": "build the sandbox VM image with every toolchain (with e2fsprogs, or in Docker)",
};

const USAGE = [
  "usage: plainwright <command> [args]",
  "",
  ...Object.entries(COMMANDS).map(([name, { blurb }]) => `  ${name.padEnd(12)} ${blurb}`),
  `  ${"chat".padEnd(12)} open pi here, with these tools and themes loaded (theme forge; --use-theme picks another)`,
  `  ${"".padEnd(12)} --harness-model <m>  the model you chat with   --coding-model <m>  the model renders run on`,
  "",
  ...Object.entries(SETUP_COMMANDS).map(([name, blurb]) => `  ${name.padEnd(12)} ${blurb}`),
  "",
  "Run `plainwright <command> --help` for that command's options.",
  "",
  "Paths are relative to the current directory. Run plainwright from the directory holding the",
  "specification, so that linked resources inside it resolve the way the parser expects.",
].join("\n");

const [command, ...rest] = process.argv.slice(2);

if (command === undefined || command === "-h" || command === "--help") {
  console.log(USAGE);
  process.exit(command === undefined ? 1 : 0);
}

if (command === "chat") chat(rest);

if (command in SETUP_COMMANDS) {
  const { main } = await import("./setup.ts");
  process.exit(await main(command as "setup" | "doctor" | "vm-image", rest));
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
];
await import(entry.module);
