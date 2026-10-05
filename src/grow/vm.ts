import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { freemem } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { createHttpHooks, getImageStoreDirectory, ReadonlyProvider, RealFSProvider, resolveImageSelector, VM } from "@earendil-works/gondolin";
import { qemuInstalled, qemuInstallHint } from "../environment.ts";
import { currentStopSignal, offTheTurnClock, reportNote } from "./activity.ts";
import { credentialFiles, credentialRefusal, restoreCredentialFiles } from "./credentials.ts";
import { ensureInVmScratch, MODULES_DIR, modulesRootOf, projectRootOf, vmScratchDir } from "./paths.ts";
import { readProjectConfig } from "../config.ts";
import { hasProjectImage, imagePlan, projectImageTag } from "../vm-image.ts";
import { legacyImageTag } from "../legacy.ts";

/**
 * Where every command runs: a Gondolin micro-VM for the module it works in, holding that
 * module's folder in `plain_modules` and nothing else of the project but its VM scratch.
 *
 * A command is a string, and no reading of it says what it will touch. So instead of trying
 * to fence a shell on the host, the command runs in a small Linux VM whose only view of the
 * machine is `plain_modules/<module>` and `plain_modules/.turri`, mounted read-write at the
 * paths they have on the host. Everything else - the other modules, the specs above them, the
 * home directory, other projects - does not exist in there. The network is open - the web and
 * this machine's localhost (see HOST_ALIAS); the files are what is fenced.
 *
 * What the VM needs beside the code sits in `plain_modules/.turri`: the package caches, so
 * a dependency is fetched once; the copies test runs happen in; and the system packages the
 * agents installed, which every VM of the project installs again when it starts, so what one
 * render set up is there for the next.
 *
 * The guest is turri's own image, built from `vm/image.json` (`turri vm-image`):
 * Python, Node, Java, Go, Rust and C/C++ toolchains with their build tools, and git. Without it
 * the stock Gondolin image is used - see STOCK_IMAGE for what that can and cannot do.
 *
 * There is no fallback: where a VM cannot be started, the command is refused rather than run
 * unfenced.
 */

export interface VmRunResult {
  exitCode: number;
  output: string;
  /** Stopped by its time limit, rather than ending on its own. */
  timedOut?: boolean;
}

// The package caches are the agents' environment's (agent-env.ts), wherever their commands run.
export { packageCacheDir } from "./agent-env.ts";
import { cacheEnv, packageCacheDir } from "./agent-env.ts";

/**
 * The network is open: a command reaches any host on the web, internal addresses included, and
 * this machine's localhost - a storage service or a mock API the tests talk to, running here.
 *
 * The web goes through Gondolin's HTTP(S) proxy, which lets everything through. This machine is
 * reached at HOST_ALIAS, on any port, mapped to its 127.0.0.1. And `localhost` in the VM is both:
 * every connection to it goes through a small proxy in the VM (LOCALHOST_PROXY) that connects to
 * a server the VM itself runs on that port - the app under test - and to this machine's when there
 * is none. So a spec that says a service is at `http://localhost:6000` means what it says.
 */
const HOST_ALIAS = "host.turri.internal";
const HOST_PORTS: Record<string, string> = Object.fromEntries(
  Array.from({ length: 65535 }, (_, index) => [`${HOST_ALIAS}:${index + 1}`, `127.0.0.1:${index + 1}`]),
);
/** Where the localhost proxy listens in the VM; connections to it are never redirected. */
const PROXY_PORT = 65081;
/** The mark on the proxy's own connections: they go where they are addressed, not back to it. */
const PROXY_MARK = 0x706c;

const LOCALHOST_PROXY = String.raw`
import asyncio, socket, struct
SO_ORIGINAL_DST = 80
SO_MARK = 36

def original_port(sock):
    try:
        if sock.family == socket.AF_INET6:
            return struct.unpack_from("!H", sock.getsockopt(socket.IPPROTO_IPV6, SO_ORIGINAL_DST, 28), 2)[0]
        return struct.unpack_from("!H", sock.getsockopt(socket.SOL_IP, SO_ORIGINAL_DST, 16), 2)[0]
    except OSError:
        return None

async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass

async def connect(family, host, port):
    # Marked, so the redirect lets it through to where it is addressed.
    info = (await asyncio.get_running_loop().getaddrinfo(host, port, family=family, type=socket.SOCK_STREAM))[0]
    sock = socket.socket(info[0], socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, SO_MARK, ${PROXY_MARK})
    sock.setblocking(False)
    try:
        await asyncio.get_running_loop().sock_connect(sock, info[4])
    except OSError:
        sock.close()
        raise
    return await asyncio.open_connection(sock=sock)

async def handle(reader, writer):
    sock = writer.get_extra_info("socket")
    port = original_port(sock)
    if port is None:
        writer.close()
        return
    # A server in the VM on that port, on either loopback address - localhost is both - and
    # this machine's when there is none.
    local = [(socket.AF_INET6, "::1"), (socket.AF_INET, "127.0.0.1")]
    if sock.family == socket.AF_INET:
        local.reverse()
    upstream = None
    for family, host in [*local, (socket.AF_INET, "${HOST_ALIAS}")]:
        try:
            upstream = await connect(family, host, port)
            break
        except OSError:
            pass
    if upstream is None:
        writer.close()
        return
    await asyncio.gather(pipe(reader, upstream[1]), pipe(upstream[0], writer))

async def main():
    servers = []
    for host in ("127.0.0.1", "::1"):
        try:
            servers.append(await asyncio.start_server(handle, host, ${PROXY_PORT}))
        except OSError:
            pass
    open("/tmp/turri-localhost.ready", "w").close()
    await asyncio.gather(*(server.serve_forever() for server in servers))

asyncio.run(main())
`;

