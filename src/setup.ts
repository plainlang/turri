import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
import { closeAllVms, runInVm, STOCK_IMAGE, VM_IMAGE, vmImage, vmImageFor, vmSupported } from "./render/vm.ts";
import { describeContents, describeSources, formatBytes, imageSources, prepareBaseSystem, resolveImageContents } from "./vm-image-contents.ts";
import { type ImagePlan, buildRecipe, describePlan, hasProjectImage, imagePlan, planDiffersFromBuilt, projectImageTag, readBuiltImage, recordBuiltImage, toolchainsOf, userImageFile } from "./vm-image.ts";

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
    ? imageCheck(image.tag)
    : { level: "limited", name: "VM image", detail: STOCK_IMAGE.short, more: STOCK_IMAGE.details, fix: STOCK_IMAGE.fix };
}

/**
 * The full image, as built: what it holds - from what its last build recorded, or the recipe when
 * nothing did - and whether the person's own file asks for something it was not built with.
 */
function imageCheck(tag: string): Check {
  const built = readBuiltImage();
  const plan = imagePlan();
  const { toolchains, extra } = toolchainsOf(built?.packages ?? plan.packages);
  const holds = [...toolchains, ...extra].join(", ");
  const more = [
    `from: ${sourcesLine(built ?? plan)} - plainwright vm-image --plan lists every package`,
    `what goes in: plainwright's recipe, with your changes from ${userImageFile()}${plan.file === undefined ? " (none yet)" : ""}`,
    ...plan.refused.map((refused) => `not applied: ${refused}`),
  ];
  if (planDiffersFromBuilt(plan, built)) {
    return { level: "limited", name: "VM image", detail: `${tag} - ${holds}; your file now asks for ${describePlan(plan)}`, more, fix: "plainwright vm-image   (rebuilds it with your changes)" };
  }
  return { level: "ok", name: "VM image", detail: `${tag} - ${holds}`, more };
}

/** Where a plan's packages come from, or a built image's came from, in one line. */
function sourcesLine(plan: Pick<ImagePlan, "mirror" | "repositories">): string {
  const sources = imageSources(undefined, plan);
  return sources.official
    ? `Alpine Linux ${sources.version}'s own repositories (dl-cdn.alpinelinux.org, main and community)`
    : `Alpine Linux ${sources.version}, the base system and kernel from ${sources.mirror}, packages from ${sources.repositories.map((repository) => repository.url).join(", ")}`;
}

