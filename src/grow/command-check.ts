import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import { isCredentialFile } from "./credentials.ts";
import { RECORD_FILE } from "./records.ts";

/**
 * The check every agent command passes before it runs, on every platform.
 *
 * A command is one string, and no check of its text can say for certain what it will read or write: a path built at
 * run time, a script that reads one from a file, gets past any. So this is the first wall of three, not the only one -
 * the OS sandbox stops what gets past it where the OS has one, and the audit after the command puts back what reached
 * the project. What it is for is the honest mistake and the plain attempt, caught before anything runs, with a reason
 * the agent can act on: a path outside its walls, the code record, a credential file written, software installed on
 * the machine, a process killed that its pulse did not start. Pure: it reads the text and the fence, and runs nothing.
 */

export interface CommandFence {
  /** Where the command starts: the agent's folder. */
  cwd: string;
  /** The role's roots it may read. */
  read: string[];
  /** The role's roots it may write. */
  write: string[];
  /** Its HOME, what `~` and `$HOME` mean. */
  home?: string;
  /** Its TMPDIR, what `$TMPDIR` means. */
  tmp?: string;
  /** Beside the roots: what its shell may write - the home, the TMPDIR, the package caches. Readable too. */
  writable?: string[];
  /** Beside the roots: what of the machine it may read - the system folders, the toolchains. */
  readable?: string[];
  /** Whose paths these are: drive letters, backslashes and any case on Windows. */
  platform?: "posix" | "win32";
}

export type CheckRule = "path" | "record" | "credential" | "install" | "kill";

export type CheckResult = { ok: true } | { ok: false; rule: CheckRule; reason: string };

/** What of the machine an agent's command may read, beside its roots and its toolchains: the system's own folders. */
export function machineReadable(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") {
    const root = process.env.SystemRoot ?? "C:\\Windows";
    return [root, process.env.ProgramFiles ?? "C:\\Program Files", process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"];
  }
  return [
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib32",
    "/lib64",
    "/libexec",
    "/etc",
    "/private/etc",
    "/opt/homebrew",
    "/opt/local",
    "/System",
    "/Library/Java",
    "/Library/Developer",
    "/Applications/Xcode.app",
    "/nix",
    "/snap",
    "/proc/self",
    "/proc/cpuinfo",
    "/proc/meminfo",
  ];
}

/** Devices any command may use. */
const DEVICES = ["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/fd"];

/**
 * The top-level folders a path is taken to name something on disk under - beside the fence's own and what exists here.
 * `/api/v1` in a curl or `/orders/1` in a JSON body names a route, not a file, and is let through.
 */
const KNOWN_TOPS = new Set([
  "Users", "home", "root", "etc", "var", "tmp", "private", "opt", "usr", "bin", "sbin", "lib", "lib32", "lib64", "libexec",
  "System", "Library", "Applications", "Volumes", "mnt", "media", "srv", "proc", "sys", "dev", "run", "boot", "snap", "nix", "cores",
]);

/** Programs that run the command after them. */
const WRAPPERS = new Set(["env", "exec", "time", "nohup", "command", "nice", "setsid", "xargs", "timeout", "stdbuf", "builtin", "caffeinate"]);

/** The system's package managers, and what they install with. */
const SYSTEM_PACKAGE_MANAGERS = new Set(["brew", "apt", "apt-get", "aptitude", "dnf", "yum", "apk", "pacman", "port", "choco", "winget", "scoop", "zypper", "snap", "flatpak", "nix-env", "pkg", "pkg_add", "emerge"]);
const SYSTEM_INSTALL_WORDS = new Set(["install", "add", "upgrade", "update", "reinstall", "tap", "-S", "-Sy", "-Syu", "-U", "-i"]);

/** Toolchain managers: what installs a toolchain outside the project. */
const TOOLCHAIN_MANAGERS = new Set(["nvm", "sdk", "pyenv", "rbenv", "rvm", "volta", "fnm", "asdf", "mise", "rtx", "jenv", "goenv", "nodenv"]);

const GLOBAL_FLAGS = new Set(["-g", "--global", "--location=global"]);

const INSTALLER_FILE = /\.(run|pkg|msi|dmg)$/i;

