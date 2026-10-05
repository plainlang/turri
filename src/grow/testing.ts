import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { reportActivity } from "./activity.ts";
import { maskSecrets } from "./masking.ts";
import { NOTES_FILE } from "./notes.ts";
import { vmScratchDir } from "./paths.ts";
import { RECORD_FILE } from "./records.ts";
import { missingToolchain, runUnitScript, scriptFailure } from "./test-scripts.ts";
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
 * cut says how to read it: through read_output, by the file's name - never by a path, which would
 * point the agent outside its walls.
 */
export function truncateOutput(text: string, log?: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const cut = text.length - MAX_OUTPUT_CHARS;
  const where = log !== undefined ? ` - the whole output is kept as \`${basename(log)}\`: read it with read_output` : "";
  return `... [${cut} characters cut from the start${where}] ...\n\n${text.slice(-MAX_OUTPUT_CHARS)}`;
}

/** Where the whole outputs are kept: the project's scratch area, read only through read_output. */
function outputsDir(dir: string): string {
  return join(vmScratchDir(dir), "logs");
}

/** Keep `output` whole, whatever its length, in the outputs folder. Returns the file, or nothing when it could not be written. */
function keepOutput(dir: string, label: string, output: string | Buffer): string | undefined {
  try {
    const logs = outputsDir(dir);
    mkdirSync(logs, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = label.replace(/[^\w.-]+/g, "_").slice(0, 60);
    const file = join(logs, `${stamp}-${name}.log`);
    writeFileSync(file, typeof output === "string" ? maskSecrets(output) : maskSecrets(output.toString("utf8")));
    const all = readdirSync(logs).sort();
    for (const old of all.slice(0, Math.max(0, all.length - MAX_LOGS))) rmSync(join(logs, old), { force: true });
    return file;
  } catch {
    return undefined;
  }
}

/**
 * Keep a run's whole output where an agent can read it, when it is too long to be shown whole:
 * in the project's scratch area, inside plain_modules. Returns the file, or nothing when the
 * output fits.
 */
export function keepFullOutput(dir: string, label: string, output: string): string | undefined {
  if (output.length <= MAX_OUTPUT_CHARS) return undefined;
  return keepOutput(dir, label, output);
}

/** pi's bash, cut short, names the temporary file the whole output is in - on the host, outside the agent's walls. */
const SHELL_FULL_OUTPUT = /Full output: (\S+)\]$/;

/**
 * A shell's output as the agent is shown it: when pi cut it and kept the whole in a temporary file of its own, the file
 * is taken into the outputs folder, and the agent pointed at read_output instead of at the file.
 */
export function keptShellOutput(dir: string, text: string): string {
  const found = SHELL_FULL_OUTPUT.exec(text);
  if (found === null) return text;
  let kept: string | undefined;
  try {
    kept = keepOutput(dir, "bash", readFileSync(found[1]!));
  } catch {
    kept = undefined;
  }
  const pointer = kept !== undefined ? `The whole output is kept as \`${basename(kept)}\`: read it with read_output]` : "The rest of the output was not kept]";
  return text.slice(0, found.index) + pointer;
}

/** Lines read_output shows at most at once, and characters. */
const READ_OUTPUT_LINES = 2000;

/**
 * `read_output`: the whole of an output that was cut - a test run's, a command's - read by the id the cut gave, a range
 * of lines or the lines matching a pattern. It reads the kept outputs and nothing else.
 */
