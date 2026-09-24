import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { join, resolve } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { createHttpHooks, RealFSProvider, resolveImageSelector, VM } from "@earendil-works/gondolin";
import { qemuInstalled, qemuInstallHint } from "../environment.ts";
import { ensureInVmScratch, modulesRootOf, vmScratchDir } from "./paths.ts";

/**
 * Where every command runs: one Gondolin micro-VM per project, holding the project's
 * `plain_modules` and nothing else.
 *
 * A command is a string, and no reading of it says what it will touch. So instead of trying
 * to fence a shell on the host, the command runs in a small Linux VM whose only view of the
 * machine is `plain_modules`, mounted read-write at the path it has on the host. Everything
 * else - the specs above it, the home directory, other projects - does not exist in there. The
 * network reaches the package registries and nothing else.
 *
 * What the VM needs beside the code sits in `plain_modules/.plainwright`: the package caches, so
 * a dependency is fetched once; the copies test runs happen in; and the system packages the
 * agents installed, which every VM of the project installs again when it starts, so what one
 * render set up is there for the next.
 *
 * The guest is plainwright's own image, built from `vm/image.json` (`plainwright vm-image`):
 * Python, Node, Java, Go, Rust and C/C++ toolchains with their build tools, and git. Without it
 * the stock Gondolin image is used - see STOCK_IMAGE for what that can and cannot do.
 *
 * There is no fallback: where a VM cannot be started, the command is refused rather than run
 * unfenced.
 */

export interface VmRunResult {
  exitCode: number;
  output: string;
}

/** Where package managers keep their caches, inside the VM's own root. */
export function packageCacheDir(dir: string): string {
  return join(vmScratchDir(dir), "cache");
}

function cacheEnv(cache: string): Record<string, string> {
  return {
    XDG_CACHE_HOME: cache,
    MAVEN_OPTS: `-Dmaven.repo.local=${join(cache, "m2")}`,
    GRADLE_USER_HOME: join(cache, "gradle"),
    CARGO_HOME: join(cache, "cargo"),
    npm_config_cache: join(cache, "npm"),
    YARN_CACHE_FOLDER: join(cache, "yarn"),
    PIP_CACHE_DIR: join(cache, "pip"),
    UV_CACHE_DIR: join(cache, "uv"),
    GOCACHE: join(cache, "go-build"),
    GOMODCACHE: join(cache, "go-mod"),
  };
}

/** Hosts a VM may reach: the package registries, plus any named in PLAINWRIGHT_ALLOWED_HOSTS. */
const REGISTRIES = [
  "dl-cdn.alpinelinux.org",
  "pypi.org",
  "files.pythonhosted.org",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "proxy.golang.org",
  "sum.golang.org",
  "index.crates.io",
  "static.crates.io",
  "crates.io",
  "repo.maven.apache.org",
  "repo1.maven.org",
  "services.gradle.org",
  "downloads.gradle.org",
  "plugins.gradle.org",
  "plugins-artifacts.gradle.org",
];

