import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { MODULES_DIR } from "./paths.ts";

/**
 * Keeping a rendering agent inside its own directory.
 *
 * pi's `cwd` is where relative paths start from, not a fence: an absolute path resolves to
 * itself and `bash` can `cd` anywhere. That is fine for an agent working on the repo it was
 * launched in, and wrong for these - a render agent is building one module and has no
 * business reading the rest of the project, let alone writing to it.
 *
 * So the tools are rebuilt from pi's own factories with a check in front of every path, and
 * `bash` runs under an OS sandbox. Two roots per agent: what it may read and what it may
 * write, both of which must sit under `plain_modules`. Nothing reaches above that.
 */

export interface Confinement {
  /** Where the agent starts and where relative paths resolve. */
  workdir: string;
  /** Directories it may read from. The workdir is always one of them. */
  read: string[];
  /** Directories it may write to. */
  write: string[];
}

export class ConfinementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfinementError";
  }
}

/**
 * The highest directory an agent working in `dir` may see: the `plain_modules` it lives
 * under. A build directory somewhere else entirely - a sandbox, a test fixture, an explicit
 * `--build-dir` - is its own ceiling, so confinement never silently widens to a whole disk.
 */
export function ceilingFor(dir: string): string {
  const parts = resolve(dir).split(sep);
  const index = parts.lastIndexOf(MODULES_DIR);
  return index === -1 ? resolve(dir) : parts.slice(0, index + 1).join(sep);
}

/** Resolve symlinks as far as the path exists, so a link cannot walk out of a root. */
function canonical(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  for (;;) {
    if (existsSync(head)) return join(realpathSync(head), ...tail.reverse());
    const parent = dirname(head);
    if (parent === head) return resolve(path);
    tail.push(head.slice(parent.length + 1));
    head = parent;
  }
}

function within(path: string, root: string): boolean {
  const target = canonical(path);
  const base = canonical(root);
  return target === base || target.startsWith(base + sep);
}

export function insideAny(path: string, roots: string[]): boolean {
  return roots.some((root) => within(path, root));
}

