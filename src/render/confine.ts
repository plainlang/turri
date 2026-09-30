import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { NOTES_FILE } from "./notes.ts";
import { RECORD_FILE } from "./records.ts";
import { modulesRootOf } from "./paths.ts";
import { truncateOutput } from "./testing.ts";
import {
  COMMAND_TIMEOUT_MS,
  installSystemPackages,
  MAX_COMMAND_TIMEOUT_MS,
  vmBashOperations,
  vmEnvironmentNote,
  vmHolds,
  vmReadOnly,
  vmSupported,
} from "./vm.ts";

/**
 * Keeping a rendering agent inside its own directory.
 *
 * pi's `cwd` is where relative paths start from, not a fence: an absolute path resolves to
 * itself and `bash` can `cd` anywhere. That is fine for an agent working on the repo it was
 * launched in, and wrong for these - a render agent is building one module and has no
 * business reading the rest of the project, let alone writing to it.
 *
 * So the tools are rebuilt from pi's own factories with a check in front of every path, and
 * `bash` runs in the project's VM (see `vm.ts`). Both reach the whole of `plain_modules` - every
 * module's code and tests - and nothing above it: not the specs, not the rest of the project.
 */

export interface Confinement {
  /** Where the agent starts and where relative paths resolve. It sees the plain_modules this is in. */
  workdir: string;
  /** Narrower than that: the only folders its file tools may read. */
  read?: string[];
  /** The only folders they may write; none, and it has no write or edit tool at all. */
  write?: string[];
  /** No shell either - for an agent that only reads. */
  noBash?: boolean;
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
  return modulesRootOf(dir);
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

/** The working notes are written through update_notes, a line at a time - never as a file. And the record of what the code is built from is the harness's alone. */
function refuseNotes(path: string): void {
  if (basename(path) === RECORD_FILE) {
    throw new ConfinementError(
      `${RECORD_FILE} is the harness's record of what the code is built from: it writes it when work lands, and no agent does.`,
    );
  }
  if (basename(path) !== NOTES_FILE) return;
  throw new ConfinementError(
    `${NOTES_FILE} is not written as a file. Call update_notes to add, change or remove its lines.`,
  );
}

/**
 * What is the harness's, not the agent's, to write: the project's testing scripts - the harness
 * runs them, through run_unit_tests and run_conformance_tests - and the specs. A copy of either in
 * the codebase is an agent running its own version of what the harness runs, or building from a
 * spec it was never meant to hold.
 */
function refuseHarnessFiles(path: string): void {
  const name = basename(path);
  if (path.split(sep).includes("test_scripts") || /^(run_unittests|run_unit_tests|run_conformance_tests|prepare_environment)[^/]*\.sh$/.test(name)) {
    throw new ConfinementError(
      `${name} is a copy of the project's testing scripts, and those are not written here. They are not in your ` +
        "workspace, and are never copied, recreated or run by you: call run_unit_tests and run_conformance_tests, " +
        "which run them exactly as the harness does.",
    );
  }
  if (name.endsWith(".plain")) {
    throw new ConfinementError(
      `${name} is a ***plain spec, and specs are not written here. What you build from is in your prompt; the code is ` +
        "what you write.",
    );
  }
}

function check(raw: string | undefined, cwd: string, roots: string[], verb: "read" | "write"): void {
  if (raw === undefined) return;
  const path = absolutize(raw, cwd);
  if (!insideAny(path, roots)) refuse(path, roots, verb);
  if (verb === "write") {
    refuseNotes(path);
    refuseHarnessFiles(path);
  }
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
    if (verb === "write") {
      refuseNotes(path);
      refuseHarnessFiles(path);
    }
  };
}

export interface ConfinedTools {
  tools: AnyTool[];
  /** Tool names, for the session's `tools` list. */
  names: string[];
  /** One line for the log: what is enforced and how. */
  description: string;
  /** The agent's sandbox, as it is told it in its system prompt: what it can reach, and that nothing else exists. */
  note: string;
}

/**
 * An agent's sandbox, in words, for its system prompt - from the fence itself, so it says exactly
 * what is enforced. An agent that does not know where its walls are spends its turns walking into
 * them: searching parent folders, absolute paths and /tmp for what it was never given.
 */
