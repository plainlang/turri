import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { credentialRefusal, isCredentialFile } from "./credentials.ts";
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
import { keptShellOutput, outputsDir, readOutputTool } from "./testing.ts";
import { reportNote } from "./activity.ts";
import { agentShell, type AgentShell } from "./agent-shell.ts";
import { ENVIRONMENT_ERROR_TOOL } from "./environment-error.ts";
import { anotherPulseIn, COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS } from "./shell.ts";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

/**
 * Keeping a rendering agent inside its own directory.
 *
 * pi's `cwd` is where relative paths start from, not a fence: an absolute path resolves to
 * itself and `bash` can `cd` anywhere. That is fine for an agent working on the repo it was
 * launched in, and wrong for these - a render agent is building one module and has no
 * business reading the rest of the project, let alone writing to it.
 *
 * So the tools are rebuilt from pi's own factories with a check in front of every path, and
 * `bash` runs on this machine behind every wall at once (see `agent-shell.ts`): the command check,
 * the module's own environment, the OS sandbox where one is up, the audit. Both reach the agent's
 * own folder - its module's `code/`, unless the role is given others - and nothing else: not another
 * module, not turri's scratch area or the module's lineage, not the specs, not the rest of the project.
 */

export interface Confinement {
  /** Where the agent starts and where relative paths resolve - and, unless `read` and `write` say otherwise, all its file tools reach. */
  workdir: string;
  /** The only folders its file tools may read: its workdir when not given. */
  read?: string[];
  /** The only folders they may write - its workdir when not given; none, and it has no write or edit tool at all. */
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

/** Resolve symlinks as far as the path exists, so a link cannot walk out of a root. */
function canonical(path: string): string {
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

/** The working notes are written through update_notes, a line at a time - never as a file. */
function refuseNotes(path: string): void {
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
  if (isCredentialFile(path)) throw new ConfinementError(credentialRefusal(path));
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

/** The record of what the code is built from is the harness's: no agent reads it either - nothing in it is theirs to go by. */
function refuseRecord(path: string): void {
  if (basename(path) !== RECORD_FILE) return;
  throw new ConfinementError(`${RECORD_FILE} is the harness's record of what the code is built from: no agent reads or writes it.`);
}

/** An output turri kept, named as the cut named it: not a file in the agent's folder, but read_output's to read. */
function refuseKeptOutput(raw: string, path: string, cwd: string): void {
  const id = basename(raw);
  if (id !== raw.trim() || existsSync(path) || !existsSync(join(outputsDir(cwd), id))) return;
  throw new ConfinementError(`${id} is an output turri kept, not a file in your folder: call read_output with that id.`);
}

function check(raw: string | undefined, cwd: string, roots: string[], verb: "read" | "write"): void {
  if (raw === undefined) return;
  const path = absolutize(raw, cwd);
  if (verb === "read") refuseKeptOutput(raw, path, cwd);
  if (!insideAny(path, roots)) refuse(path, roots, verb);
  refuseRecord(path);
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

/** Same tool, its listing without the record of what the code is built from: ls, grep and find do not show it. */
function withoutRecord(def: AnyTool): AnyTool {
  return {
    ...def,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = await def.execute(toolCallId, params, signal, onUpdate, ctx);
      const content = result.content.map((part) =>
        part.type === "text" ? { ...part, text: part.text.split("\n").filter((line) => !line.includes(RECORD_FILE)).join("\n") } : part,
      );
      return { ...result, content };
    },
  };
}

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
    refuseRecord(path);
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
 * An agent's walls, in words, for its system prompt - from its fence itself, so it says exactly what is enforced, the
 * same on every platform. An agent that does not know where its walls are spends its turns walking into them. Its own
 * folders by absolute path and no other; matter-of-fact about what happens on a reach outside - refused, or put back -
 * and no warning. `environmentTool`: the tool an agent reports a missing piece of the machine with, when it has one.
 */
export function sandboxNote(fence: { read: string[]; write: string[]; shell: boolean; environmentTool?: string }): string {
  const list = (dirs: string[]) => dirs.map((dir) => `\`${dir}\``).join(" and ");
  const readOnly = fence.read.filter((dir) => !fence.write.includes(dir));
  const isTests = (dir: string) => basename(dir) === "tests" || dir.split(sep).includes("tests");
  const lines: string[] = ["<sandbox>"];

  if (fence.write.length === 0) {
    lines.push(`You read ${list(fence.read)}, and write nothing${fence.shell ? ": not with your file tools, not with your shell." : "."}`);
  } else if (readOnly.length === 0) {
    lines.push(
      fence.write.length === 1
        ? `You work in one folder: ${list(fence.write)}. Your file tools read and write it, and nothing else.`
        : `You work in ${list(fence.write)}. Your file tools read and write them, and nothing else.`,
    );
  } else {
    const writesTests = fence.write.every(isTests);
    const readsTests = readOnly.every(isTests);
    const what = writesTests ? " - the code under test -" : readsTests ? " - the conformance tests the code must pass -" : "";
    const why = writesTests ? ": you write tests, not code" : readsTests ? ": you fix the code, not the tests" : "";
    lines.push(
      `You work in ${list(fence.write)}. Your file tools read and write it. They also read ${list(readOnly)}${what} but never write ` +
        `${readOnly.length === 1 ? "it" : "them"}${why}.`,
    );
  }

  if (fence.shell) {
    const home = fence.write[0] ?? fence.read[0];
    lines.push(
      "",
      `Your shell runs on this machine, in ${home !== undefined ? `\`${home}\`` : "your folder"}, with this machine's toolchains. It also has a home ` +
        "folder and a temporary folder of its own (`$HOME`, `$TMPDIR`), and the package caches your build tools already " +
        "use. The network is open. Nothing else on the machine exists for you: not the specification files, not the " +
        `project's other folders or modules, not the person's home.${readOnly.length > 0 && fence.write.length > 0 ? ` ${list(readOnly)} ${readOnly.length === 1 ? "is" : "are"} read only in your shell too.` : ""}`,
      "",
      "- Everything you need is in this prompt. Do not look outside your folder: no parent folders, no absolute paths",
      "  elsewhere. A command that names a path outside is refused before it runs. Anything a command changes outside is",
      "  put back, and you are told.",
    );
    const report =
      fence.environmentTool !== undefined
        ? `report it as an environment error with ${fence.environmentTool}`
        : "say so plainly - what is missing and what needs it - and end your turn";
    lines.push(
      fence.write.length > 0
        ? "- The project's dependencies are yours: declare them in the build manifest, and let the build tools fetch them."
        : "- You install nothing.",
      `${fence.write.length > 0 ? "  Installing anything else is not" : "  Nor is installing anything on the machine yours"}: no toolchains, system packages, drivers, global packages or \`sudo\`. If the`,
      `  machine lacks something the code needs, ${report}, name what is missing, and go no further with what depends on it.`,
      "  The person decides.",
      "- Ports and processes: you may stop only what you started. If a port is taken by something else, use another port.",
      "  `ps` may show nothing but what you started: check a server you started with `kill -0 $!`, its log, or a request to it.",
      "- Temporary files go in `$TMPDIR`: `/tmp` is outside your walls.",
    );
  } else {
    lines.push("You have no shell. Nothing else exists for you; everything you need is in this prompt.");
  }
  lines.push("</sandbox>");
  return lines.join("\n");
}

/** pi's bash tool over an agent's shell: each command checked, run behind its walls, audited. */
export function hostBashOperations(shell: AgentShell): BashOperations {
  return {
    exec: async (command, _cwd, { onData, signal, timeout }) => {
      const result = await shell.run(command, {
        onData,
        ...(signal !== undefined ? { signal } : {}),
        // The agent's own timeout, up to the longest allowed; the limit when it gave none.
        timeoutMs: timeout && timeout > 0 ? Math.min(timeout * 1000, MAX_COMMAND_TIMEOUT_MS) : COMMAND_TIMEOUT_MS,
      });
      return { exitCode: result.exitCode };
    },
  };
}

export function confinedTools(c: Confinement): ConfinedTools {
  const workdir = resolve(c.workdir);
  // An agent's file tools reach its own folder and what its role is given beside it, and nothing else.
  const read = (c.read ?? [workdir]).map((dir) => resolve(dir));
  const write = (c.write ?? [workdir]).map((dir) => resolve(dir));

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
    withoutRecord(guard(createLsToolDefinition(workdir), (p) => check(p.path, workdir, read, "read"))),
    withoutRecord(
      guard(createGrepToolDefinition(workdir), (p) => {
        check(p.path, workdir, read, "read");
        checkPattern(p.glob);
      }),
    ),
    withoutRecord(
      guard(createFindToolDefinition(workdir), (p) => {
        check(p.path, workdir, read, "read");
        checkPattern(p.pattern);
      }),
    ),
  ];

  // Nothing to write to: no tool that writes.
  if (write.length === 0) {
    for (const name of ["write", "edit"]) tools.splice(tools.findIndex((tool) => tool.name === name), 1);
  }

  let description = `file tools fenced to ${read.join(", ")}${write.length === 0 ? ", read only" : ""}`;

  // The shell runs on this machine behind every wall at once: the check, the module's environment, the OS sandbox
  // where one is up, the audit - its role's fence the same as its file tools'.
  if (c.noBash === true) {
    description += ", no bash";
  } else {
    const shell = agentShell({ workdir, read, write }, { busy: anotherPulseIn });
    const bash = createBashToolDefinition(workdir, { operations: hostBashOperations(shell), exposeSessionEnvironment: false });
    bash.description = `${bash.description}\n\n${hostEnvironmentNote()}\n\n${timeLimitNote()}`;
    tools.push(withKeptOutput(bash, workdir));
    description += `, bash - ${shell.description}`;
    // Which walls are up, in the job's log.
    reportNote(`  ${shell.description}`);
    // A cut output - a command's, a test run's - is read whole through read_output, never by a path.
    tools.push(readOutputTool(workdir));
  }

  // An agent with a shell is given report_environment_error with it (pi.ts), and its walls name it.
  return {
    tools,
    names: tools.map((t) => t.name),
    description,
    note: sandboxNote({ read, write, shell: c.noBash !== true, ...(c.noBash !== true ? { environmentTool: ENVIRONMENT_ERROR_TOOL } : {}) }),
  };
}

/** What the agent is told, with its bash, about where its commands run. */
function hostEnvironmentNote(): string {
  return (
    "Commands run on this machine, from your folder, with this machine's toolchains, your own $HOME and $TMPDIR, and " +
    "the open network. A command that names a path outside your folders is refused before it runs; what one changes " +
    "outside them is put back, and you are told. You install nothing on the machine: the project's dependencies go " +
    "into the project, through its manifest."
  );
}

/** The shell, its cut output kept where read_output reads it rather than in a temporary file on the host. */
function withKeptOutput(bash: AnyTool, workdir: string): AnyTool {
  return {
    ...bash,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = await bash.execute(toolCallId, params, signal, onUpdate, ctx);
      const content = result.content.map((part) => (part.type === "text" ? { ...part, text: keptShellOutput(workdir, part.text) } : part));
      return { ...result, content };
    },
  };
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