/** Make `localhost` in the VM reach this machine too, for ports the VM itself does not serve. */
function localhostSetup(): string {
  const rule = (tool: string, address: string) =>
    `${tool} -t nat -A OUTPUT -o lo -p tcp -d ${address} ! --dport ${PROXY_PORT} -m mark ! --mark ${PROXY_MARK} -j REDIRECT --to-ports ${PROXY_PORT}`;
  return [
    "set -e",
    "command -v iptables > /dev/null || apk add --no-progress iptables ip6tables > /dev/null",
    `cat > /usr/local/lib/turri-localhost.py <<'TURRI_PROXY'\n${LOCALHOST_PROXY}\nTURRI_PROXY`,
    "(setsid python3 /usr/local/lib/turri-localhost.py > /tmp/turri-localhost.log 2>&1 &)",
    // Redirected only once it listens: before, a connection to localhost would find nothing.
    "for i in $(seq 100); do [ -f /tmp/turri-localhost.ready ] && break; sleep 0.05; done",
    "[ -f /tmp/turri-localhost.ready ] || { cat /tmp/turri-localhost.log; echo 'the localhost proxy did not start'; exit 1; }",
    rule("iptables", "127.0.0.1"),
    `${rule("ip6tables", "::1")} || true`,
  ].join("\n");
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

/** The image turri builds; TURRI_VM_IMAGE names another. */
export const VM_IMAGE = "turri:latest";

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
  fix: "turri vm-image   (builds the full image with e2fsprogs, or in Docker; about 7 minutes, 2 GB)",
};

/** The guest image to boot, if it has been built; otherwise the stock one. */
export function vmImage(): { tag: string; path: string } | undefined {
  const tag = process.env.TURRI_VM_IMAGE ?? VM_IMAGE;
  // Built before turri had its name, it is booted until the image is built again.
  for (const candidate of process.env.TURRI_VM_IMAGE !== undefined ? [tag] : [tag, legacyImageTag(tag)]) {
    try {
      return { tag: candidate, path: resolveImageSelector(candidate).assetDir };
    } catch {
      /* not built under this tag */
    }
  }
  return undefined;
}

/**
 * The image a project's VMs run: its own, when its config.yaml asks for one and it is built - else the
 * default, saying why when it has one that is not built yet. TURRI_VM_IMAGE wins over both.
 */
export function vmImageFor(project: string): { tag: string; path: string; own: boolean; missing?: string } | undefined {
  if (process.env.TURRI_VM_IMAGE === undefined && hasProjectImage(project)) {
    const tag = projectImageTag(project);
    try {
      return { tag, path: resolveImageSelector(tag).assetDir, own: true };
    } catch {
      /* not built under its tag now: perhaps under the one it had before */
    }
    try {
      return { tag: legacyImageTag(tag), path: resolveImageSelector(legacyImageTag(tag)).assetDir, own: true };
    } catch {
      const fallback = vmImage();
      const missing = `this project's own VM image (${tag}) is not built yet - turri vm-image, run in the project, builds it`;
      return fallback !== undefined ? { ...fallback, own: false, missing } : undefined;
    }
  }
  const image = vmImage();
  return image !== undefined ? { ...image, own: false } : undefined;
}

/** Room for dependencies and build output, and for compilers to run. */
const VM_DISK = process.env.TURRI_VM_DISK ?? "8G";
/** A VM's memory unless the project says (vm-memory) or TURRI_VM_MEMORY does: room for a project's dependencies to install. */
const DEFAULT_VM_MEMORY = "2G";
const VM_CPUS = Number(process.env.TURRI_VM_CPUS ?? 4);

/** A size as the VM takes it - "2G", "512M" - in bytes. */
function bytesOf(size: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([KMGT]?)i?B?$/i.exec(size.trim());
  if (match === null) return 2 * 1024 ** 3;
  const power = { "": 0, K: 1, M: 2, G: 3, T: 4 }[match[2]!.toUpperCase() as "" | "K" | "M" | "G" | "T"];
  return Number(match[1]) * 1024 ** power;
}

