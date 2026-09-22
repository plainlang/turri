#!/usr/bin/env node
/**
 * One entry point, so the tools can be used from wherever the specification lives.
 *
 * Paths are resolved against the current working directory, and a .plain file's linked
 * resources are too - so the intended use is to `cd` to the module and name the file,
 * rather than to run from this repo and reach across with absolute paths.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Start pi with this project's extension and themes already wired in.
 *
 * Saves both a global pi install and the `-e <absolute path>` that a project-local
 * extension otherwise needs before the project is trusted.
 */
const AGENT_DIR = join(homedir(), ".pi", "agent");

/** Is a globally installed extension already pulling these tools in? */
function extensionInstalledGlobally(): boolean {
  const dir = join(AGENT_DIR, "extensions");
  try {
    return readdirSync(dir).some((entry) => {
      try {
        return readFileSync(join(dir, entry), "utf8").includes(PACKAGE_ROOT);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Are this project's themes already installed globally?
 *
 * Passing --theme as well would make pi load each of them twice and report a collision
 * on startup - the global copy wins and the project copy is skipped, which is noise
 * about a duplicate we created ourselves.
 */
function themesInstalledGlobally(): boolean {
  const ours = join(PACKAGE_ROOT, ".pi", "themes");
  try {
    const names = readdirSync(ours).filter((entry) => entry.endsWith(".json"));
    return names.length > 0 && names.every((name) => existsSync(join(AGENT_DIR, "themes", name)));
  } catch {
    return false;
  }
}

function chat(args: string[]): never {
  const pi = join(PACKAGE_ROOT, "node_modules", ".bin", "pi");
  if (!existsSync(pi)) {
    console.error(`pi is not installed in ${PACKAGE_ROOT}. Run npm install there first.`);
    process.exit(1);
  }

  // Loading the same extension twice is an error in pi, not a no-op, so the explicit
  // -e is only for the case where it is not already installed globally.
  const extension = extensionInstalledGlobally()
    ? []
    : ["-e", join(PACKAGE_ROOT, "src", "extension.ts")];
  const themes = themesInstalledGlobally() ? [] : ["--theme", join(PACKAGE_ROOT, ".pi", "themes")];

  const result = spawnSync(pi, [...extension, ...themes, ...args], {
    stdio: "inherit",
    cwd: process.cwd(),
  });
  process.exit(result.status ?? 1);
}

const COMMANDS: Record<string, { module: string; blurb: string }> = {
  render: { module: "./render-frid.ts", blurb: "build one functionality (--list to see them)" },
  conformance: { module: "./conformance-frid.ts", blurb: "black-box tests for one functionality" },
  module: { module: "./render-module.ts", blurb: "build every functionality, with the regression gate" },
  regenerate: { module: "./regenerate-frid.ts", blurb: "rebuild a functionality after its spec changed" },
  skill: { module: "./run.ts", blurb: "run a gated skill" },
};

const USAGE = [
  "usage: plainwright <command> [args]",
  "",
  ...Object.entries(COMMANDS).map(([name, { blurb }]) => `  ${name.padEnd(12)} ${blurb}`),
  `  ${"chat".padEnd(12)} open pi here, with these tools and themes loaded`,
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

const entry = COMMANDS[command];
if (entry === undefined) {
  console.error(`unknown command: ${command}\n\n${USAGE}`);
  process.exit(1);
}

// The subcommands parse process.argv themselves, so present it as if they were invoked
// directly.
process.argv = [process.argv[0]!, process.argv[1]!, ...rest];
await import(entry.module);
