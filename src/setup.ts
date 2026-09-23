import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  AGENT_DIR,
  brewInstalled,
  dockerRunning,
  dockerStartHint,
  dockerState,
  e2fsprogsInstallHint,
  extensionInstalledGlobally,
  globalExtensionFile,
  MIN_NODE,
  mke2fsPath,
  nodeVersionOk,
  PACKAGE_ROOT,
  plainwrightOnPath,
  qemuBinary,
  qemuInstalled,
  qemuInstallHint,
  themeFiles,
  themesInstalledGlobally,
} from "./environment.ts";
import { closeAllVms, runInVm, STOCK_IMAGE, VM_IMAGE, vmImage, vmSupported } from "./render/vm.ts";

/**
 * Getting a machine ready for plainwright, and checking that it is.
 *
 * `doctor` looks and changes nothing. `setup` looks, and fixes what it can from here - QEMU
 * through Homebrew, the VM image through Docker, loading plainwright into every `pi` - asking
 * before each. Both end by starting a sandbox VM for real, because a VM that does not start is
 * the one failure that stops every render, and nothing short of starting one proves it will.
 */

type Level = "ok" | "missing" | "limited" | "info";

interface Check {
  level: Level;
  name: string;
  detail: string;
  /** More about it, a line each, shown under the detail. */
  more?: string[];
  /** What to run or do about it. */
  fix?: string;
}

const MARK: Record<Level, string> = { ok: "✓", missing: "✗", limited: "!", info: "·" };

/** Toolchains a started VM is asked about, by the command that shows each is there. */
const TOOLCHAINS: Array<[string, string]> = [
  ["Python", "python3"],
  ["Node", "node"],
  ["Java", "java"],
  ["Go", "go"],
  ["Rust", "rustc"],
  ["C/C++", "gcc"],
  ["git", "git"],
];

function checkNode(): Check {
  const version = process.versions.node;
  return nodeVersionOk(version)
    ? { level: "ok", name: "Node", detail: version }
    : {
        level: "missing",
        name: "Node",
        detail: `${version} - plainwright needs ${MIN_NODE.join(".")} or newer`,
        fix: "install a newer Node (https://nodejs.org, or `brew install node`)",
      };
}

function checkPlatform(): Check | undefined {
  if (vmSupported()) return undefined;
  return {
    level: "missing",
    name: "Sandbox VM",
    detail: `not available on ${process.platform}/${process.arch} - only Apple Silicon macOS and Linux run it`,
    fix: "use an Apple Silicon Mac or Linux; without the VM, agents get no shell and commands are refused",
  };
}

function checkQemu(): Check {
  return qemuInstalled()
    ? { level: "ok", name: "QEMU", detail: qemuBinary() }
    : {
        level: "missing",
        name: "QEMU",
        detail: `${qemuBinary()} not found - the sandbox VM runs on it`,
        fix: qemuInstallHint(),
      };
}

function checkImage(): Check {
  const image = vmImage();
  return image
    ? { level: "ok", name: "VM image", detail: `${image.tag} - Python, Node, Java, Go, Rust, C/C++, git` }
    : { level: "limited", name: "VM image", detail: STOCK_IMAGE.short, more: STOCK_IMAGE.details, fix: STOCK_IMAGE.fix };
}

/** What can build the full VM image here: Docker, or e2fsprogs without it. */
export function checkBuilder(): Check {
  const needed = vmImage() === undefined;
  const route = buildRoute();
  const name = "Image builder";
  if (route === "native") return { level: needed ? "ok" : "info", name, detail: `e2fsprogs (${mke2fsPath()}) - no Docker needed` };
  if (route === "docker") return { level: needed ? "ok" : "info", name, detail: "Docker, running" };
  if (!needed) return { level: "info", name, detail: `none - only needed to rebuild the VM image (${builderHint()})` };
  const docker = dockerState();
  return {
    level: "limited",
    name,
    detail:
      docker === "stopped"
        ? "Docker is installed but not running, and e2fsprogs is not installed"
        : "neither Docker nor e2fsprogs is installed",
    fix: `${builderHint()}, then plainwright vm-image`,
  };
}

/** The ways to get a builder: e2fsprogs first - installed once, nothing to keep running - then Docker. */
function builderHint(): string {
  const docker = dockerState() === "stopped" ? `start Docker (${dockerStartHint()})` : "install Docker";
  return `install e2fsprogs (${e2fsprogsInstallHint()}), or ${docker}`;
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
  const found = plainwrightOnPath();
  return found
    ? { level: "ok", name: "plainwright on PATH", detail: found }
    : { level: "limited", name: "plainwright on PATH", detail: "not found", fix: `cd ${PACKAGE_ROOT} && npm link` };
}

