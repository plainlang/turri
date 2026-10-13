import type { MissingToolchain, TestRun } from "./testing.ts";
import { missingToolchain, runUnitScript, scriptFailure, staticChecksOnly, type ScriptRun } from "./test-scripts.ts";

/**
 * The coding agent's unit tests: the project's unit testing script, run by the harness. The script is the whole of it -
 * its static checks, when it runs any, included - and its exit code says which failed: `STATIC_CHECKS_FAILED` is the
 * tests passing and only the checks not.
 */

export type WorkVerdict =
  | { ok: true }
  | {
      ok: false;
      /** What the agent is sent back with. */
      prompt: string;
      /** The run that failed, for the fingerprint and the debugger. */
      run: ScriptRun;
      /** The script that run was of. */
      script: string;
      /** Only the script's static checks failed: the tests passed. */
      staticOnly: boolean;
      /** A toolchain the script needs and this machine lacks. */
      missing?: MissingToolchain;
    };

export interface UnitGate {
  /** The unit testing script on the code, recorded in `runs`: passing, or what to send the agent back with. */
  verify(runs: TestRun[]): Promise<WorkVerdict>;
}

export function createUnitGate(buildDir: string, unit: string): UnitGate {
  return {
    async verify(runs) {
      const run = await runUnitScript(buildDir, unit);
      runs.push({ command: run.command, exitCode: run.exitCode });
      if (run.exitCode === 0) return { ok: true };
      const missing = run.timedOut === true ? undefined : missingToolchain(run);
      return {
        ok: false,
        prompt: scriptFailure(run, "unit testing"),
        run,
        script: unit,
        staticOnly: missing === undefined && staticChecksOnly(run),
        ...(missing !== undefined ? { missing } : {}),
      };
    },
  };
}
