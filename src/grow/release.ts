import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { basename, dirname, join, relative } from "node:path";
import { HISTORY_DIR } from "./lineage.ts";
import { NOTES_FILE } from "./notes.ts";
import { distDirFor, ensureInScratch, projectDirOf } from "./paths.ts";
import { findCodebaseTip, type ChainEntry } from "./requires.ts";
import { RECORD_FILE } from "./records.ts";

/**
 * Deploy: a module's code, as its last commit has it, put out in `dist/<module>` for the person to try.
 *
 * A render works in `plain_modules/<module>/code` while the person asks to try what is there, so what
 * is there is half-written. Its last commit is not: every unit of work starts from one and ends with
 * one, and both are runnable. So the commit is exported - git's own list of what it tracks, and
 * nothing else - which is a copy of the working tree with every unstaged and untracked change put
 * back, without a list of what each stack leaves lying around (`node_modules`, `.venv`, `target`). The
 * working tree itself is never read or touched.
 *
 * What starts it runs here, on the person's machine, not in the sandbox VM: a server the person opens
 * in their browser, with their toolchains. So nothing is installed without them saying so - the
 * commands that would are told apart from the rest (`installsSoftware`) and put to them first - and
 * everything started is the harness's to stop: on a redeploy, on /halt, and when turri exits.
 */

/**
 * How a module is released - always from its last commit, exported to `dist/<module>` first. `dist`, the default: started
 * from there. `guided`: taken on from there as there is guidance to - the person's, the project's AGENTS.md, a skill -
 * into the host codebase, say.
 */
export type ReleaseWay = "dist" | "guided";

export interface Deployment {
  moduleName: string;
  plainFile: string;
  way: ReleaseWay;
  /** `dist/<module>`, in the project: the module's last commit, exported. */
  dir: string;
  /** Guided: the host codebase the guidance takes the code into, and what release runs and starts runs from. */
  hostDir?: string;
  /** Where the module's code is built: `plain_modules/<module>/code`. */
  buildDir: string;
  commit: string;
  /** The commit's subject: what the last unit of work that landed did. */
  subject: string;
  /** When, as git says it: "3 minutes ago". */
  when: string;
  /** Work under way in the module - changes nobody committed yet - left out. */
  unfinished: boolean;
  /** The module the spec's code lives in had nothing committed yet: the nearest one below it that had, instead. */
  instead?: string;
}

function git(moduleDir: string, args: string[]) {
  return spawnSync("git", ["--git-dir", join(moduleDir, HISTORY_DIR), "--work-tree", moduleDir, ...args], { cwd: moduleDir, encoding: "utf8" });
}

