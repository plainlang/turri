import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { reportActivity } from "./activity.ts";
import { NOTES_FILE } from "./notes.ts";
import { vmScratchDir } from "./paths.ts";
import { STATE_FILE } from "./state.ts";
import { runUnitScript, scriptFailure } from "./test-scripts.ts";
import { COMMAND_TIMEOUT_MS, runInVm } from "./vm.ts";

/** Shared test-running and test-preservation machinery for both render tools. */

export interface TestRun {
  command: string;
  exitCode: number;
}

/** Up to this much of a run's output is shown: all of it when it fits, otherwise its end. */
const MAX_OUTPUT_CHARS = 60_000;
/** A test run has the same time limit as any command: see COMMAND_TIMEOUT_MS. */
export const RUN_TIMEOUT_MS = COMMAND_TIMEOUT_MS;

/** Full outputs kept per project, newest first; older ones are removed. */
const MAX_LOGS = 100;

/**
 * Output as an agent is shown it: whole when it fits, otherwise its last MAX_OUTPUT_CHARS - where a
 * test run says what failed and why. With `log` the whole output is kept in that file too, and the
 * cut says where.
 */
export function truncateOutput(text: string, log?: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const cut = text.length - MAX_OUTPUT_CHARS;
  const where = log !== undefined ? ` - the whole output is in ${log}; read it with read or grep` : "";
  return `... [${cut} characters cut from the start${where}] ...\n\n${text.slice(-MAX_OUTPUT_CHARS)}`;
}

/**
 * Keep a run's whole output where an agent can read it, when it is too long to be shown whole:
 * in the project's scratch area, inside plain_modules. Returns the file, or nothing when the
 * output fits.
 */
export function keepFullOutput(dir: string, label: string, output: string): string | undefined {
  if (output.length <= MAX_OUTPUT_CHARS) return undefined;
  try {
    const logs = join(vmScratchDir(dir), "logs");
    mkdirSync(logs, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = label.replace(/[^\w.-]+/g, "_").slice(0, 60);
    const file = join(logs, `${stamp}-${name}.log`);
    writeFileSync(file, output);
    const all = readdirSync(logs).sort();
    for (const old of all.slice(0, Math.max(0, all.length - MAX_LOGS))) rmSync(join(logs, old), { force: true });
    return file;
  } catch {
    return undefined;
  }
}

/** Output as an agent is shown it, with the whole of it kept in a file when it had to be cut. */
export function shownOutput(dir: string, label: string, output: string): string {
  return truncateOutput(output, keepFullOutput(dir, label, output));
}

/**
 * Run a command an agent chose, from `cwd`.
 *
 * In its module's VM, which holds only that module's folder and the VM scratch (see `vm.ts`), so
 * running the tests cannot be used to read the specification, the other modules, the rest of the
 * project, or anything else on the machine.
 */
export async function runCommand(cwd: string, command: string): Promise<{ exitCode: number; output: string }> {
  const { exitCode, output } = await runInVm(command, { cwd, timeoutMs: RUN_TIMEOUT_MS });
  return { exitCode, output: shownOutput(cwd, command, output) };
}

/**
 * Never part of the codebase: version control, installed dependencies, tool caches, and the
 * harness's own bookkeeping. Installed dependencies alone can be tens of thousands of files.
 */
export const NOT_CODE = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".plainwright",
  "target",
  ".cargo",
  // Working notes for the agents: not part of the codebase either (see notes.ts).
  NOTES_FILE,
  STATE_FILE,
]);

export function listFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      // The state file is the harness's own bookkeeping, not part of the codebase: it is
      // never shown to an agent as a file it wrote, copied forward to a requiring module,
      // or counted when asking whether anything has been built.
      if (NOT_CODE.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else found.push(relative(root, full));
    }
  };
  if (existsSync(root)) walk(root);
  return found.sort();
}