/** What the tool was given, turned into the absolute path it will actually open. */
function absolutize(raw: string, cwd: string): string {
  let path = raw.trim();
  if (path.startsWith("@")) path = path.slice(1);
  if (path === "~" || path.startsWith(`~${sep}`)) path = join(homedir(), path.slice(1));
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

function refuse(path: string, roots: string[], verb: string): never {
  throw new ConfinementError(
    `${path} is outside this agent's ${verb} directory. It may only ${verb} ` +
      `${roots.join(" and ")}. Work inside those - nothing above them is yours to touch.`,
  );
}

function check(raw: string | undefined, cwd: string, roots: string[], verb: "read" | "write"): void {
  if (raw === undefined) return;
  const path = absolutize(raw, cwd);
  if (!insideAny(path, roots)) refuse(path, roots, verb);
}

/** A glob is a path too: `../../*` escapes just as well as `..`. */
function checkPattern(pattern: string | undefined): void {
  if (pattern === undefined) return;
  const parts = pattern.split("/");
  if (isAbsolute(pattern) || pattern.startsWith("~") || parts.includes("..")) {
    throw new ConfinementError(
      `'${pattern}' reaches outside this agent's directory. Patterns must stay relative to it.`,
    );
  }
}

type AnyTool = ToolDefinition<any, any, any>;

/** Same tool, with the path arguments checked before it runs. */
function guard(def: AnyTool, inspect: (params: any) => void): AnyTool {
  return {
    ...def,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      inspect(params);
      return def.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

/**
 * The same check again, one layer down, on the absolute path the tool resolved.
 *
 * The argument check reads the request; this reads what the tool decided the request meant.
 * They agree in every ordinary case, and when they do not - a `~` spelt oddly, a filename
 * normalised to another form on disk - this is the one that is true.
 */
function guardedOps(roots: string[], verb: "read" | "write") {
  return (path: string) => {
    if (!insideAny(path, roots)) refuse(path, roots, verb);
  };
}

/**
 * Where package managers keep their caches inside the sandbox.
 *
 * Their defaults sit in the home directory, which is not writable, so an install would
 * fail. This is shared across runs so a dependency is fetched once, not once per test run,
 * and it holds nothing but downloaded packages.
 */
export function packageCacheDir(): string {
  return process.env.PLAINWRIGHT_CACHE_DIR ?? join(homedir(), ".cache", "plainwright");
}

function cacheEnv(cache: string): Record<string, string> {
  return {
    XDG_CACHE_HOME: cache,
    npm_config_cache: join(cache, "npm"),
    YARN_CACHE_FOLDER: join(cache, "yarn"),
    PIP_CACHE_DIR: join(cache, "pip"),
    UV_CACHE_DIR: join(cache, "uv"),
    GOCACHE: join(cache, "go-build"),
    GOMODCACHE: join(cache, "go-mod"),
  };
}

function sandboxProfile(c: Confinement, scratch: string, cache: string): string {
  const ceiling = canonical(ceilingFor(c.workdir));
  const subpaths = (dirs: string[]) => {
    const unique = [...new Set(dirs.map((d) => canonical(d)))];
    return unique.map((d) => `  (subpath "${d}")`).join("\n");
  };

  // Reads stay open in general: an interpreter, a compiler and a package manager all live
  // outside and a denial here breaks the build rather than protecting anything. What is
  // closed is the project the module lives in - everything above `plain_modules` - which is
  // the thing an agent has no reason to be reading and every reason to leave alone.
  // Its metadata stays open: `realpath` and `getcwd` stat every directory above the one
  // they start in, and denying that breaks any interpreter run from inside `plain_modules`.
  // A stat says a path exists, never what it holds or what sits next to it.
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    // Its own scratch directory stands in for the system temp dir, which the environment
    // points at too. A compiler gets somewhere to work without every agent on the machine
    // sharing one writable tree.
    `(allow file-write*\n${subpaths([...c.write, scratch, cache, "/dev"])})`,
    `(deny file-read* (subpath "${canonical(dirname(ceiling))}"))`,
    `(allow file-read-metadata (subpath "${canonical(dirname(ceiling))}"))`,
    `(allow file-read*\n${subpaths([...c.read, ...c.write, ceiling, scratch, cache])})`,
  ].join("\n");
}

function sandboxAvailable(): boolean {
  return process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
}

/**
 * Wrap a command so the kernel enforces the same boundary the tools do.
 *
 * Without this, `bash` is the hole every other check is plugged around: it takes one string
 * and no amount of reading it tells you where it will write. macOS can answer that for us.
 */
function sandboxed(command: string, profilePath: string): string {
  return `/usr/bin/sandbox-exec -f ${JSON.stringify(profilePath)} /bin/sh -c ${JSON.stringify(command)}`;
}

export interface ConfinedTools {
  tools: AnyTool[];
  /** Tool names, for the session's `tools` list. */
  names: string[];
  /** One line for the log: what is enforced and how. */
  description: string;
}

export function confinedTools(c: Confinement): ConfinedTools {
  const workdir = resolve(c.workdir);
  const read = [workdir, ...c.read].map((d) => resolve(d));
  const write = [...c.write].map((d) => resolve(d));

  const ceiling = ceilingFor(workdir);
  for (const root of [...read, ...write]) {
    if (!within(root, ceiling)) {
      throw new ConfinementError(
        `${root} is above ${ceiling}. An agent may not be given access above its module root.`,
      );
    }
  }

  const readOps = guardedOps(read, "read");
  const writeOps = guardedOps(write, "write");

  const tools: AnyTool[] = [
    guard(
      createReadToolDefinition(workdir, {
        operations: {
          readFile: async (path) => (readOps(path), readFileSync(path)),
          access: async (path) => readOps(path),
        },
      }),
      (p) => check(p.path, workdir, read, "read"),
    ),
    guard(
      createWriteToolDefinition(workdir, {
        operations: {
          writeFile: async (path, content) => (writeOps(path), writeFileSync(path, content)),
          mkdir: async (dir) => {
            writeOps(dir);
            const { mkdirSync } = await import("node:fs");
            mkdirSync(dir, { recursive: true });
          },
        },
      }),
      (p) => check(p.path, workdir, write, "write"),
    ),
    guard(
      createEditToolDefinition(workdir, {
        operations: {
          readFile: async (path) => (writeOps(path), readFileSync(path)),
          writeFile: async (path, content) => (writeOps(path), writeFileSync(path, content)),
          access: async (path) => writeOps(path),
        },
      }),
      (p) => check(p.path, workdir, write, "write"),
    ),
    guard(createLsToolDefinition(workdir), (p) => check(p.path, workdir, read, "read")),
    guard(createGrepToolDefinition(workdir), (p) => {
      check(p.path, workdir, read, "read");
      checkPattern(p.glob);
    }),
    guard(createFindToolDefinition(workdir), (p) => {
      check(p.path, workdir, read, "read");
      checkPattern(p.pattern);
    }),
  ];

  let description = `file tools fenced to ${workdir}`;

  const sandbox = commandSandbox({ workdir, read, write });
  if (sandbox !== null) {
    tools.push(
      createBashToolDefinition(workdir, {
        spawnHook: (context) => ({
          ...context,
          // The command may cd wherever it likes; the sandbox decides what that gets it.
          cwd: workdir,
          command: sandbox.wrap(context.command),
          env: { ...context.env, ...sandbox.env },
        }),
      }),
    );
    description += `, bash sandboxed to it (writes) and to ${ceilingFor(workdir)} (reads)`;
  } else {
    // Without an OS sandbox there is no honest way to fence a shell, so the agent does not
    // get one. Everything it needs to do to files it can do with the tools above.
    description += ", no bash (no OS sandbox on this platform)";
  }

  return { tools, names: tools.map((t) => t.name), description };
}

/** Whether the kernel-level part of the fence is available here. */
export function sandboxSupported(): boolean {
  return sandboxAvailable();
}

export interface CommandSandbox {
  /** The command, rewritten to run under the profile. */
  wrap(command: string): string;
  /** Points the temp dir at the sandbox's own scratch space. */
  env: Record<string, string>;
  /** Remove the profile and scratch space. */
  dispose(): void;
}

/**
 * The kernel-level fence for shell commands, or null where there is none.
 *
 * Shared by the bash tool and by every tool that runs a command the agent chose - running
 * the tests takes a command string too, and without this it would be a shell with no
 * fence around it at all.
 */
export function commandSandbox(c: Confinement): CommandSandbox | null {
  if (!sandboxAvailable()) return null;
  const dir = mkdtempSync(join(tmpdir(), "plainwright-sandbox-"));
  const scratch = join(dir, "tmp");
  mkdirSync(scratch, { recursive: true });
  const cache = packageCacheDir();
  mkdirSync(cache, { recursive: true });
  const profilePath = join(dir, "profile.sb");
  writeFileSync(profilePath, sandboxProfile(c, scratch, cache));
  return {
    wrap: (command) => sandboxed(command, profilePath),
    env: { TMPDIR: scratch, TMP: scratch, TEMP: scratch, ...cacheEnv(cache) },
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Used by tests: run one command under the same profile the bash tool would use. */
export function runConfined(c: Confinement, command: string): { status: number; output: string } {
  const sandbox = commandSandbox(c);
  if (sandbox === null) throw new ConfinementError("No OS sandbox on this platform.");
  try {
    const result = spawnSync("/bin/sh", ["-c", sandbox.wrap(command)], {
      cwd: c.workdir,
      encoding: "utf8",
      env: { ...process.env, ...sandbox.env },
    });
    return { status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  } finally {
    sandbox.dispose();
  }
}