function allowedHosts(): string[] {
  const extra = (process.env.PLAINWRIGHT_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  return [...REGISTRIES, ...extra];
}

const JAVA_HOME = "/usr/lib/jvm/java-21-openjdk";

/**
 * The environment a command gets. Only this: the host's environment is not passed through,
 * because it holds the provider's API keys and whatever else is in the person's shell.
 */
function guestEnv(cache: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: `${JAVA_HOME}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    HOME: "/root",
    JAVA_HOME,
    LANG: "C.UTF-8",
    ...cacheEnv(cache),
    ...extra,
  };
}

/** The image plainwright builds; PLAINWRIGHT_VM_IMAGE names another. */
export const VM_IMAGE = "plainwright:latest";

/**
 * What the stock Gondolin image can and cannot do - the one used until the full image is
 * built - said the same way everywhere it comes up: setup, doctor, the session banner, the
 * agents' own instructions. Measured, not guessed: project dependencies install into the
 * project folder, which is on the host's disk, so they fit; the VM's own disk has about 80 MB
 * free, which a system package like jq fits in and a compiler or a JDK does not.
 */
export const STOCK_IMAGE = {
  short: "stock image - Python and Node projects only: no compilers, git, Java, Go or Rust",
  details: [
    "works:   Python 3.12 (venv, pip, uv) and Node 24 (npm) projects - their dependencies",
    "         install into the project, so there is room for them",
    "missing: C/C++ compilers and make, git, Java, Go, Rust",
    "so:      a Java, Go, Rust or C/C++ project cannot be built;",
    "         Python or npm packages that must compile native code fail to install;",
    "         only small system packages can be added (about 80 MB free) - not a compiler or JDK",
  ],
  fix: "plainwright vm-image   (builds the full image with e2fsprogs, or in Docker; about 7 minutes, 2 GB)",
};

/** The guest image to boot, if it has been built; otherwise the stock one. */
export function vmImage(): { tag: string; path: string } | undefined {
  const tag = process.env.PLAINWRIGHT_VM_IMAGE ?? VM_IMAGE;
  try {
    return { tag, path: resolveImageSelector(tag).assetDir };
  } catch {
    return undefined;
  }
}

/** Room for dependencies and build output, and for compilers to run. */
const VM_DISK = process.env.PLAINWRIGHT_VM_DISK ?? "8G";
const VM_MEMORY = process.env.PLAINWRIGHT_VM_MEMORY ?? "2G";
const VM_CPUS = Number(process.env.PLAINWRIGHT_VM_CPUS ?? 2);

const REGULAR_FILE = 0o100000;
const FILE_TYPE = 0o170000;

function executable(stats: Stats): Stats {
  if ((stats.mode & FILE_TYPE) === REGULAR_FILE) stats.mode |= 0o111;
  // Owned by root, who runs everything in the VM - not by the host user's uid.
  stats.uid = 0;
  stats.gid = 0;
  return stats;
}

/**
 * The host folder, with every regular file executable and owned by root.
 *
 * Gondolin's mounts cannot carry a mode change: a `chmod +x` is dropped, and what a compiler
 * writes lands as 0644, so a built binary, a `./gradlew` or a test script would not run. The
 * VM holds nothing but this folder, so marking its files executable gives nothing away.
 *
 * And they would show the host user's uid, while everything in the VM runs as root. Tools that
 * check who owns a file then refuse it: a JVM ignores an attach request whose trigger file,
 * written to its working directory, is not its own - which breaks Mockito's inline mocks and
 * anything else that attaches an agent - and git calls such a repository dubious.
 */
class ExecutableFSProvider extends RealFSProvider {
  override async stat(path: string, options?: object): Promise<Stats> {
    return executable(await super.stat(path, options));
  }

  override async lstat(path: string, options?: object): Promise<Stats> {
    return executable(await super.lstat(path, options));
  }

  override async open(path: string, flags: string, mode?: number) {
    const handle = await super.open(path, flags, mode);
    const stat = handle.stat.bind(handle);
    handle.stat = async (options?: object) => executable(await stat(options));
    return handle;
  }
}

/** One VM per modules root, started on first use and kept until the process ends. */
const pool = new Map<string, Promise<VM>>();

async function start(root: string): Promise<VM> {
  const cache = packageCacheDir(root);
  ensureInVmScratch(root, join(cache, "apk"));
  const image = vmImage();
  const { httpHooks } = createHttpHooks({ allowedHosts: allowedHosts() });
  const vm = await VM.create({
    vfs: { mounts: { [root]: new ExecutableFSProvider(root) } },
    httpHooks,
    sessionLabel: "plainwright",
    memory: VM_MEMORY,
    cpus: VM_CPUS,
    // The stock image cannot grow its disk, so only ours is given more.
    ...(image ? { sandbox: { imagePath: image.path }, rootfs: { size: VM_DISK } } : {}),
  });
  // Alpine keeps what it downloads when /etc/apk/cache exists, so the packages installed
  // again at every start come from the project's cache rather than the network.
  const setup = [`ln -sfn ${join(cache, "apk")} /etc/apk/cache`];
  const packages = systemPackages(root);
  if (packages.length > 0) setup.push(`apk add --no-progress ${packages.join(" ")}`);
  await exec(vm, setup.join(" && "), { cwd: root, env: guestEnv(cache) });
  return vm;
}

async function acquire(dir: string): Promise<{ vm: VM; root: string }> {
  const root = modulesRootOf(dir);
  let vm = pool.get(root);
  if (vm === undefined) {
    vm = start(root);
    pool.set(root, vm);
    // A VM that failed to start is not kept: the next command tries again.
    vm.catch(() => pool.delete(root));
  }
  try {
    return { vm: await vm, root };
  } catch (error) {
    throw new Error(
      `The command could not be run: its sandbox VM did not start (${error instanceof Error ? error.message : String(error)}). ` +
        "Commands are only ever run inside one. Run `plainwright doctor` to see what is missing.",
    );
  }
}

async function exec(
  vm: VM,
  command: string,
  options: { cwd: string; env: Record<string, string>; signal?: AbortSignal; onData?: (data: Buffer) => void },
): Promise<VmRunResult> {
  // Not a login shell: Alpine's /etc/profile would replace the PATH given here.
  const proc = vm.exec(["/bin/bash", "-c", command], {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    stdout: "pipe",
    stderr: "pipe",
  });
  let output = "";
  for await (const chunk of proc.output()) {
    const data = Buffer.isBuffer(chunk.data) ? chunk.data : Buffer.from(chunk.data);
    output += data.toString("utf8");
    options.onData?.(data);
  }
  const result = await proc;
  return { exitCode: result.exitCode ?? 1, output };
}

/** Run a command in the project's VM, from `cwd` - which must lie inside what the VM holds. */
export async function runInVm(
  command: string,
  options: { cwd: string; timeoutMs?: number; signal?: AbortSignal; onData?: (data: Buffer) => void; env?: Record<string, string> },
): Promise<VmRunResult> {
  const { vm, root } = await acquire(options.cwd);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer =
    options.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, options.timeoutMs)
      : undefined;
  let output = "";
  try {
    return await exec(vm, command, {
      cwd: resolve(options.cwd),
      env: guestEnv(packageCacheDir(root), options.env),
      signal: controller.signal,
      onData: (data) => {
        output += data.toString("utf8");
        options.onData?.(data);
      },
    });
  } catch (error) {
    if (timedOut) return { exitCode: 124, output: `${output}\n[timed out after ${Math.round((options.timeoutMs ?? 0) / 1000)}s]` };
    if (options.signal?.aborted) throw new Error("aborted");
    return { exitCode: 1, output: `${output}${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

function packagesFile(dir: string): string {
  return join(vmScratchDir(dir), "system-packages.json");
}

/** The system packages installed in this project's VM, installed again whenever one starts. */
export function systemPackages(dir: string): string[] {
  const file = packagesFile(dir);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { packages?: unknown };
    return Array.isArray(parsed.packages) ? parsed.packages.filter((name): name is string => typeof name === "string") : [];
  } catch {
    return [];
  }
}

/** An Alpine package name, optionally pinned: `openjdk17`, `ruby-dev`, `php83=8.3.1-r0`. */
const PACKAGE_NAME = /^[a-z0-9][a-z0-9+._-]*([<>=~]{1,2}[a-z0-9+._-]+)?$/;

/**
 * Install system packages with `apk` in the project's VM, and remember them so every VM the
 * project starts has them too. Nothing is remembered from an install that failed.
 */
export async function installSystemPackages(
  dir: string,
  packages: string[],
  options: { signal?: AbortSignal; onData?: (data: Buffer) => void } = {},
): Promise<VmRunResult> {
  const names = [...new Set(packages.map((name) => name.trim()).filter(Boolean))];
  if (names.length === 0) return { exitCode: 1, output: "No packages named." };
  const invalid = names.filter((name) => !PACKAGE_NAME.test(name));
  if (invalid.length > 0) return { exitCode: 1, output: `Not an Alpine package name: ${invalid.join(", ")}` };
  const root = modulesRootOf(dir);
  const result = await runInVm(`apk add --no-progress ${names.join(" ")}`, { cwd: root, ...options });
  if (result.exitCode === 0) {
    const all = [...new Set([...systemPackages(root), ...names])].sort();
    writeFileSync(packagesFile(root), `${JSON.stringify({ packages: all }, null, 2)}\n`);
  }
  return result;
}

/** What an agent is told about where its commands run. */
export function vmEnvironmentNote(): string {
  const where = "Commands run in an Alpine Linux VM that holds only plain_modules; nothing else of the machine exists in it.";
  const network = "The network reaches the package registries only.";
  if (vmImage() === undefined) {
    // The stock image: say what it cannot do, so a project it cannot build is reported, not fought.
    return [
      where,
      "Installed: Python 3.12 (venv, pip inside a venv, uv) and Node 24 (npm). Project dependencies go through the " +
        "project's own package manager and install into the project, as usual.",
      "Not installed, and not installable here: C/C++ compilers and make, git, Java, Go, Rust. The VM's own disk has " +
        "about 80 MB free - install_system_packages fits small Alpine packages (jq, sqlite), never a compiler or JDK.",
      "If the project needs any of those - or a Python or npm package that has to compile native code - do not " +
        "try to work around it: say plainly that it needs plainwright's full VM image, built with " +
        "`plainwright vm-image`.",
      network,
    ].join(" ");
  }
  return (
    `${where} Installed: Python 3 (pip, uv), Node (npm), Java 21 (Maven, Gradle), Go, Rust (cargo), C/C++ (gcc, ` +
    "make, cmake) and git. A language, compiler or system library that is missing is installed with " +
    "install_system_packages (Alpine packages), which keeps it for every later render; project dependencies go " +
    `through the project's own package manager as usual. ${network}`
  );
}

/** pi's bash tool, running in the project's VM. */
export function vmBashOperations(): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout }) => {
      const result = await runInVm(command, {
        cwd,
        signal,
        onData,
        timeoutMs: timeout && timeout > 0 ? timeout * 1000 : undefined,
      });
      return { exitCode: result.exitCode };
    },
  };
}

