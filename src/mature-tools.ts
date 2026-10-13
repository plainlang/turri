import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatDuration, type Job, type JobRegistry } from "./regenerate/jobs.ts";
import { readNotes } from "./regenerate/notes.ts";
import { modulesRoot, projectDirOf } from "./regenerate/paths.ts";

/**
 * The tools a skill that matures a spec works with, besides the conversation's regenerate, drift and halt: wait for
 * the builds, and read back where the spec left the agents to decide.
 *
 * A render that passes can still have been built on a guess: where the spec is silent, the agent
 * decides, and says so in the working notes' assumptions. Those, the pitfalls, a failed job's
 * diagnosis and a spec that contradicts itself are what the spec should have said - and a skill
 * reading them can write it in, so the next build does not have to guess.
 */

type AnyTool = ToolDefinition<any, any, any>;

/** What a maturing skill found: where it came from, and what it says. */
export interface SpecFinding {
  id: string;
  kind: "assumption" | "pitfall" | "diagnosis" | "conflict";
  /** The module whose codebase it came from, or the job it came from. */
  where: string;
  text: string;
}

/** A time as the notes stamp their lines: "2026-09-28 17:40". */
export function noteStamp(date: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** Every module codebase of a project that has working notes. */
function codebasesOf(project: string): Array<{ module: string; buildDir: string }> {
  const root = modulesRoot(project);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ module: entry.name, buildDir: join(root, entry.name, "code") }))
    .filter((codebase) => existsSync(codebase.buildDir));
}

/** A notes line's stamp, and what it says: "[2026-09-28 17:40 · app 3] text". */
function stamped(line: string): { stamp: string; source: string; text: string } | undefined {
  const match = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · ([^\]]*)\]\s*(.*)$/.exec(line);
  return match === null ? undefined : { stamp: match[1]!, source: match[2]!, text: match[3]! };
}

/**
 * What the agents and the harness recorded since `since`: the assumptions and pitfalls in every
 * codebase's working notes, the diagnosis of every job that failed for good, and every spec that
 * contradicts itself.
 */
export function collectFindings(options: { project: string; jobs: Job[]; since: Date }): Omit<SpecFinding, "id">[] {
  const since = noteStamp(options.since);
  const found: Omit<SpecFinding, "id">[] = [];
  for (const { module, buildDir } of codebasesOf(options.project)) {
    // The code's notes, and its conformance tests' beside them.
    for (const notes of [readNotes(buildDir), readNotes(join(dirname(buildDir), "tests"))]) {
      for (const [section, kind] of [["assumptions", "assumption"], ["pitfalls", "pitfall"]] as const) {
        for (const line of notes[section]) {
          const item = stamped(line);
          if (item === undefined || item.stamp < since) continue;
          found.push({ kind, where: `${module} (${item.source})`, text: item.text });
        }
      }
    }
  }
  for (const job of options.jobs) {
    if (job.queuedAt < options.since.getTime()) continue;
    if (job.specConflict !== undefined) {
      const specs = job.specConflict.specs.map((spec) => `${spec.module} ${spec.frid}: ${spec.text.trim()}`).join("\n");
      found.push({ kind: "conflict", where: `job ${job.id} (${job.summary})`, text: `${job.specConflict.reasons.at(-1) ?? ""}\n${specs}`.trim() });
    }
    if (job.diagnosis !== undefined) found.push({ kind: "diagnosis", where: `job ${job.id} (${job.summary})`, text: job.diagnosis.trim() });
  }
  return found;
}

/** How a job stands, in a line: what it is, how it ended, and the first line of what it said. */
function jobLine(job: Job): string {
  const said = (job.status === "succeeded" ? job.report : job.error ?? job.report)?.trim().split("\n")[0] ?? "";
  const flags = [job.diagnosis !== undefined ? "diagnosed" : "", job.specConflict !== undefined ? "spec conflict" : ""].filter(Boolean).join(", ");
  return `- job ${job.id} · ${job.summary} · ${job.status}${job.status === "running" || job.status === "queued" ? "" : ` after ${formatDuration(job)}`}${flags ? ` · ${flags}` : ""}${said ? ` - ${said.slice(0, 200)}` : ""}`;
}

