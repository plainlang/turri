import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatDuration, type Job, type JobRegistry } from "./render/jobs.ts";
import { readNotes } from "./render/notes.ts";
import { modulesRoot, projectDirOf } from "./render/paths.ts";
import type { RenderQueue } from "./render/queue.ts";
import { snapshotSpec } from "./render/spec-change.ts";
import { diffSpecText, layoutOf, reachedByRendering, sameSpec, serializeTree } from "./render/spec-steps.ts";
import { readBuiltTree } from "./render/state.ts";

/**
 * The tools a skill that tempers a spec works with: build what the spec holds, wait for the builds,
 * and read back where the spec left the agents to decide.
 *
 * A render that passes can still have been built on a guess: where the spec is silent, the agent
 * decides, and says so in the working notes' assumptions. Those, the pitfalls, a failed job's
 * diagnosis and a spec that contradicts itself are what the spec should have said - and a skill
 * reading them can write it in, so the next build does not have to guess.
 */

type AnyTool = ToolDefinition<any, any, any>;

/** What a tempering skill found: where it came from, and what it says. */
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
    const notes = readNotes(buildDir);
    for (const [section, kind] of [["assumptions", "assumption"], ["pitfalls", "pitfall"]] as const) {
      for (const line of notes[section]) {
        const item = stamped(line);
        if (item === undefined || item.stamp < since) continue;
        found.push({ kind, where: `${module} (${item.source})`, text: item.text });
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

export function createTemperTools(options: { queue: RenderQueue; jobs: JobRegistry; cwd: string; startedAt?: Date }): AnyTool[] {
  const startedAt = options.startedAt ?? new Date();
  const mine = () => options.jobs.list().filter((job) => job.queuedAt >= startedAt.getTime());
  /** Findings already handed out, by what they say: each is reported once. */
  const reported = new Set<string>();
  let counter = 0;

  const renderSpec = defineTool({
    name: "render_spec",
    label: "Render the spec",
    description:
      "Queue the build of everything a module's spec holds that its code is not built from: functionality by " +
      "functionality when only new functional specs were added - or nothing is built yet - and otherwise one spec diff " +
      "from what the code is built from to the spec as it is. For a module that requires another, render the one it " +
      "requires first. Returns the jobs it queued; wait for them with wait_for_jobs.",
    promptSnippet: "render_spec: queue the build of what a module's spec holds that is not built",
    parameters: Type.Object({ plain_file: Type.String({ description: "The module's .plain file" }) }),
    async execute(_id, params) {
      const plainFile = resolve(options.cwd, params.plain_file);
      const spec = snapshotSpec(plainFile, { cwd: options.cwd });
      const codebase = spec.chain.at(-1)!.buildDir;
      const built = readBuiltTree(codebase);
      const say = (text: string, jobIds: string[] = []) => ({ content: [{ type: "text" as const, text }], details: { jobIds } });
      if (built !== null && sameSpec(built, spec.tree)) return say(`${basename(plainFile)}: its code is already built from the spec as it is - nothing to render.`);
      // Only functional specs added, or nothing built: each is built on the ones before it, one job each.
      if (reachedByRendering(built, spec.tree)) {
        const queued = options.queue.catchUp(plainFile);
        if (queued.length === 0) return say(`${basename(plainFile)}: nothing to render - every functionality is built from its spec, or already queued.`);
        return say(`Queued ${queued.length} render${queued.length === 1 ? "" : "s"} of ${basename(plainFile)}: ${queued.map((entry) => `functionality ${entry.frid} (job ${entry.jobId})`).join(", ")} - with their conformance tests, when they are on.`, queued.map((entry) => entry.jobId));
      }
      // Changed in place: the whole difference as one spec diff.
      let layout;
      try {
        layout = layoutOf(readFileSync(spec.plainFile, "utf8"));
      } catch {
        /* the layout is only for how the diff reads */
      }
      const diff = diffSpecText(serializeTree(built!), serializeTree(spec.tree), relative(options.cwd, spec.plainFile), layout);
      const queued = options.queue.enqueueSpecDiff({ plainFile, diff, applied: "already applied", spec });
      return say(`Queued the difference between what ${basename(plainFile)}'s code is built from and its spec as one spec diff: job ${queued.jobId}.`, queued.parts.map((part) => part.jobId));
    },
  });

  const waitForJobs = defineTool({
    name: "wait_for_jobs",
    label: "Wait for the builds",
    description:
      "Wait until every build queued since this run started has finished - or `minutes` have passed - and say how each " +
      "one ended. Call it again when some are still running.",
    promptSnippet: "wait_for_jobs: wait for the queued builds and say how each ended",
    parameters: Type.Object({
      minutes: Type.Optional(Type.Number({ description: "The longest to wait, in minutes. Default 20" })),
    }),
    async execute(_id, params, signal) {
      const limit = Math.max(1, Math.min(120, params.minutes ?? 20)) * 60_000;
      const deadline = Date.now() + limit;
      const pending = () => mine().filter((job) => job.status === "running" || job.status === "queued");
      while (pending().length > 0 && Date.now() < deadline && signal?.aborted !== true) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      const all = mine().sort((a, b) => a.sequence - b.sequence);
      const left = pending();
      const text = [
        left.length === 0 ? `Every build queued since this run started has finished (${all.length}).` : `${left.length} of ${all.length} builds are still running or queued - call wait_for_jobs again.`,
        "",
        ...all.map(jobLine),
        "",
        "Read what the builds had to decide themselves with spec_findings.",
      ].join("\n");
      return { content: [{ type: "text" as const, text }], details: { pending: left.length } };
    },
  });

  const specFindings = defineTool({
    name: "spec_findings",
    label: "What the spec left open",
    description:
      "What the builds since this run started recorded where the spec left them to decide or went wrong: every " +
      "assumption and pitfall in the codebases' working notes, the diagnosis of every job that failed for good, and every " +
      "spec that contradicts itself - each numbered, and each given once: a finding already handed out is not repeated.",
    promptSnippet: "spec_findings: where the builds had to guess, or failed on the spec",
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

  return [renderSpec, waitForJobs, specFindings];
}

/** The names of the tempering tools, as a skill's allowed-tools names them. */
export const TEMPER_TOOLS = ["render_spec", "wait_for_jobs", "spec_findings"];

