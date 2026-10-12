import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { globalExtensionFile, MIN_NODE, nodeVersionOk, PACKAGE_ROOT, turriOnPath } from "./environment.ts";
import { sandboxAvailable, type Wall } from "./grow/os-sandbox.ts";
import { findTestScripts } from "./grow/test-scripts.ts";
import { hasProjectConfig, readProjectConfig, stackOf } from "./config.ts";
import { checkModels, modelsInUse, piModelAccess, type ModelAccess } from "./model-check.ts";
import { brand } from "./brand.ts";
import { readScript, scriptAgainstMachine, stackOnMachine } from "./stack.ts";

/**
 * `turri doctor`: whether this machine is ready for turri.
 *
 * It looks: Node, a bash to run commands with, which wall is up under the agents' commands - Seatbelt, bubblewrap, or
 * the command check and the audit alone - and, in a project, whether this machine has the toolchains its modules'
 * implementation reqs name and what its testing scripts run, and whether each model its config names answers with this
 * machine's credentials - one short request a model (model-check.ts). It changes one thing, asked first: a plain `pi`
 * that an older turri made load turri too is put back to plain pi.
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
  for (const script of [scripts.unit, scripts.prepare, scripts.conformance]) {
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
    : {
        level: "limited",
        name: "turri on PATH",
        detail: "not found",
        // A clone has its sources; the package from npm has only what was compiled from them.
        fix: existsSync(join(PACKAGE_ROOT, "src")) ? `cd ${PACKAGE_ROOT} && npm link` : "npm install -g turri",
      };
}

/**
 * turri loaded into every `pi` - a file an older `turri setup` wrote into pi's extensions. turri and pi are kept apart
 * now: `turri` starts pi with turri, and a plain `pi` stays pi. Said only when the file is there, for doctor to remove.
 */
function checkGlobal(): Check[] {
  const file = globalExtensionFile();
  if (file === undefined) return [];
  return [
    {
      level: "limited",
      name: "turri in every pi",
      detail: `${file} loads turri into every plain pi too`,
      fix: "turri doctor offers to remove it, below - turri keeps starting with turri",
    },
  ];
}

/**
 * In a project: each model its config names - with the stack chosen, that stack's over it - tried with one short
 * request. A model that answers is ready; one that does not says what the provider said, and what to do about it.
 */
export async function checkProjectModels(project: string, access?: ModelAccess): Promise<Check[]> {
  const used = modelsInUse(readProjectConfig(project, stackOf(project)));
  if (used.length === 0) {
    return [{ level: "missing", name: "Models", detail: "config.turri.yaml names none", fix: "turri init-config writes the two models" }];
  }
  let verdicts;
  try {
    verdicts = await checkModels(used, access ?? (await piModelAccess()));
  } catch (error) {
    return [{ level: "missing", name: "Models", detail: `pi's models could not be read: ${error instanceof Error ? error.message : String(error)}` }];
  }
  return verdicts.map((verdict) => {
    const name = verdict.usedBy.join(", ");
    return verdict.ok
      ? { level: "ok" as const, name, detail: `${verdict.spec} answered (${(verdict.ms / 1000).toFixed(1)}s)` }
      : { level: "missing" as const, name, detail: verdict.spec, more: [verdict.problem], fix: verdict.fix };
  });
}

async function allChecks(options: { models?: boolean } = {}): Promise<Check[]> {
  const checks: Check[] = [checkNode(), checkShell(), checkSandbox(), await checkProvider(), checkPath(), ...checkGlobal()];
  // In a project: what it needs of this machine, and whether its models answer.
  const project = process.cwd();
  if (hasProjectConfig(project) || existsSync(join(project, "plain_modules"))) {
    checks.push(...checkProject(project));
    if (options.models !== false && hasProjectConfig(project)) {
      console.log(brand.muted("Asking each model the config names for a word..."));
      checks.push(...(await checkProjectModels(project)));
    }
  }
  return checks;
}

function report(checks: Check[]): number {
  const paint: Record<Level, (text: string) => string> = { ok: brand.success, missing: brand.error, limited: brand.warning, info: brand.muted };
  // The names in one column, however long the longest - `judge-model, models.judge` - is.
  const width = Math.max(20, ...checks.map((check) => check.name.length)) + 1;
  const under = " ".repeat(width + 4);
  console.log("");
  for (const check of checks) {
    const name = check.level === "missing" ? brand.bold(check.name.padEnd(width)) : check.name.padEnd(width);
    console.log(`  ${paint[check.level](MARK[check.level])} ${name}${check.level === "info" ? brand.muted(check.detail) : check.detail}`);
    for (const line of check.more ?? []) console.log(`${under}${brand.muted(line)}`);
    if (check.fix && check.level !== "ok") console.log(`${under}${brand.accent(`→ ${check.fix}`)}`);
  }
  const missing = checks.filter((check) => check.level === "missing");
  const limited = checks.filter((check) => check.level === "limited");
  console.log("");
  if (missing.length > 0) {
    console.log(brand.error(`Not ready: ${missing.length} thing${missing.length === 1 ? "" : "s"} to fix (✗ above).`));
    return 1;
  }
  console.log(limited.length > 0 ? brand.warning("Ready, with limits (! above).") : brand.success("Ready."));
  return 0;
}

/**
 * Ask a yes/no question. With --yes, yes. With no terminal to ask on, no - nothing is changed
 * without asking - and it says so, so a piped run shows what it would have done.
 */
async function confirm(question: string, fallback: boolean, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    console.log(`${question} - not asked: no terminal. Run turri doctor in a terminal, or with --yes.`);
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

/**
 * Take turri out of every `pi`: the extension file an older `turri setup` wrote. The themes it copied stay - they only
 * add turri's themes to pi's list.
 */
function removeGlobalExtension(): void {
  const file = globalExtensionFile();
  if (file === undefined) return;
  rmSync(file, { force: true });
  console.log(`  removed ${file}`);
}

export async function main(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "usage: turri doctor [--no-models] [--yes]\n\nCheck everything turri needs - in a project, what its modules need of this machine too, and that\n" +
        "each model its config names answers with this machine's credentials (one short request a model;\n--no-models skips it).\n" +
        "It changes nothing but this, asked first: a plain pi that an older turri made load turri too is put back to\n" +
        "plain pi. --yes answers yes.",
    );
    return 0;
  }
  console.log(brand.bold(brand.accent("Checking what turri needs.")));
  if (!nodeVersionOk()) return report([checkNode()]);
  const code = report(await allChecks({ models: !args.includes("--no-models") }));
  // turri and pi are kept apart: a plain pi does not start turri. An older turri's file that made it do so goes, asked.
  const global = globalExtensionFile();
  if (global !== undefined && (await confirm(`\nA plain \`pi\` loads turri too, through ${global}. Remove it, so pi stays pi?`, true, args.includes("--yes") || args.includes("-y")))) {
    removeGlobalExtension();
  }
  return code;
}