/** A project in this folder with an image of its own: whether it is built, and what it holds. */
function checkProjectImage(): Check | undefined {
  const project = process.cwd();
  if (!hasProjectImage(project)) return undefined;
  const tag = projectImageTag(project);
  const plan = imagePlan({ project });
  const built = readBuiltImage(project);
  const name = "Project VM image";
  if (built === undefined || vmImageFor(project)?.own !== true) {
    return { level: "limited", name, detail: `${tag} is not built yet - this project runs the default image meanwhile; it would hold ${describePlan(plan)}`, fix: "plainwright vm-image   (in this project)" };
  }
  if (planDiffersFromBuilt(plan, built)) {
    return { level: "limited", name, detail: `${tag} - its config.yaml now asks for ${describePlan(plan)}`, fix: "plainwright vm-image   (in this project)" };
  }
  const { toolchains, extra } = toolchainsOf(built.packages);
  return { level: "ok", name, detail: `${tag} - ${[...toolchains, ...extra].join(", ")}`, more: [`from: ${sourcesLine(built)}`] };
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
  else {
    checks.push(checkQemu(), checkImage(), checkBuilder());
    const project = checkProjectImage();
    if (project !== undefined) checks.push(project);
  }
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
 * Build a sandbox VM image for this machine's architecture, the way `route` says - by default whichever
 * this machine can: the default image, from plainwright's recipe with the person's file over it, or - for
 * a project whose config.yaml has a `vm-image:` - the project's own, under its own tag. What it prints goes
 * to `write`. Returns the exit status.
 */
export async function buildVmImage(
  options: { route?: "docker" | "native"; project?: string; write?: (text: string) => void } = {},
): Promise<number> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const route = options.route ?? buildRoute();
  if (route === undefined) {
    write(`Nothing here can build the VM image: ${builderHint()}.\n`);
    return 1;
  }
  if (route === "docker" && !dockerRunning()) {
    write(`Docker is not running. ${dockerState() === "absent" ? "Install it" : `Start it (${dockerStartHint()})`}, or build without it: plainwright vm-image --native\n`);
    return 1;
  }
  if (route === "native" && mke2fsPath() === undefined) {
    write(`Building without Docker needs e2fsprogs: ${e2fsprogsInstallHint()}\n`);
    return 1;
  }
  // The recipe says what goes in - plainwright's, with the person's and the project's changes over it; how and
  // for which machine it is built is decided here.
  const plan = imagePlan({ project: options.project });
  for (const refused of plan.refused) write(`Not applied: ${refused}\n`);
  const config = buildRecipe(plan);
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  config.arch = arch;
  if (route === "docker") config.container = { force: true, runtime: "docker" };
  else delete config.container;
  const tag = options.project !== undefined ? projectImageTag(options.project) : VM_IMAGE;
  // What it downloads, and from where - said before anything is; a name the repositories do not have stops it here.
  try {
    const contents = await resolveImageContents(plan, arch);
    for (const line of describeContents(contents)) write(`${line}\n`);
    write("\n");
    if (contents.missing.length > 0) {
      write(`Not built: ${contents.missing.join(", ")} ${contents.missing.length === 1 ? "is" : "are"} not in Alpine ${contents.sources.version}'s repositories. Take ${contents.missing.length === 1 ? "it" : "them"} out of the recipe, or install ${contents.missing.length === 1 ? "it" : "them"} another way.\n`);
      return 1;
    }
  } catch (error) {
    for (const line of describeSources(imageSources(arch, plan))) write(`${line}\n`);
    write(`(What each package is could not be read from the repositories: ${error instanceof Error ? error.message : String(error)}.)\n\n`);
  }
  const dir = mkdtempSync(join(tmpdir(), "plainwright-image-"));
  const file = join(dir, "image.json");
  writeFileSync(file, JSON.stringify(config, null, 2));
  const gondolin = join(PACKAGE_ROOT, "node_modules", ".bin", "gondolin");
  // Another server's base system, with the chosen repositories written in: Gondolin installs the packages from
  // those. Its build runs with a home of its own, so it finds that base system; the images still go where
  // every VM finds them.
  let env: NodeJS.ProcessEnv | undefined;
  try {
    const home = await prepareBaseSystem(plan, arch);
    if (home !== undefined) env = { ...process.env, HOME: home, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache") };
  } catch (error) {
    write(`Not built: the base system could not be taken from ${imageSources(arch, plan).rootfs}: ${error instanceof Error ? error.message : String(error)}\n`);
    rmSync(dir, { recursive: true, force: true });
    return 1;
  }
  write(`Building ${tag} for ${arch}, ${route === "docker" ? "in Docker" : "without Docker"}: ${describePlan(plan)}.\n`);
  write(`With every toolchain it takes about 7 minutes and 2 GB; fewer take less.\n`);
  try {
    const status = await new Promise<number>((resolve) => {
      const child = spawn(gondolin, ["build", "--config", file, "--arch", arch, "--tag", tag], { stdio: ["ignore", "pipe", "pipe"], ...(env !== undefined ? { env } : {}) });
      child.stdout.on("data", (data: Buffer) => write(data.toString()));
      child.stderr.on("data", (data: Buffer) => write(data.toString()));
      child.on("error", (error) => (write(`${error.message}\n`), resolve(1)));
      child.on("close", (code) => resolve(code ?? 1));
    });
    if (status === 0) {
      recordBuiltImage(plan, options.project);
      write(`Built ${tag}. VMs started from now on run it; one already running keeps the image it started with.\n`);
    }
    return status;
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
  // What it would download, and from where: read from Alpine's index before the question, when it can be.
  const plan = imagePlan();
  let size = "about 800 MB to download and 1.7 GB installed with every toolchain";
  try {
    const contents = await resolveImageContents(plan);
    size = `${contents.all.length} packages, ${formatBytes(contents.download)} to download, ${formatBytes(contents.installed)} installed`;
  } catch {
    // Offline: the estimate stands.
  }
  const ask = (route: string) =>
    confirm(
      `Build the full VM image now, ${route}? It holds ${describePlan(plan)} - packages from ${sourcesLine(plan)}: ` +
        `${size}, about 7 minutes. plainwright vm-image --plan lists every package, its ` +
        `version and where it comes from; ${userImageFile()} leaves toolchains out or adds others (see plainwright vm-image --help).`,
      true,
      yes,
    );
  const build = async (route: "docker" | "native") => {
    if ((await buildVmImage({ route })) !== 0) console.log(`The image did not build; until it does, commands run in the ${STOCK_IMAGE.short}.\n`);
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
    if (await ask("with e2fsprogs")) await build("native");
    return;
  }

  // No e2fsprogs: Docker can build it instead.
  let docker = dockerState();
  if (docker === "stopped" && (await confirm("Docker is installed but not running. Start it now to build the VM image in Docker?", true, yes))) {
    if (await startDocker()) docker = "running";
  }
  if (docker === "running") {
    if (await ask("in Docker")) await build("docker");
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
          "usage: plainwright vm-image [--native | --docker] [--default] [--plan]\n\n" +
          "Everything in the image comes from Alpine Linux's own repositories (dl-cdn.alpinelinux.org, main and\n" +
          "community). --plan lists what a build would download - each package, its version, repository, project,\n" +
          "licence and size, what each toolchain costs - and builds nothing.\n\n" +
          `What goes in: plainwright's recipe (vm/image.json) - Python, Node, Java, Go, Rust, C/C++, git - with your own\n` +
          `changes from ${userImageFile()}, kept across updates:\n` +
          '  { "remove": ["java", "python"], "add": ["zig"] }\n' +
          "remove takes toolchains by name (python, node, java, go, rust, c) or Alpine packages; add takes Alpine\n" +
          "packages; packages: [...] instead defines the image in full. The basics - git, bash, curl and the rest - are\n" +
          "always in.\n\n" +
          "A project can have an image of its own: vm-image: in its config.yaml, the same keys, over yours. Run in that\n" +
          "project, this builds its image, and every VM of the project runs it; --default builds the default one instead.\n\n" +
          "Build the sandbox VM image for this machine - with e2fsprogs when it is\n" +
          "installed, otherwise in Docker. --native or --docker picks the way.",
      }[command],
    );
    return 0;
  }
  if (command === "vm-image") {
    const route = args.includes("--docker") ? "docker" : args.includes("--native") ? "native" : undefined;
    // In a project with an image of its own, that one - unless the default is asked for.
    const project = !args.includes("--default") && hasProjectImage(process.cwd()) ? process.cwd() : undefined;
    // What it would download, and from where - without building it.
    if (args.includes("--plan")) {
      const plan = imagePlan(project !== undefined ? { project } : {});
      console.log(`${project !== undefined ? projectImageTag(project) : VM_IMAGE}: ${describePlan(plan)}\n`);
      for (const refused of plan.refused) console.log(`Not applied: ${refused}`);
      const contents = await resolveImageContents(plan);
      console.log(describeContents(contents).join("\n"));
      return contents.missing.length > 0 ? 1 : 0;
    }
    return buildVmImage({ ...(route !== undefined ? { route } : {}), ...(project !== undefined ? { project } : {}) });
  }
  if (command === "setup") return setup(args.includes("--yes") || args.includes("-y"));
  console.log("Checking what plainwright needs.");
  return report(await allChecks({ boot: !args.includes("--quick") }));
}