/** A tool that runs the tests and lets the harness see the result, rather than taking the agent's word. */
export const TEST_FILE_PATTERN = /(^|[._/-])(test|spec)|test[._-]|Test\.|\.test\.|_test\./i;
const TEST_CASE_PATTERN = /\bdef\s+test\w*|\bit\s*\(|\btest\s*\(|@Test\b|\bfunc\s+Test\w*/g;

/**
 * Which files look like tests, and roughly how many cases each holds.
 *
 * The count is a heuristic over common test idioms across languages. It is not a parser -
 * it exists to notice that tests went missing between one turn and the next, which is a
 * question worth asking even when the estimate is a case or two off.
 */
export function inventoryTests(root: string): Map<string, number> {
  const inventory = new Map<string, number>();
  for (const file of listFiles(root)) {
    if (!TEST_FILE_PATTERN.test(basename(file))) continue;
    let content: string;
    try {
      content = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    inventory.set(file, (content.match(TEST_CASE_PATTERN) ?? []).length);
  }
  return inventory;
}

export interface TestRemoval {
  file: string;
  before: number;
  after: number;
  deleted: boolean;
}

/** Test files that disappeared, or lost cases, between two inventories. */
export function findTestRemovals(
  before: Map<string, number>,
  after: Map<string, number>,
): TestRemoval[] {
  const removals: TestRemoval[] = [];
  for (const [file, count] of before) {
    const now = after.get(file);
    if (now === undefined) removals.push({ file, before: count, after: 0, deleted: true });
    else if (now < count) removals.push({ file, before: count, after: now, deleted: false });
  }
  return removals;
}

export function describeRemovals(removals: TestRemoval[]): string {
  return removals
    .map((removal) =>
      removal.deleted
        ? `- ${removal.file} was deleted (it held ~${removal.before} tests)`
        : `- ${removal.file} went from ~${removal.before} to ~${removal.after} tests`,
    )
    .join("\n");
}

/**
 * A deleted test is a silent way to make a suite pass. The rule is narrow on purpose:
 * a test may go only when it asserts nothing meaningful, never because it is failing.
 */
export function removalChallengePrompt(removals: TestRemoval[], subject: string): string {
  return [
    `Tests disappeared while you were working:`,
    "",
    describeRemovals(removals),
    "",
    `Removing ${subject} is only acceptable when a test asserts nothing meaningful - a test that`,
    "cannot fail, duplicates another exactly, or tests a thing the specification does not require.",
    "A test that is inconvenient, slow, or currently failing is not a reason to remove it.",
    "",
    "Restore every test you removed, unless it meets that bar. If a removal does meet it, keep it",
    "removed and state plainly which test it was and why it asserted nothing.",
  ].join("\n");
}



export type UnitVerdict =
  | { ok: true; command: string }
  | { ok: false; command?: string; prompt: string };

/**
 * The harness's own run of the unit tests, which is what "the tests pass" rests on.
 *
 * The agent runs whatever commands it likes while it works. Whether the code is done is the
 * project's unit testing script, run by the harness on the code as it now is - the same script,
 * the same way, every time (see test-scripts.ts).
 */
export async function verifyUnitSuite(buildDir: string, runs: TestRun[], script: string): Promise<UnitVerdict> {
  const run = await runUnitScript(buildDir, script);
  runs.push({ command: run.command, exitCode: run.exitCode });
  if (run.exitCode === 0) return { ok: true, command: run.command };
  return { ok: false, command: run.command, prompt: scriptFailure(run, "unit testing") };
}

/** Every file of the test code under `dirs`, by path, as it is now. */
export function snapshotFiles(dirs: string[]): Map<string, Buffer> {
  const snapshot = new Map<string, Buffer>();
  for (const dir of dirs) {
    for (const file of listFiles(dir)) snapshot.set(join(dir, file), readFileSync(join(dir, file)));
  }
  return snapshot;
}

/** The files under `dirs` that differ from the snapshot: changed, added or deleted. */
export function changedSince(snapshot: Map<string, Buffer>, dirs: string[]): string[] {
  const now = snapshotFiles(dirs);
  const changed = new Set<string>();
  for (const [path, content] of now) {
    const before = snapshot.get(path);
    if (before === undefined || !before.equals(content)) changed.add(path);
  }
  for (const path of snapshot.keys()) if (!now.has(path)) changed.add(path);
  return [...changed].sort();
}

/** Put the files under `dirs` back to the snapshot: its files restored, any others removed. */
export function restoreSnapshot(snapshot: Map<string, Buffer>, dirs: string[]): void {
  for (const path of changedSince(snapshot, dirs)) {
    const before = snapshot.get(path);
    if (before === undefined) rmSync(path, { force: true });
    else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, before);
    }
  }
}

const TEST_GUARD_ROUNDS = 3;

/**
 * Run an agent that fixes code with the conformance tests out of its reach - by the harness,
 * not by its file access, which covers the whole of `plain_modules`.
 *
 * The tests say what the specification requires; an agent told to make them pass could
 * otherwise do it by changing a test. So they are photographed before it starts and compared
 * when it finishes. Anything it changed is put back, and it is sent to fix the code instead,
 * until it leaves the tests alone or the rounds run out - after which the tests are put back
 * all the same. Returns the agent's last report and every test file it had to have restored.
 */
export async function keepingTestsUnchanged(input: {
  dirs: string[];
  /** The agent's first turn. */
  start: () => Promise<string>;
  /** Another turn, with this prompt. */
  again: (prompt: string) => Promise<string>;
  /** For the activity line: whose code is being fixed. */
  label: string;
}): Promise<{ report: string; restored: string[] }> {
  const dirs = input.dirs.filter((dir) => existsSync(dir));
  const snapshot = snapshotFiles(dirs);
  let report = await input.start();
  const restored = new Set<string>();
  for (let round = 0; round < TEST_GUARD_ROUNDS; round += 1) {
    const changed = changedSince(snapshot, dirs);
    if (changed.length === 0) break;
    restoreSnapshot(snapshot, dirs);
    for (const path of changed) restored.add(path);
    reportActivity(`${input.label}: the fixer changed ${changed.length} conformance test file${changed.length === 1 ? "" : "s"} - put back`);
    if (round === TEST_GUARD_ROUNDS - 1) break;
    report = await input.again(
      [
        "You changed conformance tests, which you must not do:",
        "",
        ...changed.map((path) => `- ${path}`),
        "",
        "They have been put back as they were. The tests state what the specification requires; a failing",
        "test is fixed by changing the code so the behaviour is what the specification describes. Fix the",
        "code, and leave every conformance test as it is.",
      ].join("\n"),
    );
  }
  return { report, restored: [...restored].sort() };
}
