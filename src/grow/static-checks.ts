import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { reportActivity } from "./activity.ts";
import { digestFiles } from "./codebase.ts";
import { keepOutput, type MissingToolchain, type TestRun } from "./testing.ts";
import { applyStaticFixes, missingToolchain, runOnCode, runUnitScript, scriptFailure, type ScriptRun } from "./test-scripts.ts";

/**
 * The project's static checks as part of the coding agent's unit tests.
 *
 * With a static checks script (`findStaticChecks`), "the unit tests pass" means more: before each run the harness applies
 * the script's fix mode to the code - the formatter, the safe autofixes - and then runs the unit testing script and the
 * static checks side by side. The work passes only when both do, within the same rounds; the agent is given both
 * results in one send-back. Without one, it is the unit testing script alone, as it always was.
 *
 * What the agent is shown of the checks is their findings - a line each, with its file and line - and nothing when
 * they pass: the tools' whole output costs context on every turn, and is a read_output away.
 */

/** How many findings the agent is shown at most: the rest are in the whole output, kept for read_output. */
export const FINDINGS_SHOWN = 30;

/** A line naming a file and a line in it - `src/a.py:12:3: F401 ...`, `src/a.ts(3,5): error TS2322 ...`. */
const FINDING = /(?:^|[\s"'(])\.{0,2}[\w@./-]*[\w-]\.[A-Za-z]\w*(?::\d+|\(\d+,\s*\d+\))/;

/** The working folder a static checks script copies the code into: its paths read as the code folder's. */
const WORKING_FOLDER = /\/(?:private\/)?tmp\/static_[^/\s]+\//g;

/** A finding the tool calls an error - a type error above all - shown before the warnings and the lint. */
const isError = (line: string) => /\berror\b/i.test(line);

function readWhole(run: ScriptRun): string {
  if (run.log === undefined) return run.output;
  try {
    return readFileSync(run.log, "utf8");
  } catch {
    return run.output;
  }
}

/**
 * A failed run of the static checks as the agent is shown it: the lines that name a file and a line - errors first,
 * each once, at most FINDINGS_SHOWN - and where the whole output is when some were left out. With none such, its last
 * lines.
 */
export function staticFindings(run: ScriptRun, dir: string): string {
  if (run.timedOut === true) {
    const tail = run.output.trimEnd().split("\n").slice(-20).join("\n");
    return `${run.command} did not finish in ${Math.round(run.timeoutMs / 1000)}s, the time limit for a run, and counts as failed. Its last lines:\n${tail}`;
  }
  const whole = readWhole(run);
  const lines = whole.split("\n").map((line) => line.replace(/\x1B\[[0-9;]*m/g, "").replace(WORKING_FOLDER, "").trim());
  const found = [...new Set(lines.filter((line) => !line.startsWith("+ ") && FINDING.test(line)))];
  if (found.length === 0) {
    const tail = lines.filter((line) => line !== "").slice(-40);
    return [`[turri: ${run.command} exited ${run.exitCode} and named no file and line - its last lines]`, ...tail].join("\n");
  }
  const ordered = [...found.filter(isError), ...found.filter((line) => !isError(line))];
  if (ordered.length <= FINDINGS_SHOWN) return ordered.join("\n");
  const kept = run.log ?? keepOutput(dir, `${basename(run.command)}-findings`, whole);
  const where = kept !== undefined ? `the whole output is kept as \`${basename(kept)}\`: call read_output with that id for the rest` : "the rest was not kept";
  return [`[turri: ${ordered.length} findings, the first ${FINDINGS_SHOWN} shown - ${where}]`, ...ordered.slice(0, FINDINGS_SHOWN)].join("\n");
}

/** How a finding is fixed, and what is no fix. */
const HOW_TO_FIX = [
  "Fix each at its file and line - its cause, not its symptom. Do not silence one: no `# type: ignore`, `# noqa`,",
  "`@ts-ignore`, `eslint-disable`, `//nolint` or `#[allow(...)]`, and no rule turned off or loosened in the checker's",
  "configuration. A tool the checks say is missing from the project's dependency manifest goes in it, as a development",
  "dependency. The formatting is the harness's: it applies the formatter before every run, so never spend a turn on it.",
];

/** The static checks failed, the unit tests passed: what the agent is sent back with. */
export function staticChecksFailure(run: ScriptRun, findings: string): string {
  return [
    `The unit tests pass, but the project's static checks, \`${run.command}\`, failed (exit ${run.exitCode}) - and they count`,
    "as the unit tests do: the work is done only when both pass. What they found:",
    "",
    findings,
    "",
    ...HOW_TO_FIX,
  ].join("\n");
}

/** The static checks failed beside the unit tests: added to the unit tests' failure, so one turn has both. */
export function staticChecksAlongside(run: ScriptRun, findings: string): string {
  return [
    `The project's static checks, \`${run.command}\`, failed too (exit ${run.exitCode}) - the work is done only when both pass. What they found:`,
    "",
    findings,
    "",
    ...HOW_TO_FIX,
  ].join("\n");
}

/** What the agent is told when the harness's fixes changed files under it. */
export function fixedNote(files: string[]): string {
  const named = files.slice(0, 10).join(", ") + (files.length > 10 ? ` and ${files.length - 10} more` : "");
  return `[turri: before the run, the static checks' fix mode - the formatter and the safe autofixes - changed ${named}. Read a file again before you edit it.]`;
}

export type WorkVerdict =
  | { ok: true }
  | {
      ok: false;
      /** What the agent is sent back with: the unit tests' failure, the static checks' findings, or both. */
      prompt: string;
      /** The run that failed - the unit tests', else the static checks' - for the fingerprint and the debugger. */
      run: ScriptRun;
      /** The script that run was of. */
      script: string;
      /** Only the static checks failed: the unit tests passed. */
      staticOnly: boolean;
      /** A toolchain a script needs and this machine lacks, and which script. */
      missing?: MissingToolchain;
      missingIn?: "unit" | "static checks";
    };

export interface UnitGate {
  /** The static checks script, when the project has one. */
  readonly staticChecks: string | undefined;
  /** The static checks' fix mode on the code - when the code changed since it last ran. The files it changed. */
  fix(): Promise<string[]>;
  /** The fixes, then the unit testing script and the static checks side by side - recorded in `runs`. */
  run(runs: TestRun[]): Promise<{ unit: ScriptRun; checks?: ScriptRun; fixed: string[] }>;
  /** The harness's verdict on the work: both passing, or what to send the agent back with. */
  verify(runs: TestRun[]): Promise<WorkVerdict>;
  /** The same run as one, for run_unit_tests: the agent's final check, exactly as the harness runs it. */
  runAsOne(): Promise<ScriptRun>;
}

/** The coding agent's unit tests on `buildDir`: the unit testing script, and the static checks when there are any. */
export function createUnitGate(buildDir: string, scripts: { unit: string; staticChecks?: string }): UnitGate {
  const staticChecks = scripts.staticChecks;
  /** The code as the fixes last left it: unchanged since, they are not run again. */
  let fixedAt: string | undefined;
  const stateOf = () =>
    [...digestFiles(buildDir)]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, digest]) => `${file} ${digest}`)
      .join("\n");
  const fix = async (): Promise<string[]> => {
    if (staticChecks === undefined) return [];
    const before = stateOf();
    if (before === fixedAt) return [];
    const changed = await applyStaticFixes(buildDir, staticChecks);
    fixedAt = changed.length > 0 ? stateOf() : before;
    if (changed.length > 0) reportActivity(`  the static checks' fixes changed ${changed.length} file${changed.length === 1 ? "" : "s"}`);
    return changed;
  };
  const run = async (runs: TestRun[]) => {
    const fixed = await fix();
    const [unit, checks] = await Promise.all([
      runUnitScript(buildDir, scripts.unit),
      staticChecks !== undefined ? runOnCode(buildDir, staticChecks, "static checks") : Promise.resolve(undefined),
    ]);
    runs.push({ command: unit.command, exitCode: unit.exitCode });
    if (checks !== undefined) runs.push({ command: checks.command, exitCode: checks.exitCode });
    return { unit, ...(checks !== undefined ? { checks } : {}), fixed };
  };
  return {
    staticChecks,
    fix,
    run,
    async verify(runs) {
      const { unit, checks } = await run(runs);
      const unitFailed = unit.exitCode !== 0;
      const unitMissing = unitFailed ? missingToolchain(unit) : undefined;
      if (unitMissing !== undefined) {
        return { ok: false, prompt: scriptFailure(unit, "unit testing"), run: unit, script: scripts.unit, staticOnly: false, missing: unitMissing, missingIn: "unit" };
      }
      const checksFailed = checks !== undefined && checks.exitCode !== 0;
      const checksMissing = checksFailed && checks.timedOut !== true ? missingToolchain(checks) : undefined;
      if (checksMissing !== undefined) {
        return { ok: false, prompt: scriptFailure(checks!, "static checks"), run: checks!, script: staticChecks!, staticOnly: !unitFailed, missing: checksMissing, missingIn: "static checks" };
      }
      if (!unitFailed && !checksFailed) return { ok: true };
      const findings = checksFailed ? staticFindings(checks!, buildDir) : undefined;
      if (unitFailed) {
        const prompt = scriptFailure(unit, "unit testing") + (findings !== undefined ? `\n\n${staticChecksAlongside(checks!, findings)}` : "");
        return { ok: false, prompt, run: unit, script: scripts.unit, staticOnly: false };
      }
      return { ok: false, prompt: staticChecksFailure(checks!, findings!), run: checks!, script: staticChecks!, staticOnly: true };
    },
    async runAsOne() {
      const { unit, checks, fixed } = await run([]);
      const before = fixed.length > 0 ? `${fixedNote(fixed)}\n\n` : "";
      if (checks === undefined) return before === "" ? unit : { ...unit, output: before + unit.output };
      if (checks.exitCode === 0) return { ...unit, output: before + unit.output };
      const findings = staticFindings(checks, buildDir);
      return {
        ...unit,
        command: `${unit.command} and ${checks.command}`,
        exitCode: unit.exitCode !== 0 ? unit.exitCode : checks.exitCode,
        output: `${before}${unit.command} exited ${unit.exitCode}\n\n${unit.output.trimEnd()}\n\n${unit.exitCode === 0 ? staticChecksFailure(checks, findings) : staticChecksAlongside(checks, findings)}`,
      };
    },
  };
}
