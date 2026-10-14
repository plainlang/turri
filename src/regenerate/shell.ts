import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { currentStopSignal } from "./activity.ts";
import { maskingStream } from "./masking.ts";

/**
 * The one way a command runs on this machine - an agent's, a testing script, a service.
 *
 * Each command runs in a process group of its own, so the time limit and a stop end it with everything it started, a
 * server put in the background included. What a command leaves running when it ends - a server for the tests to talk
 * to - is the pulse's: it runs on until the pulse ends (`withPulse`), and is killed then, as everything still running is
 * when turri exits. turri killed outright cannot do that itself, so a watcher - one small shell for each turri - does it
 * within two seconds; and the groups a turri left that nothing killed (the watcher gone too) are swept when turri next
 * starts (`sweepOrphanedGroups`).
 *
 * On Windows there are no process groups: a command's process tree is killed with `taskkill /T /F`, which reaches what
 * is still a child of it - best effort, and nothing watches a turri killed outright.
 */

export interface RunResult {
  exitCode: number;
  output: string;
  /** Stopped by its time limit, rather than ending on its own. */
  timedOut?: boolean;
}

export interface RunOptions {
  /** Where it runs from. */
  cwd: string;
  /** Its time limit: COMMAND_TIMEOUT_MS when not given. */
  timeoutMs?: number;
  /** What the output says when the time limit stops it; the note for a command, by default. */
  timeoutNote?: (timeoutMs: number) => string;
  /** Ends it at once - as the job's own stop signal does, given or not. */
  signal?: AbortSignal;
  /** Its output, as it comes. */
  onData?: (data: Buffer) => void;
  /** Its whole environment: this process's when not given. */
  env?: NodeJS.ProcessEnv;
  /** The command line turned into another that runs it - an OS sandbox around it. */
  wrap?: (argv: string[]) => string[];
}

/**
 * How long a command may run before it is stopped - an agent's own, its tests, the harness's runs. Nothing an agent
 * starts may hang a build: a server started in the foreground, a watcher, a prompt waiting for input would otherwise
 * hold the agent's turn, and the job, forever. TURRI_COMMAND_TIMEOUT sets it, in seconds.
 */
export const COMMAND_TIMEOUT_MS = Number(process.env.TURRI_COMMAND_TIMEOUT ?? 120) * 1000;

/** The longest an agent may ask one of its own commands to run for. */
export const MAX_COMMAND_TIMEOUT_MS = Math.max(COMMAND_TIMEOUT_MS, 30 * 60_000);

/** What a command that ran out of time leaves in its output, for the agent to act on. */
export function timedOutNote(timeoutMs: number): string {
  return (
    `\n[stopped after ${Math.round(timeoutMs / 1000)}s, the time limit. A command that never ends on its own - a ` +
    "server, a watcher, a prompt waiting for input - has to be started in the background (`cmd > app.log 2>&1 &`) " +
    "or given its input; a slow one can be given a longer timeout.]"
  );
}

/** How long a command's output is waited for once it has ended: past that, what holds it is a server it left behind. */
const OUTPUT_GRACE_MS = 100;

const WINDOWS = process.platform === "win32";

/** Every group this turri started that may still be running: by its leader's process id, which is the group's id. */
const groups = new Set<number>();

/** A pulse running: the groups it started, and the modules it works in. */
interface Pulse {
  groups: Set<number>;
  modules: Set<string>;
}

/** The current pulse. */
const pulse = new AsyncLocalStorage<Pulse>();

/** Every pulse running in this process. */
const pulses = new Set<Pulse>();

/**
 * Whether a pulse other than the current one is at work in `moduleDir` - what changes there is that pulse's, and the
 * audit leaves it.
 */
export function anotherPulseIn(moduleDir: string): boolean {
  const mine = pulse.getStore();
  for (const other of pulses) if (other !== mine && other.modules.has(moduleDir)) return true;
  return false;
}

/** Where each running turri records its groups, a file named for its process id: for its watcher, and the sweep. */
export function groupRecordsDir(): string {
  return join(tmpdir(), "turri-groups");
}

