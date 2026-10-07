import { basename, dirname, isAbsolute } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { passedCredentials } from "./agent-env.ts";
import { missingToolchain } from "./test-scripts.ts";
import { MODULES_DIR } from "./paths.ts";
import { reportActivity } from "./activity.ts";

/**
 * When the machine lacks what the work needs - a toolchain, a system library, a credential - no agent can fix it, and
 * none tries: the pulse stops and is rolled back, the module's later pulses wait, and the person is told what is
 * missing, how to fix it, and how to run it again. Raised two ways: an agent calls `report_environment_error`, which
 * ends its turn - its reason goes to the person as it is; or the harness finds it itself - a testing script that cannot
 * find its toolchain, a credential `agent-env:` names that is not there - and works out at once what to do about it.
 */

export class EnvironmentError extends Error {
  // Declared fields, not parameter properties: node's own type stripping cannot run those.
  /** The module whose pulse stopped. */
  readonly moduleName: string;
  /** What the environment lacks. */
  readonly missing: string;
  /** What needs it. */
  readonly neededBy: string;
  /** What showed it: the command, the output. */
  readonly shownBy?: string;
  /** How to fix it, when it is known. */
  fix?: string;
  /** Who found it: an agent, or the harness. */
  readonly source: "agent" | "harness";

  constructor(details: { moduleName: string; missing: string; neededBy: string; shownBy?: string; fix?: string; source: "agent" | "harness" }) {
    super(`${details.moduleName} stopped: the environment lacks ${details.missing}.`);
    this.name = "EnvironmentError";
    this.moduleName = details.moduleName;
    this.missing = details.missing;
    this.neededBy = details.neededBy;
    if (details.shownBy !== undefined) this.shownBy = details.shownBy;
    if (details.fix !== undefined) this.fix = details.fix;
    this.source = details.source;
  }
}

/**
 * What the person is told, in the chat, at the end of `turri regrow`, and in the job's log. `rerun`: the command that runs
 * the work again, as the pulse knows it - the spec the person ran; without it, the module's own spec by its name.
 */
export function describeEnvironmentError(error: EnvironmentError, rerun?: string): string {
  return [
    `**${error.moduleName} stopped: the environment lacks ${error.missing}.**`,
    `Needed by: ${error.neededBy}${error.shownBy !== undefined ? ` (${error.shownBy})` : ""}.`,
    `To fix: ${error.fix ?? "provide it on this machine, then run it again."}`,
    `Then re-run: \`${rerun ?? `turri regrow ${error.moduleName}.plain`}\`, or say "resume" in the chat.`,
  ].join("\n");
}

/** The name agents know the tool by - their wall text names it. */
export const ENVIRONMENT_ERROR_TOOL = "report_environment_error";

/** An agent's report that the machine lacks something. */
export interface EnvironmentReport {
  missing: string;
  neededBy: string;
  shownBy?: string;
}

/** Whether a report stands - the pulse stops - or not, and what the agent is told then. */
export type ReportVerdict = { stands: true } | { stands: false; reply: string };

/** How much of the harness's run a report that does not stand is shown, at most. */
const RUN_SHOWN_CHARS = 4000;

/**
 * An agent's report checked against the harness's own run of the testing script - on this machine, outside the agent's
 * sandbox, the run that decides whether the work is done. Its shell runs behind walls the script does not: what fails
 * there may run here. The script passing, the machine has what the work needs: the report does not stand, and the agent
 * goes on. The script not finding its toolchain, it stands. Failing otherwise, the agent is shown the run once - a
 * report made again after it stands.
 */
export function checkAgainstScript(run: () => Promise<{ exitCode: number; output: string }>, script: string): (report: EnvironmentReport) => Promise<ReportVerdict> {
  let shown = false;
  return async () => {
    const result = await run();
    const name = basename(script);
    if (result.exitCode === 0) {
      return {
        stands: false,
        reply:
          `Not recorded: the harness ran the project's testing script, ${name}, on this machine itself, and it passed - ` +
          "the machine has what the work needs. What failed was your shell: your commands run behind a sandbox the " +
          "testing scripts do not. Do not work around it, and do not report it again: carry on with the work, and " +
          "check it with the tool that runs the testing script as the harness does.",
      };
    }
    if (missingToolchain(result) !== undefined || shown) return { stands: true };
    shown = true;
    const output = result.output.length > RUN_SHOWN_CHARS ? `...\n${result.output.slice(-RUN_SHOWN_CHARS)}` : result.output;
    return {
      stands: false,
      reply:
        `Not recorded yet: the harness ran the project's testing script, ${name}, on this machine itself - outside your ` +
        `sandbox - and it exited ${result.exitCode}, but not for want of a toolchain. Read its output below. A failure ` +
        "of the code or the tests is yours to fix; if it shows the machine lacks what you reported, call " +
        `${ENVIRONMENT_ERROR_TOOL} again and it stands.\n\n${output}`,
    };
  };
}