/**
 * Where commands will run, in one line for the person: which image, or why there is no VM.
 * `level` says whether that is fine, a limit, or a stop.
 */
export function vmSummary(): { level: "ok" | "limited" | "missing"; text: string } {
  if (!vmSupported()) return { level: "missing", text: `no sandbox VM on ${process.platform}/${process.arch} - agents get no shell` };
  if (!qemuInstalled()) return { level: "missing", text: `no sandbox VM: QEMU is not installed (${qemuInstallHint()}) - run plainwright doctor` };
  const image = vmImage();
  return image
    ? { level: "ok", text: `commands run in a sandbox VM holding only plain_modules (${image.tag})` }
    : { level: "limited", text: `commands run in a sandbox VM, ${STOCK_IMAGE.short} (plainwright vm-image builds the full one)` };
}

/** Whether a VM can be started on this machine: Apple Silicon, or Linux. */
export function vmSupported(): boolean {
  return (process.platform === "darwin" && process.arch === "arm64") || process.platform === "linux";
}

/** Close every VM. Called as the process ends; they would otherwise outlive it. */
export async function closeAllVms(): Promise<void> {
  const vms = [...pool.values()];
  pool.clear();
  await Promise.all(vms.map((vm) => vm.then((v) => v.close()).catch(() => {})));
}

/**
 * Gondolin kills its VMs as the process exits, but a process ended by a signal never exits in
 * that sense, and its VMs would run on with no one to stop them. So where nothing else handles
 * the signal, exit properly on it.
 */
for (const [signal, code] of [["SIGTERM", 143], ["SIGHUP", 129]] as const) {
  process.once(signal, () => {
    if (process.listenerCount(signal) === 0) process.exit(code);
  });
}