export function readOutputTool(dir: string) {
  return defineTool({
    name: "read_output",
    label: "Read output",
    description:
      "Read the whole of an output that was cut short - a test run's or a command's - by the id the cut named: a range of " +
      "lines (offset, from 1, and limit), or only the lines matching a pattern (a regular expression). Each line comes " +
      "with its number.",
    promptSnippet: "read_output: the whole of a cut output, by the id the cut named",
    parameters: Type.Object({
      id: Type.String({ description: "The id the cut output named, e.g. 2026-10-05T10-00-00-000Z-run_unittests.sh.log" }),
      offset: Type.Optional(Type.Number({ description: "The first line to show, from 1" })),
      limit: Type.Optional(Type.Number({ description: `How many lines to show (at most ${READ_OUTPUT_LINES})` })),
      pattern: Type.Optional(Type.String({ description: "Show only the lines matching this regular expression" })),
    }),
    async execute(_id, params: { id: string; offset?: number; limit?: number; pattern?: string }) {
      const logs = outputsDir(dir);
      const file = join(logs, params.id);
      if (basename(params.id) !== params.id || !existsSync(file)) {
        throw new Error(`${params.id} is not an output turri kept. Use the id a cut output named, as it named it.`);
      }
      const lines = maskSecrets(readFileSync(file, "utf8")).split("\n");
      const numbered = lines.map((line, index) => ({ line, number: index + 1 }));
      let text: string;
      if (params.pattern !== undefined) {
        const pattern = new RegExp(params.pattern);
        const matching = numbered.filter(({ line }) => pattern.test(line));
        const shown = matching.slice(0, READ_OUTPUT_LINES);
        const more = matching.length > shown.length ? `, the first ${shown.length} shown` : "";
        text = [...shown.map(({ line, number }) => `${number}: ${line}`), `[${matching.length} line${matching.length === 1 ? "" : "s"} of ${lines.length} match${matching.length === 1 ? "es" : ""} ${params.pattern}${more}]`].join("\n");
      } else {
        const from = Math.max(1, Math.floor(params.offset ?? 1));
        const count = Math.min(READ_OUTPUT_LINES, Math.max(1, Math.floor(params.limit ?? READ_OUTPUT_LINES)));
        const shown = numbered.slice(from - 1, from - 1 + count);
        const last = from + shown.length - 1;
        text = [...shown.map(({ line, number }) => `${number}: ${line}`), `[lines ${from}-${last} of ${lines.length}]`].join("\n");
      }
      return { content: [{ type: "text" as const, text: truncateOutput(text) }], details: { id: params.id } };
    },
  });
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
  ".turri",
  "target",
  ".cargo",
  // Working notes for the agents: not part of the codebase either (see notes.ts).
  NOTES_FILE,
  RECORD_FILE,
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


/**
 * How many times a coding agent that ended its turn having written nothing is asked for a draft: once. Thinking a
 * problem through and ending the turn with nothing written leaves nothing to test or review; a best guess does. A
 * change that only rewords or describes may need no code, and the agent says so.
 */
export const DRAFT_ASKS = 1;

/** For a coding agent that has written nothing yet: write a best-guess draft now, or say why no code is needed. */
export function draftPrompt(): string {
  return [
    "You have not written anything yet: the code folder is as it was when you started.",
    "",
    "If the change needs code - anything it adds to or changes in a functional spec, an implementation req or an",
    "acceptance test - stop planning and write it now: your best guess at what the change asks, the code and its",
    "unit tests, as a draft. If you are sure it needs no code at all - it only rewords, describes or renames - say so",
    "in one line, and why.",
    "Where the specification leaves something open, pick the most likely reading, write it, and note the assumption",
    "with update_notes. Then run the unit tests.",
  ].join("\n");
}

export type UnitVerdict =
  | { ok: true; command: string }
  | { ok: false; command?: string; prompt: string; missing?: MissingToolchain };

/** A toolchain the testing script needs and does not find where it runs: no change to the code can pass it. */
export interface MissingToolchain {
  command?: string;
  where: "vm" | "host";
}

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
  const missing = missingToolchain(run);
  return {
    ok: false,
    command: run.command,
    prompt: scriptFailure(run, "unit testing"),
    ...(missing !== undefined ? { missing: { ...missing, where: run.where ?? "vm" } } : {}),
  };
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