/**
 * `report_environment_error`: an agent that finds the machine lacking what the work needs says so, and its turn ends.
 * `record` is told what it reported; whoever asked the turn stops the pulse with it. With `check`, the report is checked
 * first: one that does not stand is not recorded, and the agent is told why and goes on.
 */
export function environmentErrorTool(record: (report: EnvironmentReport) => void, check?: (report: EnvironmentReport) => Promise<ReportVerdict>): ToolDefinition {
  return defineTool({
    name: ENVIRONMENT_ERROR_TOOL,
    label: "Report an environment error",
    description:
      "Say that this machine lacks something the work needs - a toolchain, a system library, a driver, a service, a " +
      "credential - which you cannot and may not install or make up. It ends your turn: the pulse stops, and the person " +
      "is told exactly what you write here - unless the harness's own run of the testing script, outside your sandbox, " +
      "shows the machine has it: then you are told so, and go on. Use it only for what is missing from the machine, never " +
      "for a problem in the code or the tests.",
    promptSnippet: `${ENVIRONMENT_ERROR_TOOL}: the machine lacks something the work needs - ends your turn`,
    parameters: Type.Object({
      missing: Type.String({ description: "What is missing - e.g. `JDK 21`, `the CUDA toolkit (nvcc)`, `the D365_CLIENT_SECRET credential`" }),
      needed_by: Type.String({ description: "What needs it - the build, a test, a library - e.g. `mvn test`, `torch's GPU build`" }),
      shown_by: Type.Optional(Type.String({ description: "The command that showed it, and what it said" })),
    }),
    async execute(_id, params) {
      const { missing, needed_by: neededBy, shown_by: shownBy } = params as { missing: string; needed_by: string; shown_by?: string };
      const report = { missing, neededBy, ...(shownBy !== undefined ? { shownBy } : {}) };
      if (check !== undefined) {
        reportActivity(`  the agent reports the environment lacks ${missing} - checking it with the harness's own run of the testing script`);
        const verdict = await check(report);
        if (!verdict.stands) {
          reportActivity("  it does not stand: the agent goes on");
          return { content: [{ type: "text" as const, text: verdict.reply }], details: {} };
        }
      }
      record(report);
      return { content: [{ type: "text" as const, text: "Recorded. Your turn ends here; the person is told." }], details: {}, terminate: true };
    },
  }) as ToolDefinition;
}

/**
 * A testing script that cannot find its toolchain: the machine lacks it, and no change to the code or the tests would
 * pass the script - so it is the environment's, found by the harness. `missing` is what the run's output named.
 */
export function toolchainError(missing: { command?: string }, details: { moduleName: string; script: string; kind: "unit" | "conformance" }): EnvironmentError {
  const needs = missing.command !== undefined ? `\`${missing.command}\`` : `a toolchain the ${details.kind} testing script needs`;
  return new EnvironmentError({
    moduleName: details.moduleName,
    missing: needs,
    neededBy: `the ${details.kind} testing script, \`${basename(details.script)}\``,
    shownBy: missing.command !== undefined ? `it could not find \`${missing.command}\`` : "it exited saying a toolchain is missing",
    fix: `install ${missing.command ?? "it"} on this machine, so the testing script finds it on its PATH.`,
    source: "harness",
  });
}

/** The harness's run of a testing script, when it could not find its toolchain: the error that stops the pulse. */
export function missingToolchainError(
  run: { exitCode: number; output: string },
  details: { moduleName: string; script: string; kind: "unit" | "conformance" },
): EnvironmentError | undefined {
  const missing = missingToolchain(run);
  return missing !== undefined ? toolchainError(missing, details) : undefined;
}

/** The module a folder is part of, by name: `plain_modules/<module>/...`. */
function moduleNameOf(moduleDir: string): string {
  return basename(moduleDir);
}

/**
 * Before a pulse in `moduleDir` starts any agent: a credential `agent-env:` names that is not there stops it - every
 * command that needs it would fail, and no agent may make one up. Nothing when all are there, or the folder is no
 * module's.
 */
export function missingCredentials(moduleDir: string): EnvironmentError | undefined {
  if (!isAbsolute(moduleDir) || basename(dirname(moduleDir)) !== MODULES_DIR) return undefined;
  // Only read: nothing of the module's environment - its home, its TMPDIR - is made for a check.
  const { missing } = passedCredentials(moduleDir, process.env);
  if (missing.length === 0) return undefined;
  const names = missing.map((item) => item.name);
  return new EnvironmentError({
    moduleName: moduleNameOf(moduleDir),
    missing: `${names.length === 1 ? "the credential" : "the credentials"} ${names.map((name) => `\`${name}\``).join(", ")}`,
    neededBy: "`agent-env:` in the project's config, which passes them to the agents",
    shownBy: missing.map((item) => `${item.name}: ${item.why}`).join("; "),
    fix: "provide them where `agent-env:` reads them - the dotenv file it names, or the environment turri is started in - or take them out of `agent-env:`.",
    source: "harness",
  });
}
