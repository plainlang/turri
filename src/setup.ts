import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  AGENT_DIR,
  extensionInstalledGlobally,
  globalExtensionFile,
  MIN_NODE,
  nodeVersionOk,
  PACKAGE_ROOT,
  turriOnPath,
  themeFiles,
  themesInstalledGlobally,
} from "./environment.ts";
import { sandboxAvailable, type Wall } from "./grow/os-sandbox.ts";
import { findTestScripts } from "./grow/test-scripts.ts";
import { readScript, scriptAgainstMachine, stackOnMachine } from "./stack.ts";

/**
 * Getting a machine ready for turri, and checking that it is.
 *
 * `doctor` looks and changes nothing: Node, a bash to run commands with, which wall is up under the agents' commands -
 * Seatbelt, bubblewrap, or the command check and the audit alone - and, in a project, whether this machine has the
 * toolchains its modules' implementation reqs name and what its testing scripts run. `setup` does the same, and offers
 * the one thing it can do from here: load turri into every `pi`.
 */

type Level = "ok" | "missing" | "limited" | "info";

export interface Check {
  level: Level;
  name: string;
  detail: string;
  /** More about it, a line each, shown under the detail. */
  more?: string[];
  /** What to run or do about it. */
  fix?: string;
}

const MARK: Record<Level, string> = { ok: "✓", missing: "✗", limited: "!", info: "·" };

function checkNode(): Check {
  const version = process.versions.node;
  return nodeVersionOk(version)
    ? { level: "ok", name: "Node", detail: version }
    : {
        level: "missing",
        name: "Node",
        detail: `${version} - turri needs ${MIN_NODE.join(".")} or newer`,
        fix: "install a newer Node (https://nodejs.org, or `brew install node`)",
      };
}

/** bash: every agent command and every testing script runs with it, on every platform. */
export function checkShell(found: boolean = spawnSync("bash", ["--version"], { stdio: "ignore", windowsHide: true }).status === 0, platform: NodeJS.Platform = process.platform): Check {
  if (found) return { level: "ok", name: "bash", detail: "on the PATH - agents' commands and the testing scripts run with it" };
  return {
    level: "missing",
    name: "bash",
    detail: "not on the PATH - agents' commands and the testing scripts run with it",
    fix: platform === "win32" ? "install Git for Windows (Git Bash), and put its bash on the PATH" : "install bash with your system's package manager",
  };
}

/** Which wall is up under the agents' commands, and - where none starts - why, and how to give it one. */
export function checkSandbox(wall: Wall = sandboxAvailable(), platform: NodeJS.Platform = process.platform): Check {
  if (wall.kind === "seatbelt") return { level: "ok", name: "OS sandbox", detail: "Seatbelt - under the command check and the audit" };
  if (wall.kind === "bubblewrap") {
    return { level: "ok", name: "OS sandbox", detail: `bubblewrap${wall.proc === "bind" ? ", the host's /proc bound (this container masks its own)" : ""} - under the command check and the audit` };
  }
  return {
    level: platform === "win32" ? "info" : "limited",
    name: "OS sandbox",
    detail: `none - ${wall.why}; the command check and the audit hold alone`,
    ...(wall.fix !== undefined ? { fix: wall.fix } : {}),
  };
}

/**
 * In a project: each module's toolchains, as its implementation reqs name them, against this machine's PATH; and each
 * testing script against this machine - a program it names that is not here, a toolchain it runs that is not on the
 * PATH. Nothing outside a project.
 */
export function checkProject(project: string, machine: { has?: (command: string) => boolean; exists?: (path: string) => boolean } = {}): Check[] {
  const checks: Check[] = [];
  for (const { module, needs, missing } of stackOnMachine(project, machine.has)) {
    if (needs.length === 0) continue;
    checks.push(
      missing.length === 0
        ? { level: "ok", name: `${module}`, detail: `has ${needs.map((need) => need.toolchain).join(", ")}` }
        : {
            level: "missing",
            name: `${module}`,
            detail: `its implementation reqs need ${missing.map((need) => `${need.toolchain} (${need.words.join(", ")})`).join(", ")}, which this machine lacks`,
            fix: `install ${missing.map((need) => need.toolchain).join(" and ")} on this machine - the agents use its toolchains, and install none`,
          },
    );
  }
  const scripts = findTestScripts(project);
  for (const script of [scripts.unit, scripts.conformance]) {
    if (script === undefined) continue;
    const text = readScript(script);
    if (text === undefined) continue;
    const found = scriptAgainstMachine(text, machine);
    if (found.length === 0) continue;
    checks.push({
      level: "limited",
      name: relative(project, script),
      detail: "does not fit this machine - it is yours to fix:",
      more: found,
    });
  }
  return checks;
}

async function checkProvider(): Promise<Check> {
  try {
    const runtime = await ModelRuntime.create();
    const available = new ModelRegistry(runtime).getAvailable();
    const providers = [...new Set(available.map((model) => model.provider))];
    if (providers.length > 0) {
      return { level: "ok", name: "Model provider", detail: `${providers.join(", ")} (${available.length} models)` };
    }
  } catch {
    // Reported as missing below.
  }
  return {
    level: "missing",
    name: "Model provider",
    detail: "no model has credentials",
    fix: "run `pi` and use /login, or set an API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, ...)",
  };
}

