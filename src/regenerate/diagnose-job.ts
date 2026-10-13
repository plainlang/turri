import type { TranscriptEntry } from "./activity.ts";
import { describeJob, type Job } from "./jobs.ts";

/**
 * Why a job did not land, from its transcript: how it ended, the last failing run of a testing script, the review that
 * sent the work back last, the stages that went wrong and the tool calls that failed - what someone reading the whole
 * log would look for first, so the conversation does not have to guess from the report.
 */

const LAST_RUN_CHARS = 6_000;
const LAST_REVIEW_CHARS = 4_000;
const SHOWN_ERRORS = 5;
const SHOWN_STAGES = 12;

const textOf = (entry: TranscriptEntry) => entry.full ?? entry.text;

/** A testing script's run that failed, as the harness or an agent's run_unit_tests / run_conformance_tests saw it. */
const FAILED_RUN = /\bexited ([1-9]\d*)\b|had not finished after \d+ seconds/;
/** A stage that says something went wrong. */
const WRONG = /not passing|did not|failing|failed|✗|undoing|stopped|halt|wrong|missing/i;

export function whyFailed(job: Job): string {
  const ended = describeJob(job);
  if (job.status === "running" || job.status === "queued") return `${ended}\n\nIt has not ended yet: pulses says how it is going.`;
  const transcript = job.transcript;
  // An agent's run is a tool result; the harness's own reaches the agent as the prompt that sends it back.
  const lastRun = [...transcript].reverse().find((entry) => (entry.kind === "result" || entry.kind === "prompt") && FAILED_RUN.test(textOf(entry)));
  const lastReview = [...transcript].reverse().find((entry) => entry.kind === "prompt" && /A review of the work found|review found/i.test(textOf(entry)));
  const stages = transcript.filter((entry) => entry.kind === "stage" && WRONG.test(entry.text)).slice(-SHOWN_STAGES);
  const errors = transcript.filter((entry) => entry.kind === "result" && entry.error === true).slice(-SHOWN_ERRORS);
  const tail = (text: string, chars: number) => (text.length > chars ? `… ${text.slice(-chars)}` : text);
  return [
    ended,
    ...(job.diagnosis !== undefined ? ["", "<diagnosis>", job.diagnosis.trim(), "</diagnosis>"] : []),
    ...(stages.length > 0 ? ["", "<what went wrong, as it happened>", ...stages.map((entry) => `- ${entry.text.trim()}`), "</what went wrong, as it happened>"] : []),
    ...(lastRun !== undefined
      ? ["", `<last failing test run${lastRun.agent !== undefined ? ` by="${lastRun.agent.label}"` : ""}>`, tail(textOf(lastRun).trim(), LAST_RUN_CHARS), "</last failing test run>"]
      : []),
    ...(lastReview !== undefined ? ["", "<last review that sent the work back>", tail(textOf(lastReview).trim(), LAST_REVIEW_CHARS), "</last review that sent the work back>"] : []),
    ...(errors.length > 0
      ? ["", "<tool calls that failed, last ones>", ...errors.map((entry) => `- ${entry.agent?.label ?? "an agent"}: ${textOf(entry).trim().slice(0, 400)}`), "</tool calls that failed, last ones>"]
      : []),
    ...(job.logFile !== undefined ? ["", `The whole transcript: ${job.logFile}`] : []),
  ].join("\n");
}