/** The memory each of a project's VMs is given: TURRI_VM_MEMORY, else its config.yaml's vm-memory, else 2G. */
export function vmMemoryFor(dir: string): string {
  const configured = process.env.TURRI_VM_MEMORY ?? readProjectConfig(projectRootOf(dir)).vmMemory;
  return configured !== undefined && /^\d+(?:\.\d+)?\s*[KMGT]?i?B?$/i.test(configured.trim()) ? configured.trim() : DEFAULT_VM_MEMORY;
}

/**
 * The memory this machine can give a VM now, in bytes: what is free and what the system takes back at once - on
 * Linux its own MemAvailable; on macOS free, inactive, speculative and purgeable pages, as vm_stat counts them.
 * Node's freemem() says less on macOS, leaving out what it would reclaim; it is the fallback.
 */
export function availableMemory(): number {
  try {
    if (process.platform === "linux") {
      const line = /^MemAvailable:\s+(\d+)\s+kB/m.exec(readFileSync("/proc/meminfo", "utf8"));
      if (line !== null) return Number(line[1]) * 1024;
    }
    if (process.platform === "darwin") {
      const out = spawnSync("vm_stat", { encoding: "utf8", timeout: 5000 }).stdout ?? "";
      const page = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 4096);
      const count = (name: string) => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
      const pages = count("free") + count("inactive") + count("speculative") + count("purgeable");
      if (pages > 0) return pages * page;
    }
  } catch {
    /* the fallback */
  }
  return freemem();
}

/** A size in bytes, as a person reads it: "3.1 GB". */
function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * How many jobs this machine runs at once, by default: each job's module may have two VMs - its code's and its
 * tests' - of `memory` each, and three quarters of the memory free now is theirs to take - not of what the machine
 * has: a machine already swapping would start every VM out of swap, minutes instead of seconds. At least one.
 */
export function defaultParallelJobs(memory: string = DEFAULT_VM_MEMORY): number {
  return Math.max(1, Math.floor((availableMemory() * 0.75) / (2 * bytesOf(memory))));
}

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
 * check who owns a file then refuse it: a runtime attaching to itself ignores a trigger file in
 * its working directory that is not its own, and git calls such a repository dubious.
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

// The time limits are the host runner's (shell.ts): the same for a command wherever it runs.
export { COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS, timedOutNote } from "./shell.ts";
import { COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS, timedOutNote } from "./shell.ts";

/**
 * One VM per module: it holds `plain_modules/<module>` and the project's VM scratch
 * (`plain_modules/.turri` - the package caches, and the copies test runs happen in), and
 * nothing of the other modules.
 *
 * A project works through its modules one at a time, and so has one VM at a time: the jobs of a
 * module - its functionalities, its spec changes, its conformance tests - reuse it one after
 * another, and the moment the project starts on another module, the old one's VM is shut down and
 * the new one's started. What a VM set up survives that: the system packages are installed again
 * from the cache, the dependencies are in the module's folder. Modules of one project rendering at
 * once each keep their own; several projects never share one.
 *
 * A job holds its module's VM (`withVmLease`) until it ends or moves on to another module. One no
 * job holds is idle: shut down when its project moves on, or after VM_IDLE_MS with nothing to do.
 */
interface PoolEntry {
  /** The modules root it belongs to. */
  project: string;
  /** The module it is for - a module has two: its code's and its tests'. */
  module: string;
  vm: Promise<VM>;
  /** Jobs working in it. */
  holders: number;
  /** Commands running in it. */
  running: number;
  idle?: ReturnType<typeof setTimeout>;
}
const pool = new Map<string, PoolEntry>();

/** The VMs the current job holds, by project: the module it works in, and which of its VMs it has used. */
const lease = new AsyncLocalStorage<Map<string, { module: string; keys: Set<string> }>>();

let idleMs = 60_000;

/** For tests: shut idle VMs down sooner, or at once (0). */
export function setVmIdleForTests(ms: number | undefined): void {
  idleMs = ms ?? 60_000;
}

/**
 * Run `work` - a job - holding the VM of the module it works in, and let go of it when it ends,
 * however it ends.
 */
export async function withVmLease<T>(work: () => Promise<T>): Promise<T> {
  const held = new Map<string, { module: string; keys: Set<string> }>();
  try {
    return await lease.run(held, work);
  } finally {
    for (const { keys } of held.values()) for (const key of keys) letGo(key);
  }
}

function letGo(key: string): void {
  const entry = pool.get(key);
  if (entry === undefined) return;
  entry.holders -= 1;
  if (!isIdle(entry)) return;
  clearTimeout(entry.idle);
  entry.idle = setTimeout(() => void shutDown(key), idleMs);
  entry.idle.unref?.();
}

function isIdle(entry: PoolEntry): boolean {
  return entry.holders <= 0 && entry.running <= 0;
}

async function shutDown(key: string): Promise<void> {
  const entry = pool.get(key);
  if (entry === undefined) return;
  pool.delete(key);
  clearTimeout(entry.idle);
  await entry.vm.then((vm) => vm.close()).catch(() => {});
}

/** A module's two folders, each with a VM of its own: the code, and the conformance tests. */
const MODULE_PARTS = new Set(["code", "tests"]);

