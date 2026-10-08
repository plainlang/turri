import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * The OS sandbox: the wall under an agent's command where the OS offers one - Seatbelt on macOS, bubblewrap on Linux
 * and WSL2 - driven directly, from the role's fence. It is an extra wall, never where a rule lives: every rule is in the
 * command check and the audit, which run on every platform, and where no sandbox starts they hold alone.
 *
 * What the command can reach, on both: the role's roots - its own read only where the role only reads - the module's
 * home, TMPDIR and the package caches to write, and of the machine only an allow-list to read: the system's folders and
 * the toolchains. The code record is denied. The network is open, as on this machine. Signals and process listings
 * reach only what runs in the same sandbox: bubblewrap's own PID namespace, Seatbelt's same-sandbox target. A cap on
 * processes and on file size is set inside, beside the time limit.
 */

export interface SandboxFence {
  /** Where the command starts. */
  cwd: string;
  /** The role's roots it reads and may not write. */
  read: string[];
  /** The role's roots it writes - none for a role that only reads. */
  write: string[];
  /** What else the shell writes: the module's home, its TMPDIR, the package caches. */
  writable: string[];
  /** What of the machine it reads: the system's folders, the toolchains. */
  machine: string[];
  /** What it may not touch at all, inside its roots: the code record. */
  deny: string[];
}

export type Wall =
  | { kind: "seatbelt" }
  | { kind: "bubblewrap"; proc: "mount" | "bind" }
  | { kind: "none"; why: string; fix?: string };

/** The caps set inside the sandbox before the command runs: processes, and file size in 1024-byte blocks (8 GiB). */
export const PROCESS_CAP = 4096;
export const FILE_SIZE_CAP_BLOCKS = 8 * 1024 * 1024;

/** A folder as the kernel sees it - symlinks resolved as far as it exists - since that is what both sandboxes check. */
function real(path: string): string {
  // Neither sandbox runs on Windows: the paths are kept as they are, so what is generated is the same everywhere.
  if (process.platform === "win32") return path;
  let head = resolve(path);
  const tail: string[] = [];
  for (;;) {
    if (existsSync(head)) return join(realpathSync(head), ...tail.reverse());
    const parent = dirname(head);
    if (parent === head) return resolve(path);
    tail.push(basename(head));
    head = parent;
  }
}

/** What of macOS a command needs to read beyond the toolchains, besides `/usr`, `/bin`, `/System`: the loader's caches, the time zone, the developer tools. */
export const MACOS_MACHINE = [
  "/usr",
  "/bin",
  "/sbin",
  "/System",
  "/Library/Apple",
  "/Library/Developer",
  "/Library/Java",
  "/Library/Frameworks",
  "/Library/Preferences",
  "/private/etc",
  "/private/var/db/timezone",
  "/private/var/db/dyld",
  "/private/var/select",
  "/opt/homebrew",
  "/opt/local",
  "/Applications/Xcode.app",
  "/dev",
];

/** What of Linux a command needs to read beyond the toolchains. */
export const LINUX_MACHINE = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/etc", "/opt", "/nix", "/snap", "/run/systemd/resolve"];

/**
 * What of the machine a command reads, from the environment it runs in: the system's folders, every folder on its PATH,
 * the folders its toolchain variables point at, and the project's `toolchains:`. Only the PATH folders themselves, not
 * their parents - `~/.cargo/bin`, not `~/.cargo`, which holds a registry's credentials - but for a version manager's
 * install: a `bin` whose parent is a version, `…/installs/node/24.16.0/bin`, links its tools into the install beside it
 * (`npm` into `lib/node_modules`), and an install holds the toolchain, never a credential.
 */
export function machineFor(env: Record<string, string | undefined>, toolchainVariables: string[], extra: string[] = [], platform: NodeJS.Platform = process.platform): string[] {
  const base = platform === "darwin" ? MACOS_MACHINE : platform === "linux" ? LINUX_MACHINE : [];
  const onPath = (env.PATH ?? "").split(platform === "win32" ? ";" : ":").filter((dir) => dir.startsWith("/"));
  const installs = onPath.flatMap((dir) => {
    const install = /^(.*\/v?\d+\.\d+(?:\.\d+)?[^/]*)\/bin\/?$/.exec(dir)?.[1];
    return install !== undefined ? [install] : [];
  });
  const located = toolchainVariables.map((name) => env[name]).filter((dir): dir is string => dir !== undefined && dir.startsWith("/"));
  return [...new Set([...base, ...onPath, ...installs, ...located, ...extra])];
}