/** Why a build is struggling: a key for what kind of struggle it is - handed out once each - and what it says. */
export interface Struggle {
  key: string;
  why: string;
}

/** Setbacks a build reports as it goes: its stages that say a run failed, a review sent tests back, a judge found something wrong. */
const SETBACK = /not passing|NOT passing|the review found|is wrong|found the|failed|a spec conflict|contradicts|stuck|cannot|still leave|trying it once more/;

/** How long a build may run before it counts as struggling on its length alone. */
export const LONG_BUILD_MS = 30 * 60_000;

/**
 * Whether a running build is struggling, and how: sent back four times or more in one loop, five
 * setbacks or more, a spec conflict raised, a failure being run again, or running far longer than a
 * build should. Each kind comes once per build - a round count again only every four rounds more.
 */
export function struggling(job: Job, now = Date.now()): Struggle | undefined {
  if (job.status !== "running") return undefined;
  const stages = job.transcript.filter((entry) => entry.kind === "stage").map((entry) => entry.text);
  if (stages.some((stage) => /a spec conflict|contradicts itself/.test(stage))) return { key: "conflict", why: "a spec conflict was raised: two functional specs that may not both hold" };
  if (stages.some((stage) => /trying it once more/.test(stage))) return { key: "retry", why: "it failed once and is being run again" };
  const round = /round (\d+) of (\d+)/.exec(job.stage ?? "");
  if (round !== null && Number(round[1]) >= 4) {
    const bucket = Math.floor((Number(round[1]) - 4) / 4);
    return { key: `rounds-${bucket}`, why: `sent back ${round[1]} times of at most ${round[2]}: ${job.stage}` };
  }
  const setbacks = stages.filter((stage) => SETBACK.test(stage));
  if (setbacks.length >= 5) return { key: `setbacks-${Math.floor(setbacks.length / 5)}`, why: `${setbacks.length} setbacks so far - the last: ${setbacks.at(-1)}` };
  if (now - job.startedAt > LONG_BUILD_MS) return { key: `long-${Math.floor((now - job.startedAt) / LONG_BUILD_MS)}`, why: `running for ${formatDuration(job)}` };
  return undefined;
}

