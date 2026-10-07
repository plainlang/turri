import { existsSync, readFileSync } from "node:fs";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ask, BEGIN, createExecutor } from "../pi.ts";
import { confinedTools } from "./confine.ts";
import { createWebTools, WEB_TOOLS } from "./web.ts";

/**
 * A fresh look at a failure the coding agent keeps hitting.
 *
 * The coding agent's session fills with its own attempts, and an agent stuck on a failure tends to keep circling the
 * same few changes - moving files about, reordering a fixture - when the cause is one it has not thought of: an
 * in-memory database every connection opens anew, a test runner that does not put the project on the path. When the
 * unit tests fail the same way round after round, the harness starts this agent: a session of its own, the coding
 * model unless the config gives the `debugger` role one, that reads the code, the tests, the build files and the
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
  label: string;
  model?: string;
  onDelta?: (delta: string) => void;
}

export interface Diagnosis {
  rootCause: string;
  fix: string;
}

/** The debugger's account, as the coding agent is given it. */
export function diagnosisText(diagnosis: Diagnosis): string {
  return [`<root cause>\n${diagnosis.rootCause.trim()}\n</root cause>`, `<fix>\n${diagnosis.fix.trim()}\n</fix>`].join("\n\n");
}

function debugPrompt(input: DebugInput): string {
  const script = input.script !== undefined && existsSync(input.script) ? readFileSync(input.script, "utf8") : undefined;
  return [
    `The unit tests of the codebase in ${input.buildDir} have failed the same way ${input.times} times in a row. The coding agent`,
    "keeps changing things and the failure does not move: it has not seen the cause. You look at it with fresh eyes.",
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
    "",
    "<what the change is meant to do>",
    input.task.trim(),
    "</what the change is meant to do>",
    ...(script !== undefined ? ["", `<testing script path="${input.script}">`, script.trimEnd(), "</testing script>"] : []),
    "",
    "<failing run>",
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
    }),
    async execute(_id, params) {
      const given = params as { root_cause: string; fix: string };
      found = { rootCause: given.root_cause, fix: given.fix };
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