function sbplString(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The Seatbelt profile for a fence. Everything is allowed but what it names - reading file contents outside the
 * allow-list, writing outside the writable folders, the code record, Unix sockets outside the folders, signals and
 * process information beyond the sandbox - later rules winning over earlier ones. File metadata stays readable, as
 * resolving a path needs.
 */
export function seatbeltProfile(fence: SandboxFence, userDirs: { temp?: string; cache?: string } = darwinUserDirs()): string {
  // The machine's folders as given - they are the system's own spelling; the fence's with their symlinks resolved.
  const subpaths = (paths: string[], resolveLinks = true) => paths.map((path) => `  (subpath ${sbplString(resolveLinks ? real(path) : path)})`).join("\n");
  const readable = [...fence.read, ...fence.write, ...fence.writable];
  const writable = [...fence.write, ...fence.writable];
  return [
    "(version 1)",
    "(allow default)",
    ";; Reading: the machine's allow-list and the fence, nothing else.",
    "(deny file-read-data file-read-xattr)",
    "(allow file-read-data file-read-xattr",
    '  (literal "/")',
    '  (literal "/etc") (literal "/var") (literal "/tmp") (literal "/private/var/run/resolv.conf")',
    subpaths(fence.machine, false),
    subpaths(readable),
    ")",
    ";; Writing: its own folders, the module's home, TMPDIR and caches, the devices.",
    "(deny file-write*)",
    "(allow file-write*",
    subpaths(writable),
    '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper")',
    '  (regex #"^/dev/fd/")',
    ")",
    ...darwinToolCaches(userDirs),
    ";; The code record is the harness's. (A wildcard deny does not override an allow of one operation: each is named.)",
    ...(fence.deny.length > 0 ? [`(deny file-read-data file-read-xattr file-write*${fence.deny.map((path) => ` (literal ${sbplString(real(path))})`).join("")})`] : []),
    ";; No Unix socket outside its folders: the Docker daemon, an SSH agent, the person's services.",
    "(deny network-outbound (remote unix-socket))",
    `(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")) (remote unix-socket (subpath ${sbplString(real(fence.cwd))}))${writable.map((path) => ` (remote unix-socket (subpath ${sbplString(real(path))}))`).join("")})`,
    ";; Signals and process information: only within this sandbox.",
    "(deny signal)",
    "(allow signal (target same-sandbox))",
    "(deny process-info*)",
    "(allow process-info* (target same-sandbox))",
    "(allow process-info-pidinfo process-info-setcontrol (target self))",
    "",
  ].join("\n");
}

/** macOS's per-user temporary and cache folders, as `getconf` gives them - asked once. */
let darwinDirs: { temp?: string; cache?: string } | undefined;
export function darwinUserDirs(): { temp?: string; cache?: string } {
  if (darwinDirs !== undefined) return darwinDirs;
  const ask = (name: string) => {
    if (process.platform !== "darwin") return undefined;
    const run = spawnSync("getconf", [name], { encoding: "utf8", timeout: 5000 });
    const dir = run.status === 0 ? run.stdout.trim().replace(/\/$/, "") : "";
    return dir !== "" ? real(dir) : undefined;
  };
  darwinDirs = { temp: ask("DARWIN_USER_TEMP_DIR"), cache: ask("DARWIN_USER_CACHE_DIR") };
  return darwinDirs;
}

/**
 * The developer tools' own scratch files on macOS: `xcrun` (behind `/usr/bin/git`, `clang`, `make`) keeps a database in
 * the per-user temporary folder, and clang its module cache in the per-user cache folder - whatever TMPDIR says.
 */
function darwinToolCaches({ temp, cache }: { temp?: string; cache?: string }): string[] {
  const rules: string[] = [];
  const regex = (path: string) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (temp !== undefined) rules.push(`(allow file-read-data file-write* (regex #"^${regex(temp)}/xcrun_db"))`);
  if (cache !== undefined) rules.push(`(allow file-read-data file-write* (subpath ${sbplString(join(cache, "clang"))}) (subpath ${sbplString(join(cache, "com.apple.dt.xcrun"))}))`);
  return rules.length > 0 ? [";; The developer tools' own scratch files.", ...rules] : [];
}

/** The bubblewrap arguments for a fence, up to the command. `proc: "bind"` binds the host's /proc where mounting one is refused. */
export function bubblewrapArgs(fence: SandboxFence, options: { proc: "mount" | "bind" } = { proc: "mount" }): string[] {
  const args = ["--die-with-parent", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try"];
  for (const path of fence.machine) args.push("--ro-bind-try", path, path);
  args.push(...(options.proc === "mount" ? ["--proc", "/proc"] : ["--ro-bind", "/proc", "/proc"]));
  args.push("--dev", "/dev", "--tmpfs", "/tmp");
  for (const path of fence.read) args.push("--ro-bind", real(path), real(path));
  for (const path of [...fence.write, ...fence.writable]) args.push("--bind", real(path), real(path));
  // The record: covered by an empty file, unreadable and unwritable.
  for (const path of fence.deny) if (existsSync(path)) args.push("--ro-bind", "/dev/null", real(path));
  args.push("--chdir", real(fence.cwd));
  return args;
}

/** The caps, set inside the sandbox, then the command itself. */
function capped(argv: string[]): string[] {
  const caps = `ulimit -S -u ${PROCESS_CAP} 2>/dev/null; ulimit -S -f ${FILE_SIZE_CAP_BLOCKS} 2>/dev/null; exec "$@"`;
  return ["/bin/bash", "-c", caps, "turri", ...argv];
}

/** How a command is run behind the wall that is up: for the host runner's `wrap`. Where none is, it runs as it is. */
export function sandboxWrap(wall: Wall, fence: SandboxFence): (argv: string[]) => string[] {
  if (wall.kind === "seatbelt") return (argv) => ["/usr/bin/sandbox-exec", "-p", seatbeltProfile(fence), ...capped(argv)];
  if (wall.kind === "bubblewrap") return (argv) => ["bwrap", ...bubblewrapArgs(fence, { proc: wall.proc }), "--", ...capped(argv)];
  return (argv) => argv;
}

/** What bubblewrap's refusal to start says is missing, and how to give it - each failure has a message of its own. */
export function whyBubblewrapFailed(output: string): { why: string; fix?: string } {
  if (/ENOENT|not found|No such file or directory: 'bwrap'|spawnSync bwrap/i.test(output) && !/Can't mount/.test(output)) {
    return { why: "bubblewrap is not installed", fix: "install it: `apt install bubblewrap` (or your distribution's package)" };
  }
  if (/Creating new namespace failed: Operation not permitted|No permissions to create a new namespace/.test(output)) {
    return {
      why: "this machine does not let an unprivileged process create a user namespace",
      fix:
        "in Docker, run the container as a user that is not root (`--user`), with `--security-opt seccomp=unconfined`; on the host, `sysctl -w kernel.unprivileged_userns_clone=1`",
    };
  }
  if (/setting up uid map: Permission denied|Failed to make \/ slave: Permission denied/.test(output)) {
    return {
      why: "AppArmor keeps bubblewrap from setting up its namespace",
      fix:
        "in Docker, add `--security-opt apparmor=unconfined`; on Ubuntu 24.04, `sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` or an AppArmor profile for bwrap",
    };
  }
  if (/Can't mount proc on (\/newroot)?\/proc/.test(output)) {
    return { why: "the container masks /proc", fix: "in Docker, add `--security-opt systempaths=unconfined`" };
  }
  return { why: `bubblewrap did not start: ${output.trim().split("\n")[0] ?? "no reason given"}` };
}

let probed: Wall | undefined;

/** For tests: forget what was found, or say what to find. */
export function setSandboxForTests(wall: Wall | undefined): void {
  probed = wall;
}

/**
 * Which wall is up on this machine - tried once, by starting a sandbox that runs `true` - and, when none starts, why
 * and how to give it one.
 */
export function sandboxAvailable(): Wall {
  if (probed !== undefined) return probed;
  probed = probe();
  return probed;
}

function probe(): Wall {
  if (process.platform === "darwin") {
    if (!existsSync("/usr/bin/sandbox-exec")) return { kind: "none", why: "this macOS has no sandbox-exec (Seatbelt)" };
    const run = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { encoding: "utf8", timeout: 10_000 });
    return run.status === 0 ? { kind: "seatbelt" } : { kind: "none", why: `Seatbelt did not start: ${(run.stderr || String(run.error ?? "")).trim()}` };
  }
  if (process.platform === "linux") {
    const tryProc = (proc: "mount" | "bind") =>
      spawnSync("bwrap", ["--ro-bind", "/", "/", ...(proc === "mount" ? ["--proc", "/proc"] : ["--ro-bind", "/proc", "/proc"]), "--dev", "/dev", "--unshare-pid", "--", "true"], {
        encoding: "utf8",
        timeout: 10_000,
      });
    const mounted = tryProc("mount");
    if (mounted.status === 0) return { kind: "bubblewrap", proc: "mount" };
    const output = `${mounted.stderr ?? ""}${mounted.error !== undefined ? String(mounted.error) : ""}`;
    if (/Can't mount proc on (\/newroot)?\/proc/.test(output) && tryProc("bind").status === 0) return { kind: "bubblewrap", proc: "bind" };
    return { kind: "none", ...whyBubblewrapFailed(output) };
  }
  if (process.platform === "win32") return { kind: "none", why: "Windows has no OS sandbox turri drives: the command check and the audit hold alone" };
  return { kind: "none", why: `${process.platform} has no OS sandbox turri drives` };
}

/** Whether `path` is one of the fence's roots or under one - for the tests and the audit. */
export function underAny(path: string, roots: string[]): boolean {
  const target = real(path);
  return roots.some((root) => {
    const base = real(root);
    return target === base || target.startsWith(base + sep);
  });
}

/** Where the agents' commands run, in one line for the person: which walls are up, or that only the shared ones are. */
export function sandboxSummary(wall: Wall = sandboxAvailable()): { level: "ok" | "limited"; text: string } {
  if (wall.kind === "none") return { level: "limited", text: `agents' commands run on this machine behind the command check and the audit - no OS sandbox: ${wall.why} (turri doctor)` };
  return { level: "ok", text: `agents' commands run on this machine behind the command check, ${wall.kind === "seatbelt" ? "Seatbelt" : "bubblewrap"} and the audit` };
}