/** A struggling build, for the skill to judge: why, its last stages, and the end of what it printed. */
function describeStruggle(job: Job, struggle: Struggle): string {
  const stages = job.transcript.filter((entry) => entry.kind === "stage").map((entry) => entry.text).slice(-12);
  return [
    `job ${job.id} · ${job.summary} · ${struggle.why}`,
    job.diff !== undefined ? `<its change>\n${job.diff.trim().slice(0, 3000)}\n</its change>` : "",
    `<its last stages>\n${stages.map((stage) => `- ${stage}`).join("\n")}\n</its last stages>`,
    job.tail.trim() !== "" ? `<the end of its output>\n${job.tail.trim().slice(-2500)}\n</the end of its output>` : "",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

export function createMatureTools(options: { jobs: JobRegistry; cwd: string; startedAt?: Date }): AnyTool[] {
  const startedAt = options.startedAt ?? new Date();
  const mine = () => options.jobs.list().filter((job) => job.queuedAt >= startedAt.getTime());
  /** Findings already handed out, by what they say: each is reported once. */
  const reported = new Set<string>();
  let counter = 0;

  /** The struggles already handed out, by job and what they were - each reported once, again only when it grows. */
  const flagged = new Set<string>();

  const watchJobs = defineTool({
    name: "watch_jobs",
    label: "Watch the builds",
    description:
      "Watch the builds queued since this run started, and come back as soon as one is struggling - sent back again and " +
      "again, setback after setback, a spec conflict raised, a failure being run again, running far too long - or when " +
      "every one has finished, or when `minutes` have passed. For a struggling build it gives what it has been through: its " +
      "last stages and the end of its output. Says how every build stands.",
    promptSnippet: "watch the builds, and come back when one struggles or all are done",
    parameters: Type.Object({
      minutes: Type.Optional(Type.Number({ description: "The longest to watch, in minutes. Default 20" })),
    }),
    async execute(_id, params, signal) {
      const limit = Math.max(1, Math.min(120, params.minutes ?? 20)) * 60_000;
      const deadline = Date.now() + limit;
      const pending = () => mine().filter((job) => job.status === "running" || job.status === "queued");
      const newStruggles = () =>
        mine()
          .map((job) => ({ job, struggle: struggling(job) }))
          .filter((item): item is { job: Job; struggle: Struggle } => item.struggle !== undefined && !flagged.has(`${item.job.id}|${item.struggle.key}`));
      let found = newStruggles();
      while (found.length === 0 && pending().length > 0 && Date.now() < deadline && signal?.aborted !== true) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        found = newStruggles();
      }
      for (const item of found) flagged.add(`${item.job.id}|${item.struggle.key}`);
      const all = mine().sort((a, b) => a.sequence - b.sequence);
      const left = pending();
      const text = [
        found.length > 0
          ? `${found.length} build${found.length === 1 ? " is" : "s are"} struggling:`
          : left.length === 0
            ? `Every build queued since this run started has finished (${all.length}).`
            : `No build is struggling; ${left.length} of ${all.length} are still running or queued - call watch_jobs again.`,
        ...found.flatMap(({ job, struggle }) => ["", describeStruggle(job, struggle)]),
        "",
        "Every build:",
        ...all.map(jobLine),
        "",
        "Read what the builds had to decide themselves with spec_findings; see how far the spec is regenerated with drift.",
      ].join("\n");
      return { content: [{ type: "text" as const, text }], details: { pending: left.length, struggling: found.map((item) => item.job.id) } };
    },
  });

  const specFindings = defineTool({
    name: "spec_findings",
    label: "What the spec left open",
    description:
      "What the builds since this run started recorded where the spec left them to decide or went wrong: every " +
      "assumption and pitfall in the codebases' working notes, the diagnosis of every job that failed for good, and every " +
      "spec that contradicts itself - each numbered, and each given once: a finding already handed out is not repeated.",
    promptSnippet: "where the builds had to guess, or failed on the spec",
    parameters: Type.Object({
      plain_file: Type.Optional(Type.String({ description: "A .plain file of the project to read; default the session's folder" })),
      all: Type.Optional(Type.Boolean({ description: "Every finding since the run started, not only the new ones" })),
    }),
    async execute(_id, params) {
      // The project a spec is built in; with none named, the one the session's folder is.
      const project = projectDirOf(params.plain_file !== undefined ? resolve(options.cwd, params.plain_file) : join(options.cwd, "session.plain"));
      const found = collectFindings({ project, jobs: mine(), since: startedAt });
      const fresh = found.filter((finding) => params.all === true || !reported.has(`${finding.kind}|${finding.where}|${finding.text}`));
      const numbered = fresh.map((finding) => {
        reported.add(`${finding.kind}|${finding.where}|${finding.text}`);
        counter += 1;
        return { ...finding, id: `f${counter}` };
      });
      const text =
        numbered.length === 0
          ? "No new findings: the builds since the last look recorded no assumption, no pitfall, no diagnosis and no spec conflict."
          : [
              `${numbered.length} finding${numbered.length === 1 ? "" : "s"}:`,
              "",
              ...numbered.map((finding) => `${finding.id} · ${finding.kind} · ${finding.where}\n${finding.text}`),
            ].join("\n\n");
      return { content: [{ type: "text" as const, text }], details: { findings: numbered } };
    },
  });

  return [watchJobs, specFindings];
}

/** The names of the maturing tools, as a skill's allowed-tools names them: its own - it grows, halts and reads drift with the conversation's (loop-tools.ts). */
export const MATURE_TOOLS = ["watch_jobs", "spec_findings"];

