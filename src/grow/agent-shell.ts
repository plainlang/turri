import { basename, dirname, join, resolve, sep } from "node:path";
import { readProjectConfig, stackOf } from "../config.ts";
import { reportNote } from "./activity.ts";
import { agentEnvironment, DARWIN_TEMP_SUFFIX, packageCacheDir, TOOLCHAIN_VARIABLES } from "./agent-env.ts";
import { afterCommand, auditMessage, beforeCommand } from "./audit.ts";
import { checkCommand, machineReadable, type CheckResult, type CommandFence } from "./command-check.ts";
import { darwinUserDirs, machineFor, sandboxAvailable, sandboxWrap, type SandboxFence, type Wall } from "./os-sandbox.ts";
import { MODULES_DIR, projectRootOf } from "./paths.ts";
import { RECORD_FILE } from "./records.ts";
import { runCommand, type RunResult } from "./shell.ts";

/**
 * An agent's command on this machine, behind every wall at once: the command check before it, the module's scrubbed
 * environment and the OS sandbox around it - where one is up - and the audit after it. Built once per agent from its
 * role's fence, the same as its file tools': what it may read and write.
 */

export interface ShellRole {
  /** Where its commands start - the agent's folder. */
  workdir: string;
  /** The folders it may read; its workdir when not given. */
  read?: string[];
  /** The folders it may write; its workdir when not given, none for a role that only reads. */
  write?: string[];
}

export interface AgentShell {
  /** The wall under the check and the audit. */
  readonly wall: Wall;
  /** The environment its commands get. */
  readonly env: Record<string, string>;
  /** One line for the job log: which walls are up. */
  readonly description: string;
  /** The check alone: whether a command would be run. */
  check(command: string): CheckResult;
  /** How a command is run behind the wall. */
  wrap(argv: string[]): string[];
  /** Run a command behind every wall; refused, it is not run and says why (exit 126). */
  run(command: string, options?: { timeoutMs?: number; signal?: AbortSignal; onData?: (data: Buffer) => void; timeoutNote?: (ms: number) => string }): Promise<RunResult>;
  /** Run `work` - something that starts a command another way - under the audit; what it puts back, for the agent. */
  audited<T>(work: () => Promise<T>): Promise<{ value: T; note?: string }>;
}

/**
 * What a module's shell writes beside its roots: its home, its TMPDIR, the package caches - and on macOS its own folder
 * in the per-user temporary folder, where its JVMs keep the attach sockets Mockito's inline mocks and jcmd go through.
 */
export function writableFor(env: Record<string, string>, moduleDir: string): string[] {
  const darwinTemp = darwinUserDirs().temp;
  const suffix = env[DARWIN_TEMP_SUFFIX];
  return [env.HOME!, env.TMPDIR!, packageCacheDir(moduleDir), ...(darwinTemp !== undefined && suffix !== undefined ? [join(darwinTemp, suffix)] : [])];
}

/** The module a folder is part of: `plain_modules/<module>`, or - a build folder elsewhere - its parent. */
function moduleOf(dir: string): string {
  const parts = resolve(dir).split(sep);
  const index = parts.lastIndexOf(MODULES_DIR);
  return index >= 0 && parts.length > index + 1 ? parts.slice(0, index + 2).join(sep) : dirname(resolve(dir));
}

export function agentShell(role: ShellRole, options: { wall?: Wall; busy?: (moduleDir: string) => boolean } = {}): AgentShell {
  const workdir = resolve(role.workdir);
  const read = (role.read ?? [workdir]).map((dir) => resolve(dir));
  const write = (role.write ?? [workdir]).map((dir) => resolve(dir));
  const moduleDir = moduleOf(workdir);
  const project = projectRootOf(workdir);
  const { env } = agentEnvironment(moduleDir);
  const root = projectRootOf(moduleDir);
  const toolchains = readProjectConfig(root, stackOf(root)).toolchains ?? [];
  const machine = machineFor(env, TOOLCHAIN_VARIABLES, toolchains);
  const writable = writableFor(env, moduleDir);

  const commandFence: CommandFence = {
    cwd: workdir,
    read,
    write,
    home: env.HOME,
    tmp: env.TMPDIR,
    writable,
    readable: [...machineReadable(), ...machine],
    platform: process.platform === "win32" ? "win32" : "posix",
  };
  const sandboxFence: SandboxFence = {
    cwd: workdir,
    read: read.filter((dir) => !write.includes(dir)),
    write,
    writable,
    machine,
    deny: ["code", "tests"].map((part) => join(moduleDir, part, RECORD_FILE)),
  };
  const wall = options.wall ?? sandboxAvailable();
  const wrap = sandboxWrap(wall, sandboxFence);
  const auditScope = { project, module: moduleDir, write, readOnly: read.filter((dir) => !write.includes(dir)), ...(options.busy !== undefined ? { busy: options.busy } : {}) };

  const audited = async <T>(work: () => Promise<T>): Promise<{ value: T; note?: string }> => {
    const before = beforeCommand(auditScope);
    let value: T;
    try {
      value = await work();
    } catch (error) {
      // Stopped or failed: what it did is put back all the same.
      afterCommand(before);
      throw error;
    }
    const result = afterCommand(before);
    if (result.putBack.length > 0) reportNote(`  an agent's command changed ${result.putBack.join(", ")} - put back`);
    if (result.left.length > 0) reportNote(`  an agent's command changed ${result.left.join(", ")}, where another pulse is at work - left`);
    if (result.lost.length > 0) reportNote(`  an agent's command changed ${result.lost.join(", ")}, and it could not be put back`);
    if (result.conversation.length > 0) reportNote(`  the conversation changed ${result.conversation.join(", ")} while an agent's command ran - left as it is`);
    const note = auditMessage(result);
    return { value, ...(note !== undefined ? { note } : {}) };
  };

  const description =
    wall.kind === "none"
      ? `commands on this machine behind the command check and the audit - no OS sandbox: ${wall.why}`
      : `commands on this machine behind the command check, ${wall.kind === "seatbelt" ? "Seatbelt" : "bubblewrap"} and the audit`;

  return {
    wall,
    env,
    description,
    check: (command) => checkCommand(command, commandFence),
    wrap,
    async run(command, runOptions = {}) {
      const checked = checkCommand(command, commandFence);
      if (!checked.ok) {
        reportNote(`  refused an agent's command (${checked.rule}): ${command.length > 120 ? `${command.slice(0, 120)}...` : command}`);
        const output = `Not run: ${checked.reason}`;
        runOptions.onData?.(Buffer.from(output));
        return { exitCode: 126, output };
      }
      const { value, note } = await audited(() =>
        runCommand(command, {
          cwd: workdir,
          env,
          wrap,
          ...(runOptions.timeoutMs !== undefined ? { timeoutMs: runOptions.timeoutMs } : {}),
          ...(runOptions.signal !== undefined ? { signal: runOptions.signal } : {}),
          ...(runOptions.onData !== undefined ? { onData: runOptions.onData } : {}),
          ...(runOptions.timeoutNote !== undefined ? { timeoutNote: runOptions.timeoutNote } : {}),
        }),
      );
      if (note === undefined) return value;
      runOptions.onData?.(Buffer.from(`\n${note}\n`));
      return { ...value, output: `${value.output}\n${note}\n` };
    },
    audited,
  };
}
