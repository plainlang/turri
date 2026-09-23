import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { STATE_FILE } from "./state.ts";
import { commandSandbox } from "./confine.ts";

/** Shared test-running and test-preservation machinery for both render tools. */

export interface TestRun {
  command: string;
  exitCode: number;
}

const MAX_OUTPUT_CHARS = 20000;
export const RUN_TIMEOUT_MS = 120_000;

export function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n... [truncated, ${text.length} characters total]`;
}

/**
 * Run a command an agent chose, fenced to `cwd`.
 *
 * The command runs under the same OS sandbox as the bash tool, with `cwd` as its only read
 * and write root, so running the tests cannot be used to read the specification or to
 * reach into another project.
 */
export function runCommand(cwd: string, command: string): { exitCode: number; output: string } {
  const sandbox = commandSandbox({ workdir: cwd, read: [cwd], write: [cwd] });
  try {
    const stdout = execSync(sandbox ? sandbox.wrap(command) : command, {
      cwd,
      env: sandbox ? { ...process.env, ...sandbox.env } : undefined,
      timeout: RUN_TIMEOUT_MS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { exitCode: 0, output: truncateOutput(stdout) };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string; message?: string };
    const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}` || (failure.message ?? "");
    return { exitCode: failure.status ?? 1, output: truncateOutput(output) };
  } finally {
    sandbox?.dispose();
  }
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
  run: (command: string) => { exitCode: number; output: string };
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
      const { exitCode, output } = options.run(params.command);
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