/**
 * Which VM a command runs in, and what it holds. A module has two: one for its code folder -
 * where code is rendered, and the unit tests run - and one for its tests folder - where
 * conformance tests are rendered, and the conformance suite runs - each holding that folder and
 * the VM scratch. A command in one, or for one - a test run staged in the scratch - runs in its
 * VM. Anywhere else in a module, the module's folder is one of its own. One in the scratch alone
 * runs in whichever VM the project has, the job's own first. Outside any `plain_modules`, the
 * folder is a VM of its own, holding just that.
 */
function vmFor(dir: string, forDir?: string): { project: string; module: string; key: string; mounts: string[]; readOnly: string[] } {
  const project = modulesRootOf(dir);
  if (basename(project) !== MODULES_DIR) return { project, module: project, key: project, mounts: [project], readOnly: [] };
  const scratch = vmScratchDir(project);
  const [inside, part] = relative(project, resolve(forDir ?? dir)).split(sep);
  if (inside && inside !== ".." && inside !== basename(scratch)) {
    const module = join(project, inside);
    const folder = part !== undefined && MODULE_PARTS.has(part) ? join(module, part) : module;
    // The tests' VM holds the code too, read only: whoever writes or judges the tests can build and run
    // the software they test - from a copy, since the code itself cannot be written - and never change it.
    const code = join(module, "code");
    const withCode = part === "tests" && existsSync(code) ? [code] : [];
    return { project, module, key: folder, mounts: [folder, ...withCode, scratch], readOnly: withCode };
  }
  const own = lease.getStore()?.get(project);
  const mine = own !== undefined ? [...own.keys].find((key) => pool.has(key)) : undefined;
  const existing = mine ?? [...pool.keys()].find((key) => pool.get(key)!.project === project);
  if (existing !== undefined) return { project, module: pool.get(existing)!.module, key: existing, mounts: [], readOnly: [] };
  return { project, module: scratch, key: scratch, mounts: [scratch], readOnly: [] };
}

/** The folders a command run from `dir` can see but not change. */
export function vmReadOnly(dir: string): string[] {
  return vmFor(dir).readOnly;
}

/** What a command run from `dir` can see: the folders its VM holds. */
export function vmHolds(dir: string): string[] {
  return vmFor(dir).mounts;
}

async function start(project: string, mounts: string[], readOnly: string[] = []): Promise<VM> {
  const cache = packageCacheDir(project);
  ensureInVmScratch(project, join(cache, "apk"));
  const image = vmImageFor(projectRootOf(project));
  if (image?.missing !== undefined) reportNote(`  ${image.missing}; this VM runs ${image.tag} meanwhile`);
  const started = Date.now();
  const holds = mounts.map((mount) => relative(dirname(project), mount)).join(" and ");
  reportNote(`  starting the sandbox VM for ${holds} (${image ? image.tag : "stock image"}) - the first command waits for it`);
  // Every host, internal ones included: the network is open (see HOST_ALIAS).
  const { httpHooks } = createHttpHooks({ blockInternalRanges: false });
  // Short of memory, it starts out of swap - minutes, not seconds: said, so a slow start is no mystery.
  const memory = vmMemoryFor(project);
  const free = availableMemory();
  if (free < bytesOf(memory)) {
    reportNote(
      `  this machine has ${gigabytes(free)} free - less than the ${memory} a VM is given: it starts slowly, out of swap. Close other apps, or set vm-memory or parallel-jobs lower in config.yaml`,
    );
  }
  const vm = await VM.create({
    vfs: {
      mounts: Object.fromEntries(
        mounts.map((mount) => [mount, readOnly.includes(mount) ? new ReadonlyProvider(new ExecutableFSProvider(mount)) : new ExecutableFSProvider(mount)]),
      ),
    },
    httpHooks,
    // This machine's localhost, on any port: TCP mapping needs a name per host, so DNS is synthetic.
    dns: { mode: "synthetic", syntheticHostMapping: "per-host" },
    tcp: { hosts: HOST_PORTS },
    sessionLabel: "turri",
    memory,
    cpus: VM_CPUS,
    // The stock image cannot grow its disk, so only ours is given more.
    ...(image ? { sandbox: { imagePath: image.path }, rootfs: { size: VM_DISK } } : {}),
  });
  const created = Date.now();
  // Alpine keeps what it downloads when /etc/apk/cache exists, so the packages installed
  // again at every start come from the project's cache: offline first - every one is there once
  // it was installed - and from the network only for one that is not. Under a time limit: a
  // network that stalls must not hold every command of the job; the VM goes on without them.
  const setup = [`ln -sfn ${join(cache, "apk")} /etc/apk/cache`];
  // Every VM starts from its image as it was built: what the project's agents installed before, and config.yaml
  // names, is added again - only what the image does not have already.
  const wanted = systemPackages(project);
  const missing = packagesMissing(project, wanted);
  if (missing.length > 0) {
    reportNote(
      `  adding the system packages this project's agents installed before, which the image does not have: ${missing.join(", ")} - put them in config.yaml's vm-image and run turri vm-image to have them in the image`,
    );
    const list = missing.join(" ");
    setup.push(`{ apk add --no-network --no-progress ${list} >/dev/null 2>&1 || apk add --no-progress ${list}; }`);
  }
  const packages = missing;
  const limit = AbortSignal.timeout(VM_SETUP_TIMEOUT_MS);
  const ready = await exec(vm, setup.join(" && "), { cwd: mounts[0]!, env: guestEnv(cache), signal: limit }).catch((error: unknown) => ({ exitCode: -1, output: String(error) }));
  const booted = Date.now();
  if (limit.aborted) {
    reportNote(`  installing the project's system packages took over ${Math.round(VM_SETUP_TIMEOUT_MS / 1000)}s - given up: the VM goes on without them`);
  } else if (ready.exitCode !== 0 && packages.length > 0) {
    reportNote(`  the project's system packages did not all install: ${ready.output.trim().split("\n").at(-1) ?? ""}`);
  }
  // Running now - it boots on its first command: stopped with this process, however it ends - killed outright
  // too, which runs nothing on the way out.
  watchVmProcesses();
  const localhost = await exec(vm, localhostSetup(), { cwd: mounts[0]!, env: guestEnv(cache) });
  if (localhost.exitCode !== 0) {
    // The VM is still usable; only this machine's localhost is out of reach.
    reportNote(`  this machine's localhost could not be made reachable from the VM: ${localhost.output.trim().split("\n").at(-1) ?? ""}`);
  }
  // Where the time went, so a slow start can be told apart afterwards: the job's log keeps this line.
  const took = (from: number, to: number) => `${((to - from) / 1000).toFixed(1)}s`;
  const now = Date.now();
  reportNote(
    `  sandbox VM ready after ${took(started, now)} - created in ${took(started, created)}, booted${packages.length > 0 ? " and given its packages" : ""} in ${took(created, booted)}, localhost reachable in ${took(booted, now)}`,
  );
  return vm;
}

