import { existsSync, readFileSync } from "node:fs";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ask, BEGIN, createExecutor } from "../pi.ts";
import { confinedTools } from "./confine.ts";
import { createWebTools, WEB_TOOLS } from "./web.ts";
import { runTiming, type ScriptRun } from "./test-scripts.ts";

/**
 * A fresh look at a failure the coding agent keeps hitting.
 *
 * The coding agent's session fills with its own attempts, and an agent stuck on a failure tends to keep circling the
 * same few changes - moving files about, reordering a fixture - when the cause is one it has not thought of: an
 * in-memory database every connection opens anew, a test runner that does not put the project on the path. When the
 * unit tests fail the same way round after round, or the agent goes round in circles in its own runs, the harness starts
 * this agent: a session of its own - on the `debugger` role's model, else a stronger one than the coding agent's, the
 * judge model or the harness model - that reads the code, the tests, the build files and the
 * failing run - and the web - and says what the cause is and what change fixes it. It changes nothing; the coding
 * agent is given what it found, and goes on.
 */

/** How many tool calls the debugger has before it must hand over what it found. */
const DEBUGGER_CALLS = 40;

export interface DebugInput {
  /** The codebase: what it reads. */
  buildDir: string;
  /** The failing run, as the harness saw it. */
  failure: string;
  /** How many times in a row it has failed this way. */
  times: number;
  /** What the change is meant to do: the spec as the coding agent has it. */
  task: string;
  /** The testing script that decides pass or fail, with its path: how the tests are run, and where. */
  script?: string;
  /** How the failing run ended against its time limit: how long it took, and whether the limit stopped it. */
  run?: Pick<ScriptRun, "exitCode" | "timedOut" | "timeoutMs" | "elapsedMs">;
  label: string;
  model?: string;
  onDelta?: (delta: string) => void;
}

export interface Diagnosis {
  rootCause: string;
  fix: string;
  /**
   * The run the time limit stopped hangs on nothing: it was making progress up to the limit and needs more time than a
   * test run may take - which no agent can give it. Taken only of a run the limit stopped.
   */
  tooSlow?: boolean;
}

/** The debugger's account, as the coding agent is given it. */
export function diagnosisText(diagnosis: Diagnosis): string {
  return [`<root cause>\n${diagnosis.rootCause.trim()}\n</root cause>`, `<fix>\n${diagnosis.fix.trim()}\n</fix>`].join("\n\n");
}

function debugPrompt(input: DebugInput): string {
  const script = input.script !== undefined && existsSync(input.script) ? readFileSync(input.script, "utf8") : undefined;
  const timedOut = input.run?.timedOut === true;
  return [
    timedOut
      ? `The unit testing script of the codebase in ${input.buildDir} did not finish: the time limit stopped it. You look at it with fresh eyes.`
      : `The unit tests of the codebase in ${input.buildDir} have failed the same way ${input.times} times in a row. The coding agent`,
    ...(timedOut ? [] : ["keeps changing things and the failure does not move: it has not seen the cause. You look at it with fresh eyes."]),
    "",
    "Find the root cause - the one thing that makes this failure happen - and the change that fixes it. Read the failing",
    "run below, the tests it names, the code they exercise, the build files (pyproject.toml, package.json, go.mod, pom.xml,",
    "...) and the testing script below: it decides pass or fail, and how and where it runs the tests is often the cause.",
    "Look the error up on the web when it is one a library or tool is known for. Think about what the coding agent may have",
    "missed rather than what it has already tried: a test runner that does not put the code on its import path, an",
    "in-memory database that every connection opens empty, a name that shadows another, a configuration a tool needs.",
    "",
    "You change nothing - you only read. When you know, call submit_diagnosis: the root cause, with the evidence for it,",
    "and the fix - which files, and exactly what to change in them.",
    ...(timedOut
      ? [
          "",
          "<timed out>",
          "The run's output ends where the time limit stopped it: the test running then, or the step after the last one it",
          "printed, is what did not finish. Find what kept it:",
          "- something hangs - a test or the code waits on input, keeps a server in the foreground, never exits, loops, blocks",
          "  on a lock or a network call that never answers: the root cause and the fix, as for any failure;",
          "- nothing hangs - the output shows the run making steady progress right up to the limit (installing, building, test",
          "  after test passing) and it needs more time than a test run may take: set too_slow, and say in root_cause from the",
          "  output how far it got and what took the time. No agent can give it more time: the work stops, and the person is",
          "  told to raise the limit. Judge from the output and the files, never from the time alone.",
          "</timed out>",
        ]
      : []),
    "",
    "<what the change is meant to do>",
    input.task.trim(),
    "</what the change is meant to do>",
    ...(script !== undefined ? ["", `<testing script path="${input.script}">`, script.trimEnd(), "</testing script>"] : []),
    "",
    "<failing run>",
    ...(input.run !== undefined ? [runTiming(input.run), ""] : []),
    input.failure.trimEnd().slice(-8000),
    "</failing run>",
  ].join("\n");
}

/** Have a fresh agent find why the unit tests keep failing the same way: its root cause and fix, or undefined when it found none. */
export async function debugFailure(input: DebugInput): Promise<Diagnosis | undefined> {
  let found: Diagnosis | undefined;
  const submit = defineTool({
    name: "submit_diagnosis",
    label: "Submit the diagnosis",
    description: "Hand over the root cause of the failure and the change that fixes it. The coding agent gets only this.",
    parameters: Type.Object({
      root_cause: Type.String({ description: "The one thing that makes the failure happen, and the evidence for it: the lines of the run, the code, the docs" }),
      fix: Type.String({ description: "The change that fixes it: which files, and exactly what to change in them" }),
      too_slow: Type.Optional(
        Type.Boolean({
          description:
            "Only for a run the time limit stopped: true when nothing hangs - it was making progress up to the limit and needs more time than a test run may take",
        }),
      ),
    }),
    async execute(_id, params) {
      const given = params as { root_cause: string; fix: string; too_slow?: boolean };
      // Too slow is a verdict on a run the limit stopped, and on no other.
      found = { rootCause: given.root_cause, fix: given.fix, ...(given.too_slow === true && input.run?.timedOut === true ? { tooSlow: true } : {}) };
      return { content: [{ type: "text" as const, text: "Recorded." }], details: {}, terminate: true };
    },
  }) as ToolDefinition;
  // It reads the code and the web, and changes nothing: the file tools, no shell.
  const fence = confinedTools({ workdir: input.buildDir, read: [input.buildDir], write: [], noBash: true });
  const session = await createExecutor({
    cwd: input.buildDir,
    customTools: [submit, ...createWebTools(), ...fence.tools],
    tools: [...fence.names, ...WEB_TOOLS, "submit_diagnosis"],
    ...(input.model !== undefined ? { model: input.model } : {}),
    label: `${input.label} debugger`,
    role: "debugger",
    system: fence.note,
    task: debugPrompt(input),
    budget: { calls: DEBUGGER_CALLS, finish: ["submit_diagnosis"] },
  });
  try {
    await ask(session, BEGIN, input.onDelta);
    if (found === undefined) await ask(session, "Call submit_diagnosis now with what you found: the most likely root cause, and the fix.", input.onDelta);
  } finally {
    session.dispose();
  }
  return found;
}
