import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { reportActivity } from "./activity.ts";
import { NOTES_FILE } from "./notes.ts";
import { STATE_FILE } from "./state.ts";
import { COMMAND_TIMEOUT_MS, runInVm } from "./vm.ts";

/** Shared test-running and test-preservation machinery for both render tools. */

export interface TestRun {
  command: string;
  exitCode: number;
}

const MAX_OUTPUT_CHARS = 20000;
/** A test run has the same time limit as any command: see COMMAND_TIMEOUT_MS. */
export const RUN_TIMEOUT_MS = COMMAND_TIMEOUT_MS;

export function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n... [truncated, ${text.length} characters total]`;
}

/**
 * Run a command an agent chose, from `cwd`.
 *
 * In the project's VM, which holds only plain_modules (see `vm.ts`), so running the tests
 * cannot be used to read the specification, the rest of the project, or anything else on the
 * machine.
 */
export async function runCommand(cwd: string, command: string): Promise<{ exitCode: number; output: string }> {
  const { exitCode, output } = await runInVm(command, { cwd, timeoutMs: RUN_TIMEOUT_MS });
  return { exitCode, output: truncateOutput(output) };
}

/**
 * Never part of the codebase: version control, installed dependencies, tool caches, and the
 * harness's own bookkeeping. Installed dependencies alone can be tens of thousands of files.
 */
const NOT_CODE = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".plainwright",
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
export function createRunTestsTool(options: {
  name: string;
  label: string;
  description: string;
  run: (command: string) => Promise<{ exitCode: number; output: string }>;
  runs: TestRun[];
  onRun?: (command: string, exitCode: number) => void;
}) {
  return defineTool({
    name: options.name,
    label: options.label,
    description: options.description,
    promptSnippet: `${options.name}: run the tests and see the result`,
    parameters: Type.Object({
      command: Type.String({ description: 'Shell command, e.g. "python -m unittest discover"' }),
    }),
    async execute(_id, params) {
      const { exitCode, output } = await options.run(params.command);
      options.runs.push({ command: params.command, exitCode });
      options.onRun?.(params.command, exitCode);
      return {
        content: [{ type: "text" as const, text: `exit code: ${exitCode}\n\n${output}` }],
        details: { command: params.command, exitCode },
      };
    },
  });
}

const TEST_FILE_PATTERN = /(^|[._/-])(test|spec)|test[._-]|Test\.|\.test\.|_test\./i;
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

export function failingTestsPrompt(runs: TestRun[], toolName: string): string {
  const last = runs[runs.length - 1];
  if (last === undefined) {
    return [
      `You have not run the tests yet. Call ${toolName} with the command the specification`,
      "gives, and fix whatever it reports until it passes.",
    ].join("\n");
  }
  return [
    `The last run of \`${last.command}\` exited ${last.exitCode}. The tests are not passing.`,
    "",
    `Fix the cause and call ${toolName} again. Do not remove or weaken a test to get a pass.`,
  ].join("\n");
}


/**
 * Commands that run everything in the working directory, rather than one named target.
 *
 * A regression run merges every functionality's tests into one directory, so the command
 * has to be one that discovers them all. An agent left to its own devices will narrow to
 * the module it just wrote - which passes while telling you nothing about the others.
 */
const WHOLE_SUITE_PATTERNS = [
  /\bdiscover\b/,
  /\bpytest\b(?!.*(::|\.py\b))/,
  /\bnpm\s+(run\s+)?test\b/,
  /\bvitest\s+run\b(?!\s+\S)/,
  /\bgo\s+test\b.*\.\.\./,
  /\bmvn\s+(test|verify)\b/,
  /\bgradle\s+(test|check)\b/,
  /\bcargo\s+test\b(?!\s+\S)/,
  /\bctest\b/,
];

export function isWholeSuiteCommand(command: string): boolean {
  return WHOLE_SUITE_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * Pick the command a regression run should use.
 *
 * `narrow` means nothing that ran everything was found, so the chosen command probably
 * exercises only part of the suite - a caveat the caller should surface rather than
 * report as a clean pass.
 */
export function chooseRegressionCommand(runs: TestRun[]): { command: string | null; narrow: boolean } {
  const passing = runs.filter((run) => run.exitCode === 0);
  for (let i = passing.length - 1; i >= 0; i -= 1) {
    if (isWholeSuiteCommand(passing[i]!.command)) return { command: passing[i]!.command, narrow: false };
  }
  const fallback = passing[passing.length - 1];
  return fallback ? { command: fallback.command, narrow: true } : { command: null, narrow: false };
}

/** A unit-test runner script the codebase carries, by the name the implement skill gives it. */
const UNIT_SCRIPT = /^test_scripts\/run_unit_?tests[^/]*\.sh$/i;

export type UnitVerdict =
  | { ok: true; command: string }
  | { ok: false; command?: string; prompt: string };

/**
 * The harness's own run of the unit tests, which is what a render's "the tests pass" rests on.
 *
 * The agent chooses the commands it runs while it works, and a gate that took the last of them
 * would pass on a command that runs one file, or nothing. So before a functionality counts as
 * done, the harness runs the whole suite itself: with the unit-test script the codebase carries
 * when there is one - it is what the spec links to - and otherwise with the agent's own last
 * passing command, but only one that runs the whole suite. A run that only ever covered part
 * of the suite is sent back, not guessed at: the command that works depends on where the
 * project installed its test runner, and the agent knows that.
 */
export async function verifyUnitSuite(buildDir: string, runs: TestRun[], toolName = "run_unit_tests"): Promise<UnitVerdict> {
  const script = listFiles(buildDir).find((file) => UNIT_SCRIPT.test(file));
  const lastPassing = runs.filter((run) => run.exitCode === 0).at(-1)?.command;
  const command = script !== undefined ? `bash ${script} .` : lastPassing !== undefined && isWholeSuiteCommand(lastPassing) ? lastPassing : undefined;

  if (command === undefined) {
    return {
      ok: false,
      prompt:
        lastPassing === undefined
          ? failingTestsPrompt(runs, toolName)
          : [
              `Your last passing run, \`${lastPassing}\`, does not run the whole unit test suite - it names one target.`,
              "",
              `Call ${toolName} with the command that runs every unit test in the working directory (e.g. \`pytest\`,`,
              "`python -m unittest discover`, `npm test`, `go test ./...`, `cargo test`) and fix whatever it reports.",
            ].join("\n"),
    };
  }

  const result = await runCommand(buildDir, command);
  runs.push({ command, exitCode: result.exitCode });
  if (result.exitCode === 0) return { ok: true, command };
  return {
    ok: false,
    command,
    prompt: [
      `The harness ran the whole unit test suite itself - \`${command}\` - and it failed (exit ${result.exitCode}):`,
      "",
      result.output.trimEnd(),
      "",
      `Fix the cause and call ${toolName} with that command until it passes. Do not remove or weaken a test to get a pass.`,
    ].join("\n"),
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