function recordFile(): string {
  return join(groupRecordsDir(), `${process.pid}`);
}

function writeRecord(): void {
  try {
    if (groups.size === 0) {
      rmSync(recordFile(), { force: true });
      return;
    }
    mkdirSync(groupRecordsDir(), { recursive: true });
    writeFileSync(recordFile(), [...groups].map((group) => `${group}\n`).join(""));
  } catch {
    // Only the watcher and the sweep read it; exit kills the groups all the same.
  }
}

let watching = false;

/**
 * A small shell beside this turri that waits for it to end, then kills every group it recorded - for a turri killed
 * outright, which runs no exit handler. It ends with the turri; it holds nothing open.
 */
function watch(): void {
  if (watching || WINDOWS) return;
  watching = true;
  const file = recordFile();
  const script = [
    `while kill -0 ${process.pid} 2>/dev/null; do sleep 2; done`,
    `[ -f '${file}' ] || exit 0`,
    // No `--` after the signal: dash, /bin/sh on Debian and Ubuntu, reads it as a process id and kills nothing.
    `while read -r group; do kill -KILL "-$group" 2>/dev/null; done < '${file}'`,
    `rm -f '${file}'`,
  ].join("\n");
  try {
    spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // The sweep at the next start is there still.
  }
}

function track(group: number): void {
  groups.add(group);
  pulse.getStore()?.groups.add(group);
  writeRecord();
  watch();
}

function forget(group: number): void {
  groups.delete(group);
  writeRecord();
}