/** A word as the shell would see it, quotes taken off. */
function words(segment: string): string[] {
  return (segment.match(/"[^"]*"|'[^']*'|[^\s"']+(?:(?:"[^"]*"|'[^']*')[^\s"']*)*/g) ?? []).map((word) => word.replace(/"([^"]*)"|'([^']*)'/g, "$1$2"));
}

/** The simple commands a command line is made of, in order: split on `;`, `&&`, `||`, `|`, `&`, newlines and subshells. */
function segments(command: string): string[] {
  return command
    .split(/&&|\|\||[;|&\n()`]|\$\(/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/** A simple command's program and arguments, past assignments, wrappers and their own options. */
function programOf(segment: string): { program: string; args: string[]; sudo: boolean } | undefined {
  let all = words(segment);
  let sudo = false;
  for (;;) {
    const first = all[0];
    if (first === undefined) return undefined;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) all = all.slice(1);
    else if (first === "sudo" || first === "doas") {
      sudo = true;
      all = all.slice(1);
      while (all[0] !== undefined && all[0].startsWith("-")) all = all.slice(1);
    } else if (WRAPPERS.has(first)) {
      all = all.slice(1);
      while (all[0] !== undefined && (/^-/.test(all[0]) || /^\d+[smhd]?$/.test(all[0]))) all = all.slice(1);
    } else break;
  }
  const [program, ...args] = all;
  if (program === undefined) return sudo ? { program: "", args: [], sudo } : undefined;
  return { program: program.split(/[\\/]/).pop()!, args, sudo };
}

/** Why one simple command installs software outside the project, or nothing when it does not. */
function installIn(segment: string): string | undefined {
  const found = programOf(segment);
  if (found === undefined) return undefined;
  const { program, args, sudo } = found;
  const has = (...wanted: string[]) => wanted.some((word) => args.includes(word));
  if (sudo) return "sudo runs it as the machine's administrator";
  if (SYSTEM_PACKAGE_MANAGERS.has(program)) {
    if (program === "pkg_add" || args.some((arg) => SYSTEM_INSTALL_WORDS.has(arg))) return `${program} installs into the system`;
    return undefined;
  }
  if (TOOLCHAIN_MANAGERS.has(program) && (has("install") || (program === "asdf" && has("plugin")) || ((program === "mise" || program === "rtx") && has("use") && args.some((arg) => GLOBAL_FLAGS.has(arg))))) {
    return `${program} installs a toolchain on the machine`;
  }
  if (program === "rustup" && (has("install") || (has("target", "component", "toolchain") && has("add", "install")))) return "rustup installs a toolchain on the machine";
  if (program === "corepack" && (has("enable") || (has("install") && args.some((arg) => GLOBAL_FLAGS.has(arg))))) return "corepack installs package managers on the machine";
  if ((program === "npm" || program === "pnpm" || program === "bun") && args.some((arg) => GLOBAL_FLAGS.has(arg))) return `${program} ${args.join(" ")} installs globally`;
  if (program === "yarn" && args[0] === "global") return "yarn global installs globally";
  const pipArgs = program === "pip" || program === "pip3" ? args : /^python(\d+(\.\d+)?)?$/.test(program) && args[0] === "-m" && /^pip3?$/.test(args[1] ?? "") ? args.slice(2) : undefined;
  if (pipArgs !== undefined && pipArgs.includes("install") && (pipArgs.includes("--user") || pipArgs.includes("--break-system-packages"))) return "pip installs into the user's or the system's Python";
  if (program === "pipx" && args.some((arg) => ["install", "inject", "upgrade", "ensurepath", "reinstall"].includes(arg))) return "pipx installs on the machine";
  if (program === "gem" && has("install")) return "gem install installs outside the project - use Bundler";
  if (program === "installer" || program === "msiexec" || (program === "hdiutil" && has("attach"))) return `${program} runs an installer`;
  if (INSTALLER_FILE.test(program) || ((program === "sh" || program === "bash" || program === "open") && args.some((arg) => INSTALLER_FILE.test(arg)))) return "it runs an installer";
  return undefined;
}

/** Downloads run as programs: a script piped to a shell, or run from a download. */
const PIPED_DOWNLOAD = /\b(curl|wget)\b[^|;&\n]*\|\s*(sudo\s+(-\S+\s+)*)?((ba|z|da|k)?sh|python\d*|perl|ruby|node)\b/;
const RUN_DOWNLOAD = /\b(ba|z|da|k)?sh\s+(-\w+\s+)*["']?\$\(\s*(curl|wget)\b|<\(\s*(curl|wget)\b/;

/** Killing by name, or by what holds a port. */
const KILL_BY_LOOKUP = /\bkill\b[^;&|\n]*(\$\(|`)\s*(lsof|fuser|pgrep|pidof|ss|netstat)\b/;
const LOOKUP_TO_KILL = /\b(lsof|pgrep|pidof|fuser|ss|netstat)\b[^;&\n]*\|\s*xargs\s+(-\S+\s+)*kill\b/;

/** One check, the paths of one platform. */
class Paths {
  readonly path: typeof posix;
  readonly win: boolean;
  constructor(platform: "posix" | "win32") {
    this.win = platform === "win32";
    this.path = this.win ? win32 : posix;
  }
  within(target: string, root: string): boolean {
    const a = this.win ? this.path.resolve(target).toLowerCase() : this.path.resolve(target);
    const b = this.win ? this.path.resolve(root).toLowerCase() : this.path.resolve(root);
    const sep = this.path.sep;
    return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
  }
  inside(target: string, roots: string[]): boolean {
    return roots.some((root) => this.within(target, root));
  }
}

/** What a word that names a path names, from `cwd`: `~`, `$HOME`, `$TMPDIR` as the fence has them; nothing when it cannot be told. */
function resolveWord(word: string, cwd: string, fence: CommandFence, paths: Paths): string | undefined {
  let path = word;
  const home = fence.home;
  if (path === "~" || path.startsWith("~/")) {
    if (home === undefined) return undefined;
    path = home + path.slice(1);
  } else if (/^\$\{?HOME\}?(\/|$)/.test(path)) {
    if (home === undefined) return undefined;
    path = path.replace(/^\$\{?HOME\}?/, home);
  } else if (/^\$\{?TMPDIR\}?(\/|$)/.test(path)) {
    if (fence.tmp === undefined) return undefined;
    path = path.replace(/^\$\{?TMPDIR\}?/, fence.tmp);
  }
  // A variable we cannot know, or a glob: told apart at run time, by the sandbox.
  if (path.includes("$")) return undefined;
  return paths.path.resolve(cwd, path);
}

/** The words of a command that name paths: absolute, home- or TMPDIR-relative, or climbing with `..` - in quotes too. */
function pathWords(text: string, paths: Paths, fence: CommandFence): string[] {
  const found: string[] = [];
  // A quoted string that is one path, spaces and all: "C:\Program Files\node\node.exe".
  let rest = text.replace(/"([^"\n]*)"|'([^'\n]*)'/g, (whole, a: string | undefined, b: string | undefined) => {
    const inner = a ?? b ?? "";
    if (/^([A-Za-z]:[\\/]|\/(?!\/)|~\/)/.test(inner) && !/\s-/.test(inner)) {
      found.push(inner);
      return " ".repeat(whole.length);
    }
    return ` ${inner} `;
  });
  const boundary = `(?:^|(?<=[\\s'"=(<>:,\\[{]))`;
  const stop = `[^\\s'"\`;|&<>(){},\\]]*`;
  const patterns = [
    new RegExp(`${boundary}(\\/(?!\\/)${stop})`, "g"),
    new RegExp(`${boundary}(~(?:\\/${stop})?)(?=$|[\\s'"\`;|&<>(){},\\]])`, "g"),
    new RegExp(`${boundary}(\\$\\{?(?:HOME|TMPDIR)\\}?(?:\\/${stop})?)`, "g"),
    new RegExp(`${boundary}((?:${stop}[\\/\\\\])?\\.\\.(?:[\\/\\\\]${stop})?)(?=$|[\\s'"\`;|&<>(){},\\]])`, "g"),
  ];
  if (paths.win) patterns.push(new RegExp(`(?<![\\w])([A-Za-z]:[\\\\/]${stop})`, "g"));
  for (const pattern of patterns) {
    for (const match of rest.matchAll(pattern)) found.push(match[1]!);
  }
  rest = "";
  const fenceTops = new Set(
    [...fence.read, ...fence.write, ...(fence.writable ?? []), ...(fence.readable ?? [])].map((root) => root.split(/[\\/]/).filter(Boolean)[0]),
  );
  return found.filter((word) => {
    if (!word.startsWith("/") || paths.win) return true;
    // A path that names something on disk: under a known top folder, one of the fence's, or one that is there.
    const top = word.split("/").filter(Boolean)[0];
    if (top === undefined) return true;
    return KNOWN_TOPS.has(top) || fenceTops.has(top) || existsSync(`/${top}`);
  });
}

/** The words a simple command writes to: redirections, tee, the target of cp and mv, a file edited in place. */
function writeTargets(segment: string): string[] {
  const targets: string[] = [];
  for (const match of segment.matchAll(/(?:^|[^<>&\d])(?:\d|&)?>>?\|?\s*("[^"]*"|'[^']*'|[^\s;|&<>()]+)/g)) {
    targets.push(match[1]!.replace(/^["']|["']$/g, ""));
  }
  for (const part of segments(segment)) {
    const found = programOf(part);
    if (found === undefined) continue;
    const { program, args } = found;
    const operands = args.filter((arg) => !arg.startsWith("-"));
    if (program === "tee") targets.push(...operands);
    else if ((program === "cp" || program === "mv" || program === "install" || program === "ln") && operands.length >= 2) targets.push(operands[operands.length - 1]!);
    else if (["touch", "rm", "rmdir", "mkdir", "truncate", "chmod", "chown"].includes(program)) targets.push(...operands.slice(program === "chmod" || program === "chown" ? 1 : 0));
    else if ((program === "sed" || program === "perl") && args.some((arg) => /^-p?i/.test(arg))) targets.push(...operands.slice(1));
  }
  return targets;
}

function refusal(rule: CheckRule, reason: string): CheckResult {
  return { ok: false, rule, reason };
}

/** The folders a refusal names: what the command may reach. */
function reach(fence: CommandFence): string {
  const list = (dirs: string[]) => dirs.map((dir) => `\`${dir}\``).join(", ");
  const own = fence.write.length > 0 ? `It may read ${list(fence.read)} and write ${list(fence.write)}` : `It may read ${list(fence.read)} and write nothing`;
  return `${own}, beside its home (\`~\`), \`$TMPDIR\` and the machine's system folders and toolchains.`;
}

/** Check one command line against a role's fence: `{ ok: true }`, or which rule it breaks and what to do instead. */
export function checkCommand(command: string, fence: CommandFence): CheckResult {
  const paths = new Paths(fence.platform ?? (process.platform === "win32" ? "win32" : "posix"));
  const readable = [...fence.read, ...fence.write, ...(fence.writable ?? []), ...(fence.readable ?? []), ...(paths.win ? [] : DEVICES)];
  const writable = [...fence.write, ...(fence.writable ?? []), ...(paths.win ? [] : DEVICES)];

  if (command.includes(RECORD_FILE)) {
    return refusal("record", `${RECORD_FILE} is the harness's record of what the code is built from: no agent reads or writes it, and nothing in it is yours to go by.`);
  }

  // Installs and kills, a simple command at a time; downloads run as programs, on the whole line.
  if (PIPED_DOWNLOAD.test(command) || RUN_DOWNLOAD.test(command)) return refusal("install", installReason("it runs a script downloaded from the web"));
  if (KILL_BY_LOOKUP.test(command) || LOOKUP_TO_KILL.test(command)) return refusal("kill", killReason());
  for (const segment of segments(command)) {
    const why = installIn(segment);
    if (why !== undefined) return refusal("install", installReason(why));
    const found = programOf(segment);
    if (found !== undefined && (["pkill", "killall", "taskkill"].includes(found.program) || (found.program === "fuser" && found.args.some((arg) => /^-\w*k/.test(arg))))) {
      return refusal("kill", killReason());
    }
  }

  // Paths, a simple command at a time from where the cds before it left it.
  let cwd = fence.cwd;
  for (const segment of command.split(/&&|\|\||[;\n]/)) {
    for (const word of pathWords(segment, paths, fence)) {
      const target = resolveWord(word, cwd, fence, paths);
      if (target !== undefined && !paths.inside(target, readable)) {
        return refusal("path", `\`${word}\` is outside what this command may reach (${target}). ${reach(fence)} Everything you need from outside them is in your prompt.`);
      }
    }
    for (const word of writeTargets(segment)) {
      if (isCredentialFile(word)) {
        return refusal("credential", `${word.split(/[\\/]/).pop()} holds credentials, and they are the person's to provide - never an agent's to write, not even a placeholder. If the software needs one that is missing, say so and name the variable.`);
      }
      const target = resolveWord(word, cwd, fence, paths);
      if (target !== undefined && !paths.inside(target, writable)) {
        return refusal("path", `\`${word}\` is outside what this command may write (${target}). ${reach(fence)}`);
      }
    }
    const cd = /^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*$/.exec(segment);
    if (cd !== null) {
      const to = resolveWord(cd[1]!.replace(/^["']|["']$/g, ""), cwd, fence, paths);
      if (to !== undefined) cwd = to;
    }
  }
  return { ok: true };
}

function installReason(why: string): string {
  return (
    `This installs software outside the project - ${why}. The machine is the person's: what it lacks - a toolchain, a ` +
    "system library, a tool - is theirs to install. The project's own dependencies are yours: declare them in its " +
    "manifest and install them into the project (npm install, pip into its venv, mvn, gradle, cargo, go mod). If the " +
    "project cannot be built without something the machine lacks, call report_environment_error and say what is missing."
  );
}

function killReason(): string {
  return (
    "This kills processes your pulse did not start - by name, or by what holds a port - and those may be the person's " +
    "or another agent's. Kill only what you started, by its process id (`$!`) or its job (`%1`). A port something else " +
    "holds is not yours: use another port."
  );
}
