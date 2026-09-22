import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { STATE_FILE } from "./state.ts";
import { runCommand, truncateOutput } from "./testing.ts";

/**
 * How a person tries out what was just built.
 *
 * Passing unit tests says the code agrees with itself; it says nothing to someone who wants
 * to use the software. The agent that wrote the code is the one that knows how to start it,
 * so it is asked - and every step that finishes on its own is then run by the harness, so
 * the instructions a person is handed have been followed at least once.
 */

export type StepKind = "command" | "long_running" | "manual";

export interface TryStep {
  /** A shell command, or for a manual step, what to do. */
  do: string;
  /** What the person should see. */
  expect: string;
  /**
   * command: exits by itself, so the harness runs it. long_running: a server or an
   * interactive program, started but not waited on. manual: something done by hand, such as
   * opening a page.
   */
  kind: StepKind;
  /** Set when the harness ran it. */
  exitCode?: number;
}

export interface TryIt {
  /** Where the steps run from: a copy of the build made for trying it. */
  dir?: string;
  /** One-off preparation, such as installing dependencies. Run before the steps. */
  setup: string[];
  steps: TryStep[];
  /** Setup commands that failed when the harness ran them. */
  failedSetup?: string[];
}

export function createTryItTool(onSubmit: (tryIt: TryIt) => void) {
  return defineTool({
    name: "describe_how_to_try_it",
    label: "Describe how to try it",
    description:
      "Tell the person how to run the software and see the functionality you just built working. " +
      "Commands run from a fresh copy of the working directory with no dependencies installed.",
    parameters: Type.Object({
      setup: Type.Array(Type.String(), {
        description: "One-off preparation commands, e.g. installing dependencies. Empty if none.",
      }),
      steps: Type.Array(
        Type.Object({
          do: Type.String({ description: "A shell command, or for a manual step what to do" }),
          expect: Type.String({ description: "What the person should see, concretely" }),
          kind: Type.Union(
            [Type.Literal("command"), Type.Literal("long_running"), Type.Literal("manual")],
            {
              description:
                "command: exits on its own. long_running: a server or interactive program that " +
                "keeps running. manual: done by hand, e.g. opening a URL in a browser.",
            },
          ),
        }),
        { minItems: 1 },
      ),
    }),
    async execute(_id, params) {
      onSubmit({ setup: params.setup, steps: params.steps });
      return {
        content: [{ type: "text" as const, text: "Recorded." }],
        details: params,
        terminate: true,
      };
    },
  });
}

export function tryItPrompt(frid: string): string {
  return [
    `Functionality ${frid} is built and its unit tests pass. Now tell the person who asked for it`,
    "how to try it themselves. Call describe_how_to_try_it.",
    "",
    "- They want to run the software and see the new behaviour, not run the unit tests.",
    "- Use the real entry point: the CLI, the script, the server, the page - whatever this",
    "  codebase is. Give concrete inputs, not placeholders, and say exactly what comes back.",
    "- Show this functionality specifically. Earlier functionalities only where they are needed",
    "  to get there.",
    "- The person runs these from a fresh copy of the working directory: the code, but no",
    "  installed dependencies - no virtual environment, no node_modules, no build caches. Put",
    "  whatever installs them in `setup`, and install inside the directory (a virtual",
    "  environment, a local node_modules), never globally.",
    "- Mark each step honestly: `command` steps are run for you to check they work, so a server",
    "  or an interactive program is `long_running`, and opening a browser is `manual`.",
    "- If there is genuinely nothing to run yet - a library with no entry point - give the",
    "  shortest snippet that calls it, as a command.",
  ].join("\n");
}

export function failedStepsPrompt(tryIt: TryIt, outputs: Map<string, string>): string {
  const failed = [
    ...(tryIt.failedSetup ?? []),
    ...tryIt.steps.filter((s) => s.exitCode !== undefined && s.exitCode !== 0).map((s) => s.do),
  ];
  return [
    "These did not work when run from a fresh copy of the working directory, with nothing installed:",
    "",
    ...failed.map((command) => `$ ${command}\n${outputs.get(command) ?? ""}`.trimEnd()),
    "",
    "Fix the instructions, or the code if the software really does not behave as it should, and",
    "call describe_how_to_try_it again. Do not remove or weaken a test.",
  ].join("\n");
}

/** What is not copied: caches, installed dependencies, and the harness's own bookkeeping. */
const NOT_COPIED = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", STATE_FILE]);

/**
 * A fresh copy of the build to try it from, replacing any earlier copy for this functionality.
 *
 * Installed dependencies are left behind on purpose. A virtual environment holds absolute
 * paths and breaks when moved, and a copy that already has everything installed would let
 * setup steps that do not work pass the check. So the steps are checked from where the
 * person starts: the code, and nothing else.
 */
export function prepareTryDir(buildDir: string, dest: string): string {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(buildDir, dest, { recursive: true, filter: (source) => !NOT_COPIED.has(basename(source)) });
  // The copies are the person's scratch space, never part of the project's history, so the
  // folder they live in - `.plainwright`, three up from `try/<module>/fs-<frid>` - ignores itself.
  const scratch = dirname(dirname(dirname(dest)));
  if (!existsSync(join(scratch, ".gitignore"))) writeFileSync(join(scratch, ".gitignore"), "*\n");
  return dest;
}

/**
 * Run the setup and every `command` step, in order, in the directory the person will use.
 *
 * Stops at the first setup failure, since nothing after it is meaningful.
 */
export function checkTryIt(
  dir: string,
  tryIt: TryIt,
  run: (cwd: string, command: string) => { exitCode: number; output: string } = runCommand,
): { tryIt: TryIt; outputs: Map<string, string>; ok: boolean } {
  const outputs = new Map<string, string>();
  const failedSetup: string[] = [];

  for (const command of tryIt.setup) {
    const result = run(dir, command);
    outputs.set(command, truncateOutput(result.output));
    if (result.exitCode !== 0) {
      failedSetup.push(command);
      return { tryIt: { ...tryIt, failedSetup }, outputs, ok: false };
    }
  }

  const steps = tryIt.steps.map((step) => {
    if (step.kind !== "command") return step;
    const result = run(dir, step.do);
    outputs.set(step.do, truncateOutput(result.output));
    return { ...step, exitCode: result.exitCode };
  });

  const ok = steps.every((step) => step.exitCode === undefined || step.exitCode === 0);
  return { tryIt: { ...tryIt, steps }, outputs, ok };
}