function checkGlobal(): Check {
  const extension = extensionInstalledGlobally();
  const themes = themesInstalledGlobally();
  if (extension && themes) return { level: "ok", name: "In every pi", detail: `yes (${globalExtensionFile()})` };
  return {
    level: "info",
    name: "In every pi",
    detail: "no - `plainwright chat` loads it; a plain `pi` does not",
    fix: "plainwright setup can install it",
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

/** Start a VM for real, in a throwaway project, and ask it what it has. */
async function checkVmStarts(): Promise<Check> {
  const project = mkdtempSync(join(tmpdir(), "plainwright-doctor-"));
  const cwd = join(project, "plain_modules", "doctor", "code");
  mkdirSync(cwd, { recursive: true });
  const started = Date.now();
  try {
    const probe = TOOLCHAINS.map(([, command]) => `command -v ${command} >/dev/null && echo ${command}`).join("; ");
    const result = await runInVm(`${probe}; true`, { cwd, timeoutMs: 300_000 });
    const found = new Set(result.output.split("\n").map((line) => line.trim()));
    const has = TOOLCHAINS.filter(([, command]) => found.has(command)).map(([name]) => name);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    return { level: "ok", name: "VM starts", detail: `in ${seconds}s - has ${has.join(", ")}` };
  } catch (error) {
    return {
      level: "missing",
      name: "VM starts",
      detail: `no - ${error instanceof Error ? error.message : String(error)}`,
      fix: "fix what is marked ✗ above, then run plainwright doctor again",
    };
  } finally {
    await closeAllVms();
    rmSync(project, { recursive: true, force: true });
  }
}

async function allChecks(options: { boot: boolean }): Promise<Check[]> {
  const checks: Check[] = [checkNode()];
  const platform = checkPlatform();
  if (platform) checks.push(platform);
  else checks.push(checkQemu(), checkImage(), checkBuilder());
  checks.push(await checkProvider(), checkPath(), checkGlobal(), checkTemplates());
  const vmReady = platform === undefined && qemuInstalled();
  if (options.boot && vmReady) {
    process.stdout.write("  … starting a sandbox VM to check it works (the first ever downloads its image, ~200 MB)\n");
    checks.push(await checkVmStarts());
  }
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
    console.log(`${question} - not asked: no terminal. Run plainwright setup in a terminal, or with --yes.`);
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
 * How the image can be built here. Natively first: it needs only `mke2fs` from e2fsprogs -
 * Gondolin unpacks the Alpine packages itself - which is installed once and never has to be
 * running. Docker when e2fsprogs is not there and Docker is running: the build then happens in
 * a Linux container. Nothing, when neither is there.
 */
export function buildRoute(): "docker" | "native" | undefined {
  if (mke2fsPath() !== undefined) return "native";
  if (dockerRunning()) return "docker";
  return undefined;
}

/**
 * Build the sandbox VM image for this machine's architecture, the way `route` says - by
 * default whichever this machine can. Returns the exit status.
 */
export function buildVmImage(route: "docker" | "native" | undefined = buildRoute()): number {
  if (route === undefined) {
    console.error(`Nothing here can build the VM image: ${builderHint()}.`);
    return 1;
  }
  if (route === "docker" && !dockerRunning()) {
    console.error(`Docker is not running. ${dockerState() === "absent" ? "Install it" : `Start it (${dockerStartHint()})`}, or build without it: plainwright vm-image --native`);
    return 1;
  }
  if (route === "native" && mke2fsPath() === undefined) {
    console.error(`Building without Docker needs e2fsprogs: ${e2fsprogsInstallHint()}`);
    return 1;
  }
  // The config says what goes in; how and for which machine it is built is decided here.
  const config = JSON.parse(readFileSync(join(PACKAGE_ROOT, "vm", "image.json"), "utf8")) as Record<string, unknown>;
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  config.arch = arch;
  if (route === "docker") config.container = { force: true, runtime: "docker" };
  else delete config.container;
  const dir = mkdtempSync(join(tmpdir(), "plainwright-image-"));
  const file = join(dir, "image.json");
  writeFileSync(file, JSON.stringify(config, null, 2));
  const gondolin = join(PACKAGE_ROOT, "node_modules", ".bin", "gondolin");
  console.log(`Building ${VM_IMAGE} for ${arch}, ${route === "docker" ? "in Docker" : "without Docker"} - about 7 minutes, 2 GB.`);
  try {
    const result = spawnSync(gondolin, ["build", "--config", file, "--arch", arch, "--tag", VM_IMAGE], { stdio: "inherit" });
    return result.status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Start Docker and wait until it answers. macOS only; elsewhere, say how. */
async function startDocker(): Promise<boolean> {
  if (process.platform !== "darwin") {
    console.log(`Start it with: ${dockerStartHint()}`);
    return false;
  }
  spawnSync("open", ["-a", "Docker"], { stdio: "ignore" });
  process.stdout.write("Starting Docker");
  for (let waited = 0; waited < 120; waited += 3) {
    if (dockerRunning()) {
      process.stdout.write(" - running.\n");
      return true;
    }
    process.stdout.write(".");
    await new Promise((done) => setTimeout(done, 3000));
  }
  process.stdout.write(" - it did not come up within 2 minutes.\n");
  return false;
}

/**
 * Get the full VM image built. e2fsprogs first, because it is installed once and then simply
 * there; Docker only when e2fsprogs is not to be had, and started if it is installed but not
 * running.
 */
async function setupImage(yes: boolean): Promise<void> {
  const ask = (route: string) =>
    confirm(`Build the full VM image now, ${route} (Python, Node, Java, Go, Rust, C/C++, git; about 7 minutes, 2 GB)?`, true, yes);
  const build = (route: "docker" | "native") => {
    if (buildVmImage(route) !== 0) console.log(`The image did not build; until it does, commands run in the ${STOCK_IMAGE.short}.\n`);
  };

  if (mke2fsPath() === undefined) {
    if (brewInstalled()) {
      if (await confirm("The VM image is built with e2fsprogs - a few small tools, installed once, nothing to keep running. Install it with Homebrew now?", true, yes)) {
        spawnSync("brew", ["install", "e2fsprogs"], { stdio: "inherit" });
      }
    } else if (process.platform === "linux") {
      console.log(`The VM image is built with e2fsprogs, which is not installed. Install it with: ${e2fsprogsInstallHint()}\n`);
    }
  }
  if (mke2fsPath() !== undefined) {
    if (await ask("with e2fsprogs")) build("native");
    return;
  }

  // No e2fsprogs: Docker can build it instead.
  let docker = dockerState();
  if (docker === "stopped" && (await confirm("Docker is installed but not running. Start it now to build the VM image in Docker?", true, yes))) {
    if (await startDocker()) docker = "running";
  }
  if (docker === "running") {
    if (await ask("in Docker")) build("docker");
    return;
  }

  console.log(
    [
      "The full VM image (Python, Node, Java, Go, Rust, C/C++, git) cannot be built here yet: e2fsprogs is not",
      docker === "stopped" ? "installed, and Docker is not running." : "installed, and there is no Docker.",
      "Until it is built, commands run in the stock image:",
      "",
      ...STOCK_IMAGE.details.map((line) => `  ${line}`),
      "",
      `To build it: ${builderHint()}; then run plainwright vm-image.`,
      "",
    ].join("\n"),
  );
}

/** Load plainwright into every `pi`: one extension file, and the themes beside pi's own. */
function installGlobally(): void {
  const extensions = join(AGENT_DIR, "extensions");
  mkdirSync(extensions, { recursive: true });
  if (!extensionInstalledGlobally()) {
    const file = join(extensions, "plainwright.ts");
    writeFileSync(
      file,
      "// Makes the plainwright tools available in every pi session, from any directory.\n" +
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
  console.log("Getting this machine ready for plainwright.\n");

  if (!nodeVersionOk()) return report([checkNode()]);

  if (vmSupported() && !qemuInstalled()) {
    if (brewInstalled() && (await confirm("QEMU runs the sandbox VM and is not installed. Install it with Homebrew now?", true, yes))) {
      spawnSync("brew", ["install", "qemu"], { stdio: "inherit" });
    } else {
      console.log(`QEMU is needed for the sandbox VM. Install it with: ${qemuInstallHint()}\n`);
    }
  }

  if (vmSupported() && vmImage() === undefined) await setupImage(yes);

  if (!(extensionInstalledGlobally() && themesInstalledGlobally())) {
    if (await confirm("Load plainwright into every `pi` too (a file in ~/.pi/agent/extensions, and the themes)?", false, yes)) {
      installGlobally();
      console.log("");
    }
  }

  return report(await allChecks({ boot: true }));
}

export async function main(command: "setup" | "doctor" | "vm-image", args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      {
        setup: "usage: plainwright setup [--yes]\n\nCheck everything plainwright needs and fix what can be fixed here, asking first.\n--yes answers yes to every question.",
        doctor: "usage: plainwright doctor [--quick]\n\nCheck everything plainwright needs, and change nothing.\n--quick skips starting a sandbox VM.",
        "vm-image":
          "usage: plainwright vm-image [--native | --docker]\n\nBuild the sandbox VM image with every toolchain, for this machine - with e2fsprogs when it is\n" +
          "installed, otherwise in Docker. --native or --docker picks the way.",
      }[command],
    );
    return 0;
  }
  if (command === "vm-image") return buildVmImage(args.includes("--docker") ? "docker" : args.includes("--native") ? "native" : undefined);
  if (command === "setup") return setup(args.includes("--yes") || args.includes("-y"));
  console.log("Checking what plainwright needs.");
  return report(await allChecks({ boot: !args.includes("--quick") }));
}
