#!/usr/bin/env node
/**
 * One entry point, so the tools can be used from wherever the specification lives.
 *
 * Paths are resolved against the current working directory, and a .plain file's linked
 * resources are too - so the intended use is to `cd` to the module and name the file,
 * rather than to run from this repo and reach across with absolute paths.
 */

// First: the names turri had before are carried over before anything reads them.
import "./legacy.ts";
// A project built under the old names is brought over the first time it is found.
import "./grow/migrate.ts";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
/** The theme `turri chat` starts in. */
const DEFAULT_THEME = "turri-dark";

/** A --use-theme value with the themes' old names - forge, forge-light - as they are called now. */
function renamedThemes(value: string): string {
  return value.replace(/\bforge-light\b/g, "turri-light").replace(/\bforge\b(?!-)/g, "turri-dark");
}

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
  // turri's own theme, unless this run names another. For this run only: pi's settings
  // are left as they are, so a plain `pi` keeps its theme.
  const useTheme = args.some((arg) => arg === "--use-theme" || arg.startsWith("--use-theme=")) ? [] : ["--use-theme", DEFAULT_THEME];
  // The themes were called forge and forge-light: a --use-theme naming them gets the ones they are now.
  args = args.map((arg, index) => (index > 0 && args[index - 1] === "--use-theme") || arg.startsWith("--use-theme=") ? renamedThemes(arg) : arg);

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
  regrow: { module: "./regrow-cli.ts", blurb: "regrow a module and its chain from the spec as it is (with frids: grow those again)" },
  glimpse: { module: "./regrow-cli.ts", blurb: "plan the work and print the first job's prompt, starting nothing", args: ["--dry-run"] },
  drift: { module: "./drift-cli.ts", blurb: "what is left to grow: how far the code has drifted from its spec" },
  bind: { module: "./bind-cli.ts", blurb: "write and run a module's conformance tests" },
  "spec-diff": { module: "./spec-diff-cli.ts", blurb: "apply a change to the specs, given as a git diff, and regrow it" },
  validate: { module: "./validate-cli.ts", blurb: "validate a ***plain spec, growing nothing" },
  lineage: { module: "./lineage-cli.ts", blurb: "a module's lineage: what grew into it, and when" },
  release: { module: "./release-cli.ts", blurb: "release what is grown to dist/<module> and activate it on this machine" },
  cultivate: { module: "./cultivate-cli.ts", blurb: "run a gated skill" },
};

/** The names the commands had before: still taken, not listed. */
const ALIASES: Record<string, string> = {
  module: "regrow",
  regenerate: "regrow",
  conformance: "bind",
  check: "validate",
  deploy: "release",
  skill: "cultivate",
};

/** Getting the machine ready, and checking it is. */
const SETUP_COMMANDS: Record<string, string> = {
  setup: "get this machine ready: check everything, and fix what can be fixed here",
  doctor: "check what turri needs, without changing anything",
  "vm-image": "build the sandbox VM image with every toolchain (with e2fsprogs, or in Docker)",
};

const USAGE = [
  "usage: turri <command> [args]",
  "",
  ...Object.entries(COMMANDS).map(([name, { blurb }]) => `  ${name.padEnd(12)} ${blurb}`),
  `  ${"chat".padEnd(12)} open pi here, with these tools and themes loaded (theme turri-dark; --use-theme picks another)`,
  `  ${"".padEnd(12)} --harness-model <m>  the model you chat with   --coding-model <m>  the model renders run on`,
  "",
  ...Object.entries(SETUP_COMMANDS).map(([name, blurb]) => `  ${name.padEnd(12)} ${blurb}`),
  "",
  "Run `turri <command> --help` for that command's options.",
  "",
  "Paths are relative to the current directory. Run turri from the directory holding the",
  "specification, so that linked resources inside it resolve the way the parser expects.",
].join("\n");

dropNoise();
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

if (command === "render") {
  console.error("turri render is gone: turri regrow <file.plain> grows what is left of the spec, and turri regrow <file.plain> <frid> grows one functionality again.");
  process.exit(1);
}
const entry = COMMANDS[ALIASES[command] ?? command];
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

// A headless run is stopped by a signal - SIGTERM, SIGHUP, Ctrl-C - whatever else listens for it:
// its VMs shut, and it exits. Left to the libraries' own handlers, one ran on for minutes after it
// was told to stop, building in the same codebase as the run that came after it.
if (!["validate", "check", "drift", "lineage"].includes(command)) {
  const { closeAllVms } = await import("./grow/vm.ts");
  let stopping = false;
  for (const [signal, code] of [["SIGTERM", 143], ["SIGHUP", 129], ["SIGINT", 130]] as const) {
    process.on(signal, () => {
      if (stopping) process.exit(code);
      stopping = true;
      console.error(`\nstopped (${signal}) - shutting the VMs down`);
      const done = () => process.exit(code);
      setTimeout(done, 5000).unref();
      void closeAllVms().then(done, done);
    });
  }
}
await import(entry.module);