/**
 * The VM for a command, counted as running one until `done` is called. The job it runs for holds
 * it from now on; the project's other idle VMs are shut down - it has moved on.
 */
async function acquire(dir: string, forDir?: string, wait: { signals?: AbortSignal[]; timeoutMs?: number } = {}): Promise<{ vm: VM; project: string; done: () => void }> {
  const { project, module, key, mounts, readOnly } = vmFor(dir, forDir);
  let entry = pool.get(key);
  if (entry === undefined) {
    const created: PoolEntry = { project, module, vm: start(project, mounts, readOnly), holders: 0, running: 0 };
    entry = created;
    pool.set(key, created);
    // A VM that failed to start is not kept: the next command tries again.
    created.vm.catch(() => {
      if (pool.get(key) === created) pool.delete(key);
    });
  }
  const current = entry;
  clearTimeout(current.idle);
  current.idle = undefined;
  current.running += 1;

  // The job holds every VM of the module it works in - its code's and its tests' - and lets go of
  // them when it moves on to another module.
  const held = lease.getStore();
  if (held !== undefined) {
    let mine = held.get(project);
    if (mine !== undefined && mine.module !== current.module) {
      for (const previous of mine.keys) letGo(previous);
      mine = undefined;
    }
    if (mine === undefined) {
      mine = { module: current.module, keys: new Set() };
      held.set(project, mine);
    }
    if (!mine.keys.has(key)) {
      mine.keys.add(key);
      current.holders += 1;
    }
  }
  // The project has moved on to this module: another module's idle VMs go. This module's other one stays.
  for (const [other, candidate] of pool) {
    if (other !== key && candidate.project === project && candidate.module !== current.module && isIdle(candidate)) void shutDown(other);
  }

  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    current.running -= 1;
  };
  // Waited for no longer than a start can take, and not once it is stopped: the VM goes on starting, for the next one.
  let stopWaiting: (() => void) | undefined;
  const given = new Promise<never>((_, reject) => {
    const timer = wait.timeoutMs !== undefined ? setTimeout(() => reject(new VmWaitError(`its sandbox VM was still starting after ${Math.round(wait.timeoutMs! / 1000)}s`)), wait.timeoutMs) : undefined;
    // Stopped is "aborted", as for a command stopped once it runs: what stops it reads it so.
    const onAbort = () => reject(new Error("aborted"));
    for (const signal of wait.signals ?? []) signal.addEventListener("abort", onAbort, { once: true });
    stopWaiting = () => {
      if (timer !== undefined) clearTimeout(timer);
      for (const signal of wait.signals ?? []) signal.removeEventListener("abort", onAbort);
    };
  });
  given.catch(() => undefined);
  const waitStarted = Date.now();
  try {
    // The agent's turn does not pay for its VM starting: the clock on it stops meanwhile.
    const vm = await offTheTurnClock(Promise.race([current.vm, given]));
    const waited = Date.now() - waitStarted;
    if (waited >= 1000) reportNote(`  a command waited ${(waited / 1000).toFixed(1)}s for its sandbox VM - not counted in the agent's turn`);
    return { vm, project, done };
  } catch (error) {
    done();
    if (error instanceof Error && error.message === "aborted") throw error;
    if (error instanceof VmWaitError) throw new Error(`The command was not run: ${error.message}. Run it again - the VM keeps starting.`);
    throw new Error(
      `The command could not be run: its sandbox VM did not start (${error instanceof Error ? error.message : String(error)}). ` +
        "Commands are only ever run inside one. Run `turri doctor` to see what is missing.",
    );
  } finally {
    stopWaiting?.();
  }
}