export function sandboxNote(fence: { read: string[]; write: string[]; shell?: string[]; shellReadOnly?: string[] }): string {
  const list = (dirs: string[]) => dirs.map((dir) => `\`${dir}\``).join(", ");
  return [
    "<sandbox>",
    "You work inside a sandbox, and only there.",
    `- Your file tools can read ${list(fence.read)}${fence.write.length === 0 ? ", and write nothing: you only read." : `, and write ${list(fence.write)}.`}`,
    fence.shell === undefined
      ? "- You have no shell."
      : `- Your shell runs in a Linux VM that holds only ${list(fence.shell)}${fence.shell.length > 1 ? " - the last is the package caches and the copies test runs use" : ""}.` +
        (fence.shellReadOnly !== undefined && fence.shellReadOnly.length > 0 ? ` In it, ${list(fence.shellReadOnly)} ${fence.shellReadOnly.length === 1 ? "is" : "are"} read only.` : ""),
    "Nothing else exists for you: not the rest of the machine, not the specification files, not the other folders of the",
    "project. Everything you need that is not in your sandbox is in your prompt. Do not look for anything outside it - no",
    "searching parent folders, absolute paths, /tmp or the home folder - and never try to get around the sandbox. It is",
    "enforced: every attempt fails, and only costs time.",
    "</sandbox>",
  ].join("\n");
}

export function confinedTools(c: Confinement): ConfinedTools {
  const workdir = resolve(c.workdir);
  // Every agent's file tools see the whole of plain_modules and nothing above it; its VM, only its module.
  const root = ceilingFor(workdir);
  const read = (c.read ?? [root]).map((dir) => resolve(dir));
  const write = (c.write ?? [root]).map((dir) => resolve(dir));

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

  // Nothing to write to: no tool that writes.
  if (write.length === 0) {
    for (const name of ["write", "edit"]) tools.splice(tools.findIndex((tool) => tool.name === name), 1);
  }

  let description = `file tools fenced to ${read.join(", ")}${write.length === 0 ? ", read only" : ""}`;

  // The shell runs in its module's VM, which holds that module's folder and the VM scratch and
  // nothing else. Whatever it cds to or cats, nothing outside them exists.
  if (c.noBash === true) {
    description += ", no bash";
  } else if (vmSupported()) {
    const bash = createBashToolDefinition(workdir, {
      operations: vmBashOperations(),
      exposeSessionEnvironment: false,
    });
    bash.description = `${bash.description}\n\n${vmEnvironmentNote()}\n\n${timeLimitNote()}`;
    tools.push(bash, installSystemPackagesTool(workdir));
    description += ", bash in a VM holding only its module";
  } else {
    // Without a VM there is no honest way to fence a shell, so the agent does not get one.
    // Everything it needs to do to files it can do with the tools above.
    description += ", no bash (no sandbox VM on this platform)";
  }

  const shell = tools.some((tool) => tool.name === "bash") ? vmHolds(workdir) : undefined;
  const shellReadOnly = shell !== undefined ? vmReadOnly(workdir) : undefined;
  return { tools, names: tools.map((t) => t.name), description, note: sandboxNote({ read, write, shell, shellReadOnly }) };
}

/** What the agent is told about how long its commands may run. */
function timeLimitNote(): string {
  return (
    `A command is stopped after ${Math.round(COMMAND_TIMEOUT_MS / 1000)} seconds unless you give it a timeout, and ` +
    `after ${Math.round(MAX_COMMAND_TIMEOUT_MS / 1000)} at most. Never run one that does not end on its own in the ` +
    "foreground: start a server or a watcher in the background (`cmd > app.log 2>&1 &`), and give a command that " +
    "asks for input its input (`--yes`, `-B`, `CI=1`, `< /dev/null`)."
  );
}

/**
 * Install what the VM does not have - a language, a compiler, a system library - with `apk`.
 * The packages are remembered for the project, and every VM it starts installs them again.
 */
function installSystemPackagesTool(dir: string): AnyTool {
  return defineTool({
    name: "install_system_packages",
    label: "Install system packages",
    description:
      "Install Alpine Linux packages into the VM your commands run in - a language runtime, a compiler, a system " +
      "library or tool (e.g. ruby, php83, openjdk17, dotnet8-sdk, sqlite-dev). They stay installed for every later " +
      "render of this project. Use it for what the project's own package manager cannot provide; project " +
      "dependencies still go in the project's manifest.",
    promptSnippet: "install a missing language, compiler or system library in the VM",
    parameters: Type.Object({
      packages: Type.Array(Type.String(), { description: "Alpine package names, e.g. [\"ruby\", \"ruby-dev\"]" }),
    }),
    async execute(_id, params, signal) {
      const { exitCode, output } = await installSystemPackages(dir, params.packages, { signal });
      return {
        content: [
          {
            type: "text" as const,
            text: exitCode === 0 ? `Installed ${params.packages.join(", ")}.\n\n${truncateOutput(output)}` : `exit code: ${exitCode}\n\n${truncateOutput(output)}`,
          },
        ],
        details: { packages: params.packages, exitCode },
      };
    },
  });
}