/** The module's last commit, when it has one with code in it. */
function committedCode(moduleDir: string): string | undefined {
  if (!existsSync(join(moduleDir, HISTORY_DIR))) return undefined;
  const commit = git(moduleDir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (commit.status !== 0) return undefined;
  // A commit with no code folder in it has nothing to run.
  if (git(moduleDir, ["rev-parse", "--verify", "--quiet", "HEAD:code"]).status !== 0) return undefined;
  return commit.stdout.trim();
}

/**
 * Which module to deploy for a spec: the tip of its codebase - code accumulates up a requires chain, so
 * the top module holds everything below it. Before the tip has anything committed, the nearest module
 * below it that has.
 */
export function deployTarget(plainFile: string, inModule?: string): { entry: ChainEntry; commit: string; instead?: string } {
  const { tip, chain } = findCodebaseTip(plainFile, { allowNoFunctionalities: true, ...(inModule !== undefined ? { inModule } : {}) });
  const candidates = [tip, ...[...chain].reverse().filter((entry) => entry.moduleName !== tip.moduleName)];
  for (const entry of candidates) {
    const commit = committedCode(dirname(entry.buildDir));
    if (commit !== undefined) return { entry, commit, ...(entry.moduleName !== tip.moduleName ? { instead: tip.moduleName } : {}) };
  }
  throw new Error(`Nothing is built yet for ${tip.moduleName}${candidates.length > 1 ? " or the modules it requires" : ""}: there is no code to deploy. Render it first.`);
}

/**
 * Export the module's code at its last commit into `dist/<module>`, replacing whatever was there - the
 * harness's own files (what the code is built from, the agents' notes) left out.
 */
export function exportModule(plainFile: string, inModule?: string): Deployment {
  const { entry, commit, instead } = deployTarget(plainFile, inModule);
  const moduleDir = dirname(entry.buildDir);
  const dir = distDirFor(projectDirOf(entry.plainFile), entry.moduleName);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const exported = spawnSync(
    "bash",
    ["-o", "pipefail", "-c", 'git --git-dir "$1" archive --format=tar "$2" | tar -x -f - -C "$3"', "export", join(moduleDir, HISTORY_DIR), `${commit}:code`, dir],
    { encoding: "utf8" },
  );
  if (exported.status !== 0) throw new Error(`Could not export ${entry.moduleName}'s code at ${commit.slice(0, 8)}: ${(exported.stderr ?? "").trim()}`);
  for (const file of [RECORD_FILE, NOTES_FILE]) rmSync(join(dir, file), { force: true });

  const [short, subject, when] = git(moduleDir, ["log", "-1", "--format=%h%x1f%s%x1f%cr", commit]).stdout.trim().split("\x1f");
  const unfinished = git(moduleDir, ["status", "--porcelain", "--untracked-files=all", "--", "code"]).stdout.trim() !== "";
  return {
    moduleName: entry.moduleName,
    plainFile: entry.plainFile,
    way: "dist",
    dir,
    buildDir: entry.buildDir,
    commit: short ?? commit.slice(0, 8),
    subject: subject ?? "",
    when: when ?? "",
    unfinished,
    ...(instead !== undefined ? { instead } : {}),
  };
}

/**
 * The host codebase a guided release works in: the git repository the project is in - an embedded project's host -
 * or else `fallback`, where turri runs.
 */
export function hostDirOf(plainFile: string, fallback: string): string {
  const top = spawnSync("git", ["-C", projectDirOf(plainFile), "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return top.status === 0 && top.stdout.trim() !== "" ? top.stdout.trim() : fallback;
}

/** Where a path is, said from the current directory when it is below it. */
export function shortPath(path: string): string {
  const fromHere = relative(process.cwd(), path);
  return fromHere === "" || fromHere.startsWith("..") ? path : fromHere;
}

/** What was deployed, in a line or three. */
export function describeDeployment(deployment: Deployment): string {
  return [
    `Deployed ${deployment.moduleName} to ${shortPath(deployment.dir)} - commit ${deployment.commit}, ${deployment.when}: ${deployment.subject}.`,
    ...(deployment.hostDir !== undefined ? [`Its guidance takes it on from there, in ${shortPath(deployment.hostDir)}.`] : []),
    ...(deployment.instead !== undefined ? [`${deployment.instead}, the module on top, has nothing built yet - this is ${deployment.moduleName}, the module below it.`] : []),
    ...(deployment.unfinished
      ? [
          deployment.hostDir === undefined
            ? "A pulse is at work on the module right now: what it has written so far is not finished, and is left out."
            : `A pulse is at work on the module right now: what it has written so far is not finished, and is left out of ${shortPath(deployment.dir)} - but ${shortPath(deployment.buildDir)} holds it, so take the code from ${shortPath(deployment.dir)}, never from there.`,
        ]
      : []),
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// What installs software.

/** Programs that install or fetch whatever they are asked to do. Asking only what version they are is fine. */
const INSTALLERS = new Set([
  "pip", "pip3", "pipx", "uv", "uvx", "poetry", "pipenv", "pdm", "conda", "mamba", "micromamba", "hatch",
  "npx", "bunx", "pnpx", "deno", "corepack", "volta", "nvm", "fnm", "n",
  "brew", "apt", "apt-get", "aptitude", "yum", "dnf", "pacman", "apk", "zypper", "port", "snap", "flatpak", "nix", "nix-env", "nix-shell",
  "gem", "bundle", "bundler", "rbenv", "rvm", "composer", "pecl", "cpan", "cpanm",
  "go", "cargo", "rustup", "dotnet", "nuget", "mvn", "mvnw", "gradle", "gradlew", "sbt", "lein", "sdk", "sdkmanager", "coursier", "cs",
  "asdf", "mise", "pyenv", "jenv", "sudo", "doas", "make", "gmake", "just", "task", "bazel",
]);

/** For these, the subcommands that install or fetch: the rest - run, start, test - only run what is there. */
const INSTALLING_SUBCOMMANDS: Record<string, Set<string>> = {
  npm: new Set(["install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "ci", "clean-install", "add", "update", "up", "upgrade", "udpate", "dlx", "exec", "x", "create", "init", "innit", "rebuild", "link", "ln", "cache", "install-test", "it", "install-ci-test", "cit"]),
  pnpm: new Set(["install", "i", "add", "update", "up", "upgrade", "dlx", "exec", "create", "init", "rebuild", "link", "fetch", "import", "env", "setup"]),
  yarn: new Set(["install", "add", "upgrade", "up", "dlx", "create", "init", "set", "plugin", "import", "link"]),
  bun: new Set(["install", "i", "add", "a", "update", "upgrade", "x", "create", "init", "link", "pm"]),
  docker: new Set(["pull", "build", "run", "create", "compose", "buildx", "load", "import", "plugin", "start", "up"]),
  podman: new Set(["pull", "build", "run", "create", "compose", "load", "import", "start"]),
  "docker-compose": new Set(["up", "pull", "build", "run", "create", "start"]),
  "podman-compose": new Set(["up", "pull", "build", "run", "create", "start"]),
};

/** `python -m <these>` installs. */
const INSTALLING_MODULES = new Set(["pip", "venv", "virtualenv", "ensurepip", "pipx", "poetry", "uv", "pdm", "conda"]);

/** Arguments that only ask a program about itself. */
const ONLY_ASKING = new Set(["--version", "-v", "-V", "version", "--help", "-h", "help", "env", "list", "ls", "--list", "config", "outdated", "info", "show", "doctor", "view"]);

/** Wrappers that run the command after them. */
const WRAPPERS = new Set(["env", "exec", "time", "nohup", "command", "nice", "setsid", "xargs", "caffeinate", "timeout", "stdbuf", "builtin"]);

const LOCAL_HOSTS = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|::1|host\.docker\.internal)$/;

function words(segment: string): string[] {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((word) => word.replace(/^["']|["']$/g, ""));
}

/** A URL to somewhere other than this machine: what a download reaches for. */
function remoteUrl(word: string): boolean {
  const match = /^(?:https?|ftp):\/\/([^/:?#]+|\[[^\]]+\])/i.exec(word);
  return match !== null && !LOCAL_HOSTS.test(match[1]!);
}

/** Whether one simple command installs or fetches software. */
function installingSegment(segment: string): boolean {
  let all = words(segment);
  // Past assignments and wrappers, to the program that runs.
  for (;;) {
    const first = all[0];
    if (first === undefined) return false;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) all = all.slice(1);
    else if (WRAPPERS.has(first)) {
      all = all.slice(1);
      // timeout 30 <command>, nice -n 5 <command>: their own arguments first.
      while (all[0] !== undefined && (/^-/.test(all[0]) || /^\d+[smhd]?$/.test(all[0]))) all = all.slice(1);
    } else break;
  }
  const [program, ...args] = all as [string, ...string[]];
  const name = basename(program);
  const asking = args.length > 0 && args.every((arg) => ONLY_ASKING.has(arg) || arg.startsWith("-"));

  if (INSTALLERS.has(name)) return !asking;
  const subcommands = INSTALLING_SUBCOMMANDS[name];
  if (subcommands !== undefined) {
    const sub = args.find((arg) => !arg.startsWith("-"));
    // A bare `yarn` installs; a bare `npm`, `bun` or `docker` prints its help.
    if (sub === undefined) return name === "yarn" && args.length === 0;
    if (sub === "compose" || sub === "buildx") {
      const next = args[args.indexOf(sub) + 1];
      return next !== undefined && !ONLY_ASKING.has(next) && next !== "ps" && next !== "logs" && next !== "down" && next !== "stop";
    }
    return subcommands.has(sub);
  }
  if (/^python(\d+(\.\d+)?)?$/.test(name) || name === "py") {
    const at = args.indexOf("-m");
    const module = at !== -1 ? args[at + 1] : undefined;
    if (module !== undefined && INSTALLING_MODULES.has(module)) return !args.slice(at + 2).every((arg) => ONLY_ASKING.has(arg));
    return false;
  }
  // Asking the app that runs here is how it is tried; fetching from anywhere else is a download.
  if (name === "curl" || name === "wget") return args.some(remoteUrl);
  // A project's own scripts install as often as they run: they are asked about like the rest.
  if (name.endsWith(".sh") || /(^|\/)scripts?\//.test(program)) return true;
  if ((name === "bash" || name === "sh" || name === "zsh") && args.some((arg) => arg.endsWith(".sh"))) return true;
  return false;
}

/**
 * Whether a shell command installs or fetches software - a package manager, a build that downloads
 * what it depends on, an image pull, a script fetched and piped to a shell - and so is the person's to
 * allow. Returns the part of it that does, or nothing when none does.
 *
 * Read the way a shell splits it - on `&&`, `||`, `;`, `|`, `&`, newlines and subshells - each simple
 * command on its own. A command that only asks a program what version it is installs nothing.
 */
export function installsSoftware(command: string): string | undefined {
  if (/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/.test(command)) return command.trim();
  if (/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?python\d*\b/.test(command)) return command.trim();
  const segments = command.split(/&&|\|\||[;|&\n()`]|\$\(/).map((part) => part.trim()).filter((part) => part !== "");
  return segments.find(installingSegment);
}

// ---------------------------------------------------------------------------------------------
// What runs on this machine.

export interface DeployedProcess {
  name: string;
  moduleName: string;
  command: string;
  /** Where it runs. */
  dir: string;
  url?: string;
  /** Its output, both streams. */
  log: string;
  pid: number;
  startedAt: number;
  /** Set once it has ended. */
  exited?: { code: number | null; signal: string | null };
}

const processes = new Map<string, { info: DeployedProcess; child: ChildProcess }>();

/** Everything deploy started, running or ended, oldest first. */
export function listDeployed(): DeployedProcess[] {
  return [...processes.values()].map((entry) => entry.info);
}

/** The ones still running. */
export function runningDeployed(moduleName?: string): DeployedProcess[] {
  return listDeployed().filter((info) => info.exited === undefined && (moduleName === undefined || info.moduleName === moduleName));
}

/** Where a project's deployed processes write their output: its scratch, not the code in dist. */
export function deployLogDir(projectDir: string): string {
  const scratch = join(projectDir, ".turri");
  return ensureInScratch(scratch, join(scratch, "deploy"));
}

/** The end of a log, for when something did not come up. */
export function logTail(log: string, lines = 40, chars = 4000): string {
  try {
    const text = readFileSync(log, "utf8").split("\n").slice(-lines).join("\n");
    return text.length > chars ? text.slice(-chars) : text;
  } catch {
    return "";
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    // Its own process group: the server and whatever it started.
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Stop one deployed process, or every one of a module, or every one: politely, then not. Returns the names stopped. */
export async function stopDeployed(which: { name?: string; moduleName?: string } = {}): Promise<string[]> {
  const targets = [...processes.values()].filter(
    ({ info }) => info.exited === undefined && (which.name === undefined || info.name === which.name) && (which.moduleName === undefined || info.moduleName === which.moduleName),
  );
  for (const { info } of targets) signalGroup(info.pid, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && targets.some(({ info }) => info.exited === undefined)) await sleep(100);
  for (const { info } of targets) if (info.exited === undefined) signalGroup(info.pid, "SIGKILL");
  return targets.map(({ info }) => info.name);
}

/** Stop everything at once, without waiting: for when turri itself is going. */
export function stopAllDeployedNow(): void {
  for (const { info } of processes.values()) if (info.exited === undefined) signalGroup(info.pid, "SIGTERM");
}

let exitHooked = false;
function stopOnExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", stopAllDeployedNow);
}

function portOf(url: URL): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/** Whether something already answers on the port. */
function portTaken(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: host === "0.0.0.0" ? "127.0.0.1" : host.replace(/^\[|\]$/g, ""), port });
    const finish = (taken: boolean) => {
      socket.destroy();
      done(taken);
    };
    socket.setTimeout(700, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** What holds a port, as lsof says it - or nothing when it cannot say. */
function holderOf(port: number): string {
  const found = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim().split("\n").slice(0, 4).join("\n") : "";
}

async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

/** How long a server is given to answer at its URL, and to stay up when it has none. */
export const READY_TIMEOUT_MS = Number(process.env.TURRI_DEPLOY_READY_TIMEOUT ?? 60) * 1000;
const ALIVE_AFTER_MS = 4000;

export interface StartResult {
  ok: boolean;
  /** What happened, for the agent and the person. */
  text: string;
  process?: DeployedProcess;
}

/**
 * Start something that keeps running - a server, a frontend's dev server - in `dir`, on this machine,
 * in its own process group, its output to a log. One already running under the name is stopped first.
 *
 * With a URL, it is ready once something answers there - any answer - and not when it exits first or
 * nothing answers in time. A port something else holds already is said, with what holds it, and
 * nothing is started: an app moved to a port of the harness's choosing would not be the one the
 * person was told about. With no URL, it only has to still be running a few seconds on.
 */
export async function startDeployed(input: { name: string; command: string; dir: string; moduleName: string; logDir: string; url?: string }): Promise<StartResult> {
  await stopDeployed({ name: input.name });
  let url: URL | undefined;
  if (input.url !== undefined) {
    try {
      url = new URL(input.url);
    } catch {
      return { ok: false, text: `'${input.url}' is not a URL. Give the one it serves at, e.g. http://localhost:5173.` };
    }
    const port = portOf(url);
    if (await portTaken(url.hostname, port)) {
      const holder = holderOf(port);
      return {
        ok: false,
        text: `Port ${port} is in use already - by something turri did not start - so ${input.name} was not started.${holder !== "" ? `\n${holder}` : ""}\nTell the person which port and what holds it; do not move the app to another port.`,
      };
    }
  }

  mkdirSync(input.logDir, { recursive: true });
  const log = join(input.logDir, `${input.moduleName}-${input.name.replace(/[^\w.-]+/g, "-")}.log`);
  const fd = openSync(log, "w");
  const child = spawn("bash", ["-c", input.command], { cwd: input.dir, detached: true, stdio: ["ignore", fd, fd], env: process.env });
  closeSync(fd);
  if (child.pid === undefined) return { ok: false, text: `${input.name} could not be started.` };
  const info: DeployedProcess = { name: input.name, moduleName: input.moduleName, command: input.command, dir: input.dir, log, pid: child.pid, startedAt: Date.now(), ...(input.url !== undefined ? { url: input.url } : {}) };
  child.on("exit", (code, signal) => {
    info.exited = { code, signal };
  });
  child.on("error", () => {
    info.exited ??= { code: null, signal: null };
  });
  processes.set(input.name, { info, child });
  stopOnExit();

  const failed = (why: string): StartResult => {
    const tail = logTail(log);
    return { ok: false, text: `${input.name} ${why}.${tail !== "" ? `\nThe end of its output (${shortPath(log)}):\n${tail}` : ""}`, process: info };
  };
  const ended = () => `exited${info.exited?.code !== null && info.exited?.code !== undefined ? ` with ${info.exited.code}` : ""} before it was ready`;

  if (url === undefined) {
    await sleep(ALIVE_AFTER_MS);
    if (info.exited !== undefined) return failed(ended());
    return { ok: true, text: `${input.name} is running (pid ${info.pid}); its output is in ${shortPath(log)}.`, process: info };
  }
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (info.exited !== undefined) return failed(ended());
    if (await answers(url.href)) return { ok: true, text: `${input.name} is up at ${url.href} (pid ${info.pid}); its output is in ${shortPath(log)}.`, process: info };
    await sleep(1000);
  }
  return failed(`is running, but nothing answered at ${url.href} in ${Math.round(READY_TIMEOUT_MS / 1000)}s`);
}

/** Run a one-off command in `dir`, on this machine, to the end: setup the person agreed to. */
export function runHostCommand(dir: string, command: string, options: { timeoutMs?: number; onOutput?: (text: string) => void; signal?: AbortSignal } = {}): Promise<{ exitCode: number; output: string }> {
  return new Promise((done) => {
    const child = spawn("bash", ["-c", command], { cwd: dir, env: { ...process.env, CI: process.env.CI ?? "1" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "";
    const take = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output = (output + text).slice(-200_000);
      options.onOutput?.(text);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const stop = () => child.pid !== undefined && signalGroup(child.pid, "SIGTERM");
    const timer = setTimeout(() => {
      output += `\n[stopped after ${Math.round((options.timeoutMs ?? 0) / 1000)}s]`;
      stop();
    }, options.timeoutMs ?? 20 * 60 * 1000);
    options.signal?.addEventListener("abort", stop, { once: true });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ exitCode: code ?? 1, output });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ exitCode: 1, output: `${output}${error.message}` });
    });
  });
}