/** A command that gave up waiting for its VM: stopped, or out of time. */
class VmWaitError extends Error {}

/**
 * The packages a project's VMs have from their image: what it was built from - turri's recipe, with the person's and
 * the project's changes. Not apk's own record, which the image builder does not fill: it unpacks the packages
 * itself, so apk knows only its base. None for the stock image, which none of them is in.
 */
function imagePackages(project: string): Set<string> {
  const image = vmImageFor(projectRootOf(project));
  if (image === undefined) return new Set();
  try {
    return new Set(imagePlan(image.own ? { project: projectRootOf(project) } : {}).packages);
  } catch {
    return new Set();
  }
}

/** Which of `packages` a project's VMs do not have from their image. */
function packagesMissing(project: string, packages: string[]): string[] {
  const have = imagePackages(project);
  return packages.filter((name) => !have.has(name.replace(/[<>=~].*$/, "")));
}

/** How long a VM's own setup - the project's system packages - may take before it goes on without them. */
const VM_SETUP_TIMEOUT_MS = Number(process.env.TURRI_VM_SETUP_TIMEOUT ?? 90) * 1000;

/** How long a command waits for its VM to start: booting, and its setup at most. */
const VM_START_WAIT_MS = VM_SETUP_TIMEOUT_MS + 60_000;

/**
 * Kill a command and everything it started - its children, a server it put in the background -
 * by the process ID it recorded. Each process is stopped before its children are looked for, so
 * nothing can start another in between.
 */
function killTreeScript(pidFile: string): string {
  return [
    `[ -f ${pidFile} ] || exit 0`,
    `root=$(cat ${pidFile}); rm -f ${pidFile}`,
    'children() { for stat in /proc/[0-9]*/stat; do read -r pid _ _ ppid _ < "$stat" 2>/dev/null && [ "$ppid" = "$1" ] && echo "$pid"; done; }',
    'kill_tree() { kill -STOP "$1" 2>/dev/null; for child in $(children "$1"); do kill_tree "$child"; done; kill -KILL "$1" 2>/dev/null; }',
    'kill_tree "$root"',
  ].join("\n");
}

