import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ask, BEGIN, createExecutor } from "../pi.ts";
import { confinedTools } from "./confine.ts";

/**
 * Why a job failed twice, and what has to be done about it - worked out by an agent that can read
 * everything the job depended on: the project's specs, code, tests and testing scripts, the job's
 * log and its agents' logs, and plainwright itself - its source, its skills and its rules. Read only.
 *
 * A job is retried once; failing again, it and every job queued behind it fail, and this is what the
 * person is told: not the last stage it reached, but the cause, and whose it is to fix.
 */

export interface Diagnosis {
  whatHappened: string;
  cause: string;
  /** Where the fix belongs: the spec, the environment, the code, or plainwright itself. */
  whose: "spec" | "environment" | "code" | "harness";
  todo: string[];
}

/** How many tool calls the diagnosis may make before it is told to decide. */
export const DIAGNOSIS_CALLS = 40;

export function describeDiagnosis(diagnosis: Diagnosis): string {
  const whose = { spec: "the spec", environment: "the environment", code: "the code", harness: "plainwright itself" }[diagnosis.whose];
  return [
    `What happened: ${diagnosis.whatHappened.trim()}`,
    `Why: ${diagnosis.cause.trim()}`,
    `To fix - in ${whose}:`,
    ...diagnosis.todo.map((step, index) => `  ${index + 1}. ${step.trim()}`),
  ].join("\n");
}

export async function diagnoseFailure(options: {
  /** The job, as it is listed: its kind and what it was asked to do. */
  job: { id: string; kind: string; summary: string };
  /** What each attempt ended with - its report or its error. */
  failures: string[];
  /** The project: its specs, config, testing scripts and plain_modules. */
  projectDir: string;
  /** plainwright's own folder: its source, skills, rules and docs. */
  harnessDir: string;
  /** The job's own log, when it has one. */
  jobLog?: string;
  model?: string;
}): Promise<Diagnosis | undefined> {
  let diagnosis: Diagnosis | undefined;
  const submit = defineTool({
    name: "submit_diagnosis",
    label: "Submit the diagnosis",
    description: "Hand over what happened, why, whose it is to fix and exactly what to do. Call this once.",
    parameters: Type.Object({
      what_happened: Type.String({ description: "What the job did and where it failed, both times - in a few sentences" }),
      cause: Type.String({ description: "The root cause, as the logs, the code, the tests or plainwright's source show it - quote what shows it" }),
      whose: Type.Union([Type.Literal("spec"), Type.Literal("environment"), Type.Literal("code"), Type.Literal("harness")], {
        description: "Where the fix belongs: the spec, the environment (a service, a credential, a toolchain), the code, or plainwright itself",
      }),
      todo: Type.Array(Type.String(), { description: "Exactly what to do, step by step - the file and the change, the command, the setting" }),
    }),
    async execute(_id, params) {
      const given = params as { what_happened: string; cause: string; whose: Diagnosis["whose"]; todo: string[] };
      diagnosis = { whatHappened: given.what_happened, cause: given.cause, whose: given.whose, todo: given.todo };
      return { content: [{ type: "text" as const, text: "Recorded." }], details: {}, terminate: true };
    },
  }) as ToolDefinition;
  const fence = confinedTools({ workdir: options.projectDir, read: [options.projectDir, options.harnessDir], write: [], noBash: true });
  const session = await createExecutor({
    cwd: options.projectDir,
    customTools: [submit, ...fence.tools],
    tools: [...fence.names, "submit_diagnosis"],
    model: options.model,
    label: `${options.job.summary} diagnosis`,
    system: fence.note,
    task: diagnosisPrompt(options),
    budget: { calls: DIAGNOSIS_CALLS, finish: ["submit_diagnosis"] },
  });
  try {
    await ask(session, BEGIN);
    if (diagnosis === undefined) await ask(session, "You have not called submit_diagnosis. Call it now, with what you know.");
  } catch {
    // Without a diagnosis the person still gets both failures, as they were.
  } finally {
    session.dispose();
  }
  return diagnosis;
}

export function diagnosisPrompt(options: {
  job: { id: string; kind: string; summary: string };
  failures: string[];
  projectDir: string;
  harnessDir: string;
  jobLog?: string;
}): string {
  return [
    `A plainwright job failed twice: ${options.job.kind} - ${options.job.summary} (job ${options.job.id}). It was tried a`,
    "second time and failed again, so it has stopped, and every job queued behind it has failed without running. Work",
    "out why, and what has to be done so it passes - the person is told exactly what you say.",
    "",
    "You can read, and change nothing:",
    `- the project, in ${options.projectDir}: its .plain specs and templates, config.yaml, the testing scripts, and`,
    "  plain_modules - each module's code and conformance tests, the notes (.plainwright-notes.md in the code), the full",
    "  outputs of the test runs (plain_modules/.plainwright/logs), and every agent's own log",
    `  (${options.projectDir}/.plainwright/debug) - newest last;`,
    ...(options.jobLog !== undefined ? [`- this job's own log: ${options.jobLog};`] : []),
    `- plainwright itself, in ${options.harnessDir}: its source (src/), its skills (skills/), the ***plain authoring rules`,
    "  (forge/rules/) and its docs (docs/) - so a failure that comes from the harness can be named as that.",
    "",
    "Find the root cause, not the last symptom: read the failing run's output and the agents' logs around where it",
    "failed, and follow it to the spec line, the code, the test, the environment or the harness it comes from. Then",
    "call submit_diagnosis: what happened, why, whose it is to fix, and exactly what to do.",
    "",
    ...options.failures.flatMap((failure, index) => [`<attempt ${index + 1}>`, failure.trim().slice(-12_000), `</attempt ${index + 1}>`, ""]),
  ].join("\n");
}