function checkPath(): Check {
  const found = turriOnPath();
  return found
    ? { level: "ok", name: "turri on PATH", detail: found }
    : { level: "limited", name: "turri on PATH", detail: "not found", fix: `cd ${PACKAGE_ROOT} && npm link` };
}

function checkGlobal(): Check {
  const extension = extensionInstalledGlobally();
  const themes = themesInstalledGlobally();
  if (extension && themes) return { level: "ok", name: "In every pi", detail: `yes (${globalExtensionFile()})` };
  return {
    level: "info",
    name: "In every pi",
    detail: "no - `turri chat` loads it; a plain `pi` does not",
    fix: "turri setup can install it",
  };
}

function checkTemplates(): Check {
  const dirs = (process.env.PLAIN_TEMPLATE_DIRS ?? "").split(":").filter(Boolean);
  if (dirs.length === 0) return { level: "info", name: "PLAIN_TEMPLATE_DIRS", detail: "not set - only needed for specs that import shared templates" };
  const missing = dirs.filter((dir) => !existsSync(dir));
  return missing.length === 0
    ? { level: "ok", name: "PLAIN_TEMPLATE_DIRS", detail: dirs.join(":") }
    : { level: "limited", name: "PLAIN_TEMPLATE_DIRS", detail: `does not exist: ${missing.join(", ")}` };
}

async function allChecks(): Promise<Check[]> {
  const checks: Check[] = [checkNode(), checkShell(), checkSandbox(), await checkProvider(), checkPath(), checkGlobal(), checkTemplates()];
  // In a project: what it needs of this machine.
  const project = process.cwd();
  if (existsSync(join(project, "config.yaml")) || existsSync(join(project, "plain_modules"))) checks.push(...checkProject(project));
  return checks;
}

function report(checks: Check[]): number {
  console.log("");
  for (const check of checks) {
    console.log(`  ${MARK[check.level]} ${check.name.padEnd(20)} ${check.detail}`);
    for (const line of check.more ?? []) console.log(`    ${" ".repeat(20)} ${line}`);
    if (check.fix && check.level !== "ok") console.log(`    ${" ".repeat(20)} → ${check.fix}`);
  }
  const missing = checks.filter((check) => check.level === "missing");
  const limited = checks.filter((check) => check.level === "limited");
  console.log("");
  if (missing.length > 0) {
    console.log(`Not ready: ${missing.length} thing${missing.length === 1 ? "" : "s"} to fix (✗ above).`);
    return 1;
  }
  console.log(limited.length > 0 ? "Ready, with limits (! above)." : "Ready.");
  return 0;
}

/**
 * Ask a yes/no question. With --yes, yes. With no terminal to ask on, no - nothing is changed
 * without asking - and it says so, so a piped run shows what it would have done.
 */
async function confirm(question: string, fallback: boolean, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    console.log(`${question} - not asked: no terminal. Run turri setup in a terminal, or with --yes.`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
    return answer === "" ? fallback : answer.startsWith("y");
  } finally {
    rl.close();
  }
}

/** Load turri into every `pi`: one extension file, and the themes beside pi's own. */
function installGlobally(): void {
  const extensions = join(AGENT_DIR, "extensions");
  mkdirSync(extensions, { recursive: true });
  if (!extensionInstalledGlobally()) {
    const file = join(extensions, "turri.ts");
    writeFileSync(
      file,
      "// Makes the turri tools available in every pi session, from any directory.\n" +
        "// Delete this file to remove them. The one absolute path lives here and nowhere else.\n" +
        `export { default } from ${JSON.stringify(join(PACKAGE_ROOT, "src", "extension.ts"))};\n`,
    );
    console.log(`  wrote ${file}`);
  }
  const themes = join(AGENT_DIR, "themes");
  mkdirSync(themes, { recursive: true });
  for (const name of themeFiles()) {
    const source = join(PACKAGE_ROOT, ".pi", "themes", name);
    const target = join(themes, name);
    if (existsSync(target) && readFileSync(target, "utf8") === readFileSync(source, "utf8")) continue;
    copyFileSync(source, target);
    console.log(`  copied ${name} to ${themes}`);
  }
}

async function setup(yes: boolean): Promise<number> {
  console.log("Getting this machine ready for turri.\n");

  if (!nodeVersionOk()) return report([checkNode()]);

  if (!(extensionInstalledGlobally() && themesInstalledGlobally())) {
    if (await confirm("Load turri into every `pi` too (a file in ~/.pi/agent/extensions, and the themes)?", false, yes)) {
      installGlobally();
      console.log("");
    }
  }

  return report(await allChecks());
}

export async function main(command: "setup" | "doctor", args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      {
        setup: "usage: turri setup [--yes]\n\nCheck everything turri needs, and offer to load turri into every pi, asking first.\n--yes answers yes.",
        doctor: "usage: turri doctor\n\nCheck everything turri needs - in a project, what its modules need of this machine too - and change nothing.",
      }[command],
    );
    return 0;
  }
  if (command === "setup") return setup(args.includes("--yes") || args.includes("-y"));
  console.log("Checking what turri needs.");
  return report(await allChecks());
}