async function exec(
  vm: VM,
  command: string,
  options: { cwd: string; env: Record<string, string>; signal?: AbortSignal; onData?: (data: Buffer) => void },
): Promise<VmRunResult> {
  // Gondolin's abort only gives up on a command: the process carries on in the guest. So the
  // command records its process ID, and a stop or a timeout kills it, and what it started, there.
  const pidFile = `/tmp/turri-exec-${randomUUID()}.pid`;
  const wrapped = `echo $$ > ${pidFile}; /bin/bash -c "$1"; status=$?; rm -f ${pidFile}; exit $status`;
  let killed: Promise<unknown> | undefined;
  const kill = () => {
    killed = Promise.resolve(vm.exec(["/bin/bash", "-c", killTreeScript(pidFile)])).catch(() => {});
  };
  options.signal?.addEventListener("abort", kill, { once: true });
  try {
    // Not a login shell: Alpine's /etc/profile would replace the PATH given here.
    const proc = vm.exec(["/bin/bash", "-c", wrapped, "turri", command], {
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
  } catch (error) {
    // Given up on: returned only once the command is gone from the guest too.
    await killed;
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", kill);
  }
}

/**
 * Run a command in the project's VM, from `cwd` - which must lie inside what the VM holds.
 *
 * Every command has a time limit, COMMAND_TIMEOUT_MS unless given another, and ends at once when
 * the job it runs for is stopped - the caller's signal or not.
 */
export async function runInVm(
  command: string,
  options: {
    cwd: string;
    timeoutMs?: number;
    /** What the output says when the time limit stops it; the note for a command, by default. */
    timeoutNote?: (timeoutMs: number) => string;
    signal?: AbortSignal;
    onData?: (data: Buffer) => void;
    env?: Record<string, string>;
    /** The module folder the command is for, when `cwd` is a copy in the scratch: its VM runs it. */
    for?: string;
  },
): Promise<VmRunResult> {
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const signals = [options.signal, currentStopSignal()].filter((signal): signal is AbortSignal => signal !== undefined);
  // Its own time is for running: a VM starting gets as long as a start can take, and no longer.
  const { vm, project, done } = await acquire(options.cwd, options.for, { signals, timeoutMs: VM_START_WAIT_MS });
  // Stopped while the VM was starting: the command is not started at all. (An abort that has
  // already happened fires no event, so nothing below would ever end it.)
  if (signals.some((signal) => signal.aborted)) {
    done();
    throw new Error("aborted");
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const signal of signals) signal.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let output = "";
  try {
    return await exec(vm, command, {
      cwd: resolve(options.cwd),
      env: guestEnv(packageCacheDir(project), options.env),
      signal: controller.signal,
      onData: (data) => {
        output += data.toString("utf8");
        options.onData?.(data);
      },
    });
  } catch (error) {
    if (timedOut) {
      const note = (options.timeoutNote ?? timedOutNote)(timeoutMs);
      options.onData?.(Buffer.from(note));
      return { exitCode: 124, output: `${output}${note}`, timedOut: true };
    }
    if (signals.some((signal) => signal.aborted)) throw new Error("aborted");
    return { exitCode: 1, output: `${output}${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
    for (const signal of signals) signal.removeEventListener("abort", onAbort);
    done();
  }
}

function packagesFile(dir: string): string {
  return join(vmScratchDir(dir), "system-packages.json");
}

/**
 * The system packages this project's VMs have, installed whenever one starts: the ones `system-packages:`
 * in its config.yaml names, and the ones an agent installed with install_system_packages.
 */
export function systemPackages(dir: string): string[] {
  const configured = (readProjectConfig(projectRootOf(dir)).systemPackages ?? []).filter((name) => PACKAGE_NAME.test(name));
  return [...new Set([...configured, ...installedPackages(dir)])];
}

/** The ones an agent installed with install_system_packages, and so every later VM of the project has too. */
export function installedPackages(dir: string): string[] {
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
  const result = await runInVm(`apk add --no-progress ${names.join(" ")}`, { cwd: dir, ...options });
  if (result.exitCode === 0) {
    // What the agents installed, kept apart from what config.yaml names - the config says those itself.
    // In its image already, it is not the agents' to remember: every VM has it.
    const added = packagesMissing(dir, names);
    const all = [...new Set([...installedPackages(root), ...added])].sort();
    writeFileSync(packagesFile(root), `${JSON.stringify({ packages: all }, null, 2)}\n`);
  }
  return result;
}

/** What an agent is told about where its commands run. */
export function vmEnvironmentNote(): string {
  const where =
    "Commands run in an Alpine Linux VM that holds only this module's folder in plain_modules; nothing else of the " +
    "machine exists in it - not the other modules either.";
  const network =
    "The network is open: any host on the web, and this machine's localhost - `localhost:<port>` reaches a server the VM " +
    `runs on that port, and this machine's when it runs none (also at ${HOST_ALIAS}:<port>).`;
  if (vmImage() === undefined) {
    // The stock image: say what it cannot do, so a project it cannot build is reported, not fought.
    return [
      where,
      "Installed: Python 3.12 (venv, pip inside a venv, uv) and Node 24 (npm). Project dependencies go through the " +
        "project's own package manager and install into the project, as usual.",
      "Not installed, and not installable here: C/C++ compilers and make, git, Java, Go, Rust - nor any other system " +
        "package: you install nothing into the VM.",
      "If the project needs any of those - or a Python or npm package that has to compile native code - do not " +
        "try to work around it: say plainly that it needs turri's full VM image, built with " +
        "`turri vm-image`.",
      network,
    ].join(" ");
  }
  return (
    `${where} Installed: Python 3 (pip, uv), Node (npm), Java 21 (Maven, Gradle), Go, Rust (cargo), C/C++ (gcc, ` +
    "make, cmake) and git. A language, compiler or system library that is missing is not yours to install: say what is " +
    "missing, and the person adds it to the VM's image (vm-image in config.yaml). Project dependencies go through the " +
    `project's own package manager as usual. ${network}`
  );
}

/** pi's bash tool, running in the project's VM. */
export function vmBashOperations(): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout }) => {
      // Credentials are the person's: what a command does to a credential file in what the VM holds is undone after it.
      const { project, mounts, readOnly } = vmFor(cwd);
      const scratch = basename(project) === MODULES_DIR ? [vmScratchDir(project)] : [];
      const holds = [...new Set([...mounts, ...scratch])].filter((dir) => !readOnly.includes(dir));
      const credentials = credentialFiles(holds);
      try {
        const result = await runInVm(command, {
          cwd,
          signal,
          onData,
          // The agent's own timeout, up to the longest allowed; the limit when it gave none.
          timeoutMs: timeout && timeout > 0 ? Math.min(timeout * 1000, MAX_COMMAND_TIMEOUT_MS) : COMMAND_TIMEOUT_MS,
        });
        return { exitCode: result.exitCode };
      } finally {
        const restored = restoreCredentialFiles(credentials, holds);
        if (restored.length > 0) {
          reportNote(`  an agent's command wrote ${restored.join(", ")}, which holds credentials - put back as it was`);
          onData(Buffer.from(`\n[turri put back ${restored.map((path) => basename(path)).join(", ")} as it was. ${credentialRefusal(restored[0]!)}]\n`));
        }
      }
    },
  };
}

