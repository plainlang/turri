import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { workDiff } from "./lineage.ts";
import { lastPassingMs, runOnCode, type ScriptRun } from "./test-scripts.ts";

/**
 * Tools an agent checks its own work with, before the harness and the reviewer do: the diff the reviewer is shown,
 * the project's static checks when it has them, and whether a test catches a change to the code. None of them decides
 * anything - the testing scripts, run by the harness, still do.
 */

/** The work so far, as the reviewer is shown it: a diff of the folder from the commit the job started from. */
export function createMyDiffTool(options: { dir: string; what: "code" | "tests" }): ToolDefinition {
  const folder = options.what === "code" ? "code folder" : "tests folder";
  return defineTool({
    name: "my_diff",
    label: "My diff",
    description:
      `The diff of the ${folder} from where this work started - every file changed, added or taken out, new files ` +
      "whole - exactly what the reviewer is shown of your work. Read it before you hand the work in: every part of the " +
      "change should be in it, and nothing else.",
    promptSnippet: `my_diff: your work so far, as the reviewer sees it - the ${folder} from where the work started`,
    parameters: Type.Object({}),
    async execute() {
      const diff = workDiff(options.dir);
      return { content: [{ type: "text" as const, text: diff === "" ? `Nothing in the ${folder} has changed yet.` : diff }], details: {} };
    },
  }) as ToolDefinition;
}

const outputOf = (run: ScriptRun) => `${run.command} exited ${run.exitCode}${run.timedOut === true ? " - stopped by the time limit" : ""}\n\n${run.output}`;

/** The project's static checks - a type checker, a linter - on the code as it is now. Optional: only when it has them. */
export function createStaticChecksTool(options: { buildDir: string; script: string }): ToolDefinition {
  return defineTool({
    name: "run_static_checks",
    label: "Run static checks",
    description:
      "Run the project's static checks - its type checker, its linter - on a fresh copy of the code as it is now. Fast, " +
      "and they find what the tests would find later: a wrong type, a missing import, a name that does not exist. They " +
      "decide nothing: the unit testing script does. Run them before the unit tests, and fix what they find.",
    promptSnippet: "run_static_checks: the project's type checker and linter, on the code as it is now",
    parameters: Type.Object({}),
    async execute() {
      const run = await runOnCode(options.buildDir, options.script, "static checks");
      return { content: [{ type: "text" as const, text: outputOf(run) }], details: { exitCode: run.exitCode } };
    },
  }) as ToolDefinition;
}

/** How many times can_it_fail runs in one session, by default: each is a run of the unit testing script. */
export const CAN_IT_FAIL_RUNS = 6;

/**
 * How long a can_it_fail run may take: three times the last passing run of the unit tests on this code, within 15 and
 * 60 seconds - 60 before one has passed. A bug put in the code often makes it loop or wait for ever: that is found out
 * in a short time, not the whole limit of a test run, and well within the agent's turn.
 */
export function canItFailLimitMs(buildDir: string, script: string): number {
  const last = lastPassingMs(buildDir, script);
  return last === undefined ? 60_000 : Math.min(Math.max(last * 3, 15_000), 60_000);
}

/**
 * Whether the unit tests catch a change to the code: the change made to a fresh copy - never to the code itself - and
 * the unit testing script run on it. A test that passes whatever the code does tests nothing.
 */