/** Whether anything in the group still runs. */
function groupAlive(group: number): boolean {
  if (WINDOWS) return false;
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kill a group, everything in it. */
function killGroup(group: number): void {
  if (WINDOWS) {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(group)], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-group, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/**
 * Run `work` - a pulse - and kill every group it started when it ends, however it ends: what an agent left running in
 * the background is the pulse's, and goes with it. Groups of a pulse running beside it are left alone. `modules`: the
 * module folders it works in - its lanes - which the audit of another pulse's commands leaves to it.
 */
export async function withPulse<T>(work: () => Promise<T>, options: { modules?: string[] } = {}): Promise<T> {
  const mine: Pulse = { groups: new Set(), modules: new Set(options.modules ?? []) };
  pulses.add(mine);
  try {
    return await pulse.run(mine, work);
  } finally {
    pulses.delete(mine);
    for (const group of mine.groups) {
      killGroup(group);
      forget(group);
    }
  }
}

/** Kill every group this turri started. Called as it exits; the tests call it between files. */
export function killAllGroups(): void {
  for (const group of groups) killGroup(group);
  groups.clear();
  writeRecord();
}

/**
 * Kill the groups turris that are gone left behind - killed outright, their watcher gone too - from their records in
 * `dir`. A running turri's are its own. Returns how many groups were still there to kill.
 */
export function sweepOrphanedGroups(dir: string = groupRecordsDir()): number {
  if (WINDOWS || !existsSync(dir)) return 0;
  let killed = 0;
  for (const name of readdirSync(dir)) {
    const owner = Number(name);
    if (!Number.isInteger(owner) || owner === process.pid || processAlive(owner)) continue;
    const file = join(dir, name);
    try {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const group = Number(line.trim());
        if (!Number.isInteger(group) || group <= 1 || !groupAlive(group)) continue;
        killGroup(group);
        killed += 1;
      }
    } finally {
      rmSync(file, { force: true });
    }
  }
  return killed;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Alive, but not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Run `command` with bash on this machine, from `cwd`, in a process group of its own.
 *
 * It has a time limit - COMMAND_TIMEOUT_MS unless given another - and ends at once when it is stopped, by the caller's
 * signal or the job's; either way its whole group is killed. Ended on its own, what it left in the background runs on
 * until its pulse ends.
 */
export async function runCommand(command: string, options: RunOptions): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const signals = [options.signal, currentStopSignal()].filter((signal): signal is AbortSignal => signal !== undefined);
  // An abort that has already happened fires no event: the command is not started at all.
  if (signals.some((signal) => signal.aborted)) throw new Error("aborted");
  const argv = options.wrap !== undefined ? options.wrap(["bash", "-c", command]) : ["bash", "-c", command];
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: !WINDOWS,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const group = child.pid;
  if (group !== undefined) track(group);

  // The credentials passed to agents are masked as the output streams, before anything sees it.
  let output = "";
  const masked = maskingStream((data) => {
    output += data.toString("utf8");
    options.onData?.(data);
  });
  const take = (data: Buffer) => masked.write(data);
  child.stdout.on("data", take);
  child.stderr.on("data", take);

  let timedOut = false;
  let stopped = false;
  const kill = () => {
    if (group !== undefined) killGroup(group);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  const onAbort = () => {
    stopped = true;
    kill();
  };
  for (const signal of signals) signal.addEventListener("abort", onAbort, { once: true });

  const exitCode = await new Promise<number>((done) => {
    child.on("error", (error) => {
      take(Buffer.from(String(error.message)));
      done(1);
    });
    child.on("exit", (code, signal) => {
      // The rest of its output, unless a server it left behind holds the pipe: that is not waited for.
      const grace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, OUTPUT_GRACE_MS);
      child.on("close", () => clearTimeout(grace));
      const ended = () => done(code ?? 128 + (signal !== null ? (constants.signals[signal] ?? 0) : 0));
      const open = [child.stdout, child.stderr].filter((stream) => !stream.closed);
      let left = open.length;
      if (left === 0) ended();
      for (const stream of open) stream.once("close", () => (--left === 0 ? ended() : undefined));
    });
  });

  masked.end();
  clearTimeout(timer);
  for (const signal of signals) signal.removeEventListener("abort", onAbort);
  if (group !== undefined && !groupAlive(group)) forget(group);
  if (stopped) throw new Error("aborted");
  if (timedOut) {
    const note = (options.timeoutNote ?? timedOutNote)(timeoutMs);
    options.onData?.(Buffer.from(note));
    return { exitCode: 124, output: `${output}${note}`, timedOut: true };
  }
  return { exitCode, output };
}

/**
 * Start `command` in the background, in a process group of its own, its output to `logFile` - a server an agent starts
 * to try from outside. It is its pulse's: running until stopped (`stopGroup`), and killed when the pulse ends.
 */
export function startInBackground(command: string, options: { cwd: string; env?: NodeJS.ProcessEnv; wrap?: (argv: string[]) => string[]; logFile: string }): { pid: number } {
  const argv = options.wrap !== undefined ? options.wrap(["bash", "-c", command]) : ["bash", "-c", command];
  const log = openSync(options.logFile, "a");
  try {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, env: options.env ?? process.env, detached: !WINDOWS, stdio: ["ignore", log, log], windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
    if (child.pid === undefined) throw new Error(`${argv[0]} could not be started`);
    track(child.pid);
    return { pid: child.pid };
  } finally {
    closeSync(log);
  }
}

/** Whether a process is still running. */
export function isRunning(pid: number): boolean {
  if (WINDOWS) return spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8", windowsHide: true }).stdout.includes(String(pid));
  return processAlive(pid);
}

/** Stop a group started in the background: asked to end, then - after `graceMs` - made to. */
export async function stopGroup(group: number, graceMs = 1000): Promise<void> {
  if (!WINDOWS) {
    try {
      process.kill(-group, "SIGTERM");
    } catch {
      // Already gone.
    }
    const end = Date.now() + graceMs;
    while (groupAlive(group) && Date.now() < end) await new Promise((done) => setTimeout(done, 50));
  }
  killGroup(group);
  forget(group);
}

process.on("exit", killAllGroups);

// A process ended by a signal never exits in the sense that runs the handler above: where nothing else handles the
// signal, exit properly on it.
for (const [signal, code] of [["SIGTERM", 143], ["SIGHUP", 129], ["SIGINT", 130]] as const) {
  process.once(signal, () => {
    if (process.listenerCount(signal) === 0) process.exit(code);
  });
}