/**
 * Where commands will run, in one line for the person: which image, or why there is no VM.
 * `level` says whether that is fine, a limit, or a stop.
 */
export function vmSummary(): { level: "ok" | "limited" | "missing"; text: string } {
  if (!vmSupported()) return { level: "missing", text: `no sandbox VM on ${process.platform}/${process.arch} - agents get no shell` };
  if (!qemuInstalled()) return { level: "missing", text: `no sandbox VM: QEMU is not installed (${qemuInstallHint()}) - run turri doctor` };
  const image = vmImage();
  return image
    ? { level: "ok", text: `the code grows in a sandbox VM that holds only plain_modules (${image.tag})` }
    : { level: "limited", text: `the code grows in a sandbox VM, ${STOCK_IMAGE.short} (turri vm-image builds the full one)` };
}

/** Whether a VM can be started on this machine: Apple Silicon, or Linux. */
/** What has a VM running or starting: module folders, mostly - one per project at a time. */
export function runningVms(): string[] {
  return [...pool.keys()];
}

export function vmSupported(): boolean {
  return (process.platform === "darwin" && process.arch === "arm64") || process.platform === "linux";
}

/**
 * Stop the sandbox VMs nothing owns any more: a VM process booted from gondolin's image store whose parent is gone -
 * the turri that started it was killed rather than exiting, and the system took the VM over (its parent is now
 * launchd, or init). Nothing would ever stop it, and it holds its memory - gigabytes - for as long as the machine runs.
 * A VM another turri still runs has that turri as its parent, and is left alone. Returns how many it stopped.
 */
export function stopOrphanedVms(): number {
  if (process.platform !== "darwin" && process.platform !== "linux") return 0;
  let store: string;
  try {
    store = getImageStoreDirectory();
  } catch {
    return 0;
  }
  const listed = spawnSync("ps", ["-eo", "pid=,ppid=,command="], { encoding: "utf8", timeout: 5000 });
  if (listed.status !== 0) return 0;
  let stopped = 0;
  for (const pid of orphanedVmPids(listed.stdout, store)) {
    try {
      process.kill(pid, "SIGTERM");
      stopped += 1;
    } catch {
      /* gone already, or not ours to stop */
    }
  }
  return stopped;
}

/** The orphaned VMs in `ps -eo pid=,ppid=,command=` output: a VM process booted from `store`, its parent gone. */
export function orphanedVmPids(psOutput: string, store: string): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const [, pid, ppid, command] = match;
    if (ppid === "1" && command!.includes(store) && /qemu-system|krun/.test(command!)) pids.push(Number(pid));
  }
  return pids;
}

/**
 * Start the VM a job's agent will run its commands in, in the background, as the job begins: it boots while the agent
 * reads its task and writes its first files, rather than when its first command comes - out of that turn's minutes.
 * Called inside the job, so the job holds it, and lets go of it when it ends; nothing waits for it, and a VM that
 * cannot start is left for the first command to say so.
 */
export function warmVm(dir: string): void {
  // TURRI_VM_WARM=0: started at the first command instead - the tests, whose agents are scripted, need none.
  if (process.env.TURRI_VM_WARM === "0" || !vmSupported() || !qemuInstalled()) return;
  void runInVm("true", { cwd: dir }).catch(() => undefined);
}

/** The VM processes a watcher is already out for. */
const watched = new Set<number>();

/**
 * Put a watcher beside each VM process this one started: a small shell that checks every two seconds that this process
 * is alive, and stops the VM the moment it is not. A VM does not die with the process that started it - killed, crashed,
 * a test worker terminated - and would hold its memory for as long as the machine runs. The watcher ends with its VM
 * when the VM ends first, and stops only a process that is still that VM, so a reused process id is never hit.
 */
function watchVmProcesses(): void {
  let store: string;
  try {
    store = getImageStoreDirectory();
  } catch {
    return;
  }
  const listed = spawnSync("ps", ["-eo", "pid=,ppid=,command="], { encoding: "utf8", timeout: 5000 });
  if (listed.status !== 0) return;
  for (const line of listed.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null || Number(match[2]) !== process.pid || !match[3]!.includes(store) || !/qemu-system|krun/.test(match[3]!)) continue;
    const vmPid = Number(match[1]);
    if (watched.has(vmPid)) continue;
    watched.add(vmPid);
    const script = [
      `while kill -0 ${process.pid} 2>/dev/null && kill -0 ${vmPid} 2>/dev/null; do sleep 2; done`,
      `if ! kill -0 ${process.pid} 2>/dev/null; then ps -o command= -p ${vmPid} 2>/dev/null | grep -q -e qemu-system -e krun && kill ${vmPid}; fi`,
    ].join("; ");
    try {
      spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" }).unref();
    } catch {
      /* the start-up sweep (stopOrphanedVms) is there still */
    }
  }
}

/** Close every VM. Called as the process ends; they would otherwise outlive it. */
export async function closeAllVms(): Promise<void> {
  await Promise.all([...pool.keys()].map(shutDown));
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