export function createCanItFailTool(options: { buildDir: string; script: string; runs?: number }): ToolDefinition {
  let left = options.runs ?? CAN_IT_FAIL_RUNS;
  return defineTool({
    name: "can_it_fail",
    label: "Can it fail",
    description:
      "Check that the unit tests catch a bug: give one change to the code that breaks a behaviour the specification " +
      "states - a value or a status changed, a check taken out, a condition turned round where it cannot make a loop run for " +
      "ever - and the unit testing script " +
      "runs on a copy of the code with that change. The code itself is never touched. The tests should fail; if they all " +
      "pass, no test catches that bug. Make a change that still builds and runs: a failure only because it no longer " +
      `compiles or imports says nothing about the tests. ${options.runs ?? CAN_IT_FAIL_RUNS} runs at most.`,
    promptSnippet: "can_it_fail: whether the unit tests catch a bug you put in a copy of the code",
    parameters: Type.Object({
      file: Type.String({ description: "The code file to change, relative to the code folder" }),
      find: Type.String({ description: "Text that is in the file exactly once - the code to change" }),
      replace: Type.String({ description: "What it becomes: the bug" }),
    }),
    async execute(_id, params) {
      const { file, find, replace } = params as { file: string; find: string; replace: string };
      const say = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
      if (left <= 0) return say("can_it_fail has no runs left in this session: decide with what it showed.");
      const path = resolve(options.buildDir, file);
      if (relative(options.buildDir, path).startsWith(`..${sep}`) || relative(options.buildDir, path) === "..") return say(`${file} is not in the code folder.`);
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        return say(`There is no ${file} in the code folder.`);
      }
      const at = text.indexOf(find);
      if (at === -1) return say(`"${find}" is not in ${file}: give text that is in it exactly as written.`);
      if (text.indexOf(find, at + 1) !== -1) return say(`"${find}" is in ${file} more than once: give more of it, so it is there once.`);
      if (find === replace) return say("The change changes nothing.");
      left -= 1;
      let run: ScriptRun;
      try {
        run = await runOnCode(
          options.buildDir,
          options.script,
          "unit testing script, with the change",
          (copy) => writeFileSync(join(copy, relative(options.buildDir, path)), text.slice(0, at) + replace + text.slice(at + find.length)),
          canItFailLimitMs(options.buildDir, options.script),
        );
      } catch (error) {
        return say(error instanceof Error ? error.message : String(error));
      }
      const verdict =
        run.timedOut === true
          ? `The unit tests did not finish in ${Math.round(run.timeoutMs / 1000)}s with ${file} changed: the bug makes the code hang - a loop that never ends, a wait for something that never comes. That shows the code breaks, not that a test catches it: the tests hang too. Put in a bug that makes a result wrong instead - a value, a status, a field - and check again.`
          : run.exitCode === 0
          ? `Every unit test passes with ${file} changed: no test catches this bug. A test that should - one for the behaviour this code is for - does not check what it says.`
          : `The unit tests fail with ${file} changed: something catches it. Check in the output below that a test's assertion caught it - a failure only because the copy no longer builds or imports says nothing about the tests.`;
      // A hang prints the same thing over and over: its last lines are enough.
      const shown = run.timedOut === true ? `${run.command} was stopped after ${Math.round(run.timeoutMs / 1000)}s. Its last output:\n\n${run.output.trimEnd().slice(-2_000)}` : outputOf(run);
      return { content: [{ type: "text" as const, text: `${verdict} (${left} run${left === 1 ? "" : "s"} left)\n\n${shown}` }], details: { exitCode: run.exitCode } };
    },
  }) as ToolDefinition;
}

/** When the coding agent checks its own work, by the tools it has: before the unit tests, and before it hands the work in. */
export function selfCheckNote(tools: string[]): string[] {
  const has = (name: string) => tools.includes(name);
  const steps = [
    ...(has("run_static_checks") ? ["run_static_checks before the unit tests, and fix what it finds"] : []),
    ...(has("can_it_fail") ? ["for each behaviour you built, check with can_it_fail that a test fails when it breaks"] : []),
    ...(has("start_service") ? ["where you built a server, start it with start_service and try what you built with curl, as a client would"] : []),
    ...(has("my_diff") ? ["read my_diff: every part of the change in it, and nothing else"] : []),
  ];
  return steps.length > 0 ? [`Check your own work before you hand it in: ${steps.join("; ")}.`, ""] : [];
}
