import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { turriIdentity } from "./environment.ts";
import { onModelEvent, type ModelEvent, type UsageReport } from "./regenerate/activity.ts";
import type { Job } from "./regenerate/jobs.ts";
import type { SpecGap } from "./regenerate/notes.ts";

/**
 * A headless run's report: one JSON file, `turri regenerate --report <file>`, saying what the run did - how it ended,
 * what it spent, which pulses landed, how many functional specs are completed - for a benchmark or CI to read rather
 * than the log. See docs/headless.md for every field.
 *
 * Written when the run starts, again as each pulse ends, and last as the process exits - however it exits: done, a
 * pulse failed, a crash, a signal. A process killed outright (SIGKILL) leaves the one written as the last pulse ended.
 * Each write is atomic: the file is written beside it and renamed over it, so a reader never sees half of one.
 */

export const REPORT_SCHEMA_VERSION = 1;

/** What the usage of some model calls adds up to, as the report gives it. */
export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  /** Model responses. */
  llm_calls: number;
  /** Requests of the harness's to an agent, each as many calls as it takes. */
  agent_turns: number;
  compactions: number;
  /** Turns the provider failed for a moment, waited out and tried again. */
  provider_retries: number;
  /** Turns turri ended itself - the agent going round in a circle, its time up - and carried on from. */
  turns_stopped: number;
  /** How long the models took to answer, added up - from each request to its response's end. */
  model_seconds: number;
}

export type RunStatus = "running" | "completed" | "incomplete" | "failed" | "interrupted" | "crashed" | "dry_run";

/** How each codebase the run regenerates in stands, as the run ends. */
export interface ModuleState {
  module: string;
  state: "complete" | "incomplete" | "halted" | "start_over_needed" | "running";
  why?: string;
}

export interface CompletionCounts {
  codebase: string;
  modules: Array<{ module: string; specified: number; completed: number; conformanceTested: number; incomplete: string[] }>;
}

/** What the report is made from, read each time it is written. Each is asked in a try: one that fails leaves its part out. */
export interface ReportSources {
  jobs: () => Job[];
  modules?: () => ModuleState[];
  completion?: () => CompletionCounts[];
  /** Done once, as the process exits, before the last write: the code exported into --build-dir. */
  atExit?: () => Record<string, unknown> | undefined;
}

export interface RunReporter {
  attach(sources: ReportSources): void;
  /** How the run ended, as it decides: written as the process exits. A signal or a crash after it wins. */
  end(status: Exclude<RunStatus, "running">, error?: string): void;
  /** The run crashed: written as the process exits. */
  crashed(error: unknown): void;
  write(): void;
  /** The report as it would be written now. */
  build(exitCode?: number): Record<string, unknown>;
}

export interface RunReportOptions {
  file: string;
  command: string[];
  specFile: string;
  projectDir: string;
  buildDir?: string;
  conformanceTests: string;
  /** Whether the code and its tests are reviewed once they pass. */
  review?: boolean;
  /** Whether the coding agent and the reviewer had can_it_fail. */
  mutationTesting?: boolean;
  models: Record<"harness" | "coding" | "judge", { model?: string; thinking?: string }>;
  /** Not given: the process's exit is listened for. Tests write the last report themselves. */
  onExit?: false;
}

const SIGNALS: Record<number, string> = { 129: "SIGHUP", 130: "SIGINT", 143: "SIGTERM" };

const emptyTotals = (): UsageTotals => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cost_usd: 0,
  llm_calls: 0,
  agent_turns: 0,
  compactions: 0,
  provider_retries: 0,
  turns_stopped: 0,
  model_seconds: 0,
});

function addUsage(totals: UsageTotals, usage: UsageReport | undefined): void {
  if (usage === undefined) return;
  totals.input_tokens += usage.input;
  totals.output_tokens += usage.output;
  totals.cache_read_tokens += usage.cacheRead;
  totals.cache_write_tokens += usage.cacheWrite;
  totals.cost_usd += usage.cost;
}

/** An event's counts - a call, a turn, a compaction, the model's time - and, with `tokens`, its usage too. */
function addEvent(totals: UsageTotals, event: ModelEvent, tokens: boolean): void {
  if (event.kind === "call") {
    totals.llm_calls += 1;
    totals.model_seconds += (event.ms ?? 0) / 1000;
    if (tokens) addUsage(totals, event.usage);
  } else if (event.kind === "turn") totals.agent_turns += 1;
  else if (event.kind === "compaction") totals.compactions += 1;
  else if (event.kind === "provider_retry") totals.provider_retries += 1;
  else totals.turns_stopped += 1;
}

function sumTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  const sum = emptyTotals();
  for (const key of Object.keys(sum) as Array<keyof UsageTotals>) sum[key] = a[key] + b[key];
  return sum;
}

/** Tidied for reading: the cost to a millionth of a dollar, the time to a tenth of a second - float sums otherwise show their noise. */
function rounded(totals: UsageTotals): UsageTotals {
  return { ...totals, cost_usd: Math.round(totals.cost_usd * 1e6) / 1e6, model_seconds: Math.round(totals.model_seconds * 10) / 10 };
}

const pulseKind = (job: Job): string => (job.kind === "regenerate" ? "code" : job.kind);

const firstLines = (text: string | undefined): string | null => {
  const trimmed = text?.trim();
  return trimmed === undefined || trimmed === "" ? null : trimmed.length > 1000 ? `${trimmed.slice(0, 1000)}…` : trimmed;
};

/** Write a file whole or not at all: beside it first, then renamed over it. */
export function writeAtomically(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, text);
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function startRunReport(options: RunReportOptions): RunReporter {
  const file = resolve(options.file);
  const startedAt = Date.now();
  const identity = turriIdentity();
  const events: ModelEvent[] = [];
  const stopListening = onModelEvent((event) => events.push(event));
  let sources: ReportSources = { jobs: () => [] };
  let ended: { status: Exclude<RunStatus, "running">; error?: string } | undefined;
  let crash: string | undefined;
  let exitParts: Record<string, unknown> | undefined;
  let finishedAt: number | undefined;
  const fromProject = (path: string) => relative(options.projectDir, path) || ".";
  const attempt = <T>(read: (() => T) | undefined): T | undefined => {
    if (read === undefined) return undefined;
    try {
      return read();
    } catch {
      return undefined;
    }
  };

  const usageOf = (jobs: Job[]) => {
    const ids = new Set(jobs.map((job) => job.id));
    const kindOf = new Map(jobs.map((job) => [job.id, pulseKind(job)]));
    // In pulses: their tokens as each job adds them up - what its pulse line prints - and their calls from the events.
    const inPulses = emptyTotals();
    for (const job of jobs) addUsage(inPulses, job.usage);
    const outside = emptyTotals();
    const byModel: Record<string, UsageTotals> = {};
    const byRole: Record<string, UsageTotals> = {};
    const byKind: Record<string, UsageTotals> = {};
    for (const job of jobs) addUsage((byKind[pulseKind(job)] ??= emptyTotals()), job.usage);
    for (const event of events) {
      const inPulse = event.job !== undefined && ids.has(event.job);
      addEvent(inPulse ? inPulses : outside, event, !inPulse);
      addEvent((byModel[event.model ?? "unknown"] ??= emptyTotals()), event, true);
      addEvent((byRole[event.role ?? "unknown"] ??= emptyTotals()), event, true);
      if (inPulse) addEvent((byKind[kindOf.get(event.job!)!] ??= emptyTotals()), event, false);
    }
    const each = (table: Record<string, UsageTotals>) => Object.fromEntries(Object.entries(table).map(([key, totals]) => [key, rounded(totals)]));
    return {
      total: rounded(sumTotals(inPulses, outside)),
      in_pulses: rounded(inPulses),
      outside_pulses: rounded(outside),
      by_model: each(byModel),
      by_role: each(byRole),
      by_pulse_kind: each(byKind),
    };
  };

  const pulsesOf = (jobs: Job[], now: number) => {
    const callsOf = new Map<string, UsageTotals>();
    for (const event of events) if (event.job !== undefined) addEvent(callsOf.get(event.job) ?? callsOf.set(event.job, emptyTotals()).get(event.job)!, event, false);
    const list = jobs.map((job) => {
      const landed = job.status === "succeeded" && (job.details as { landed?: boolean } | undefined)?.landed === true;
      const ran = job.status !== "queued";
      const usage = sumTotals(callsOf.get(job.id) ?? emptyTotals(), (() => {
        const tokens = emptyTotals();
        addUsage(tokens, job.usage);
        return tokens;
      })());
      return {
        id: job.id,
        module: job.module ?? null,
        number: job.pulse ?? null,
        kind: pulseKind(job),
        title: job.title ?? job.summary,
        status: job.status,
        landed,
        failed_for_good: job.failedForGood === true,
        started_at: ran ? new Date(job.startedAt).toISOString() : null,
        duration_seconds: ran ? Math.round(((job.finishedAt ?? now) - job.startedAt) / 100) / 10 : null,
        usage: rounded(usage),
        agents: job.agents.map((agent) => ({
          label: agent.label,
          model: agent.model ?? null,
          turns: agent.turns,
          compactions: agent.compactions,
          input_tokens: agent.usage.input,
          output_tokens: agent.usage.output,
          cache_read_tokens: agent.usage.cacheRead,
          cache_write_tokens: agent.usage.cacheWrite,
          cost_usd: Math.round(agent.usage.cost * 1e6) / 1e6,
        })),
        log_file: job.logFile !== undefined ? fromProject(job.logFile) : null,
        error: job.status === "failed" || job.status === "stopped" ? firstLines(job.error) : null,
      };
    });
    const ran = list.filter((pulse) => pulse.status !== "queued");
    return {
      counts: {
        total: ran.length,
        landed: ran.filter((pulse) => pulse.landed).length,
        failed: ran.filter((pulse) => pulse.status === "failed").length,
        stopped: ran.filter((pulse) => pulse.status === "stopped").length,
        rolled_back: ran.filter((pulse) => !pulse.landed && pulse.status !== "running").length,
        running: ran.filter((pulse) => pulse.status === "running").length,
        not_started: list.length - ran.length,
      },
      list,
    };
  };

  /** The spec gaps the pulses' agents met, in the order the pulses started: questions a person would want to decide. */
  const specGapsOf = (jobs: Job[]) =>
    jobs.flatMap((job) => {
      const details = job.details as { landed?: boolean; specGaps?: SpecGap[] } | undefined;
      return (details?.specGaps ?? []).map((gap) => ({
        module: job.module ?? null,
        pulse: job.pulse ?? null,
        pulse_id: job.id,
        landed: job.status === "succeeded" && details?.landed === true,
        question: gap.question,
        assumption: gap.assumption,
      }));
    });

  /** Each turn the provider failed and turri waited out, and each turn turri ended itself: why, and where. */
  const turnIncidentsOf = () =>
    events
      .filter((event) => event.kind === "provider_retry" || event.kind === "stopped")
      .map((event) => ({
        kind: event.kind,
        pulse_id: event.job ?? null,
        role: event.role ?? null,
        model: event.model ?? null,
        ...(event.kind === "stopped"
          ? { reason: event.reason ?? null }
          : { error: event.error ?? null, attempt: event.attempt ?? null, of: event.of ?? null, wait_seconds: Math.round((event.waitMs ?? 0) / 100) / 10 }),
      }));

  const functionalitiesOf = (counts: CompletionCounts[] | undefined) => {
    if (counts === undefined) return null;
    const modules = counts.flatMap((chain) =>
      chain.modules.map((module) => ({
        module: module.module,
        specified: module.specified,
        completed: module.completed,
        conformance_tested: module.conformanceTested,
        incomplete_frids: module.incomplete,
      })),
    );
    return {
      total: {
        specified: modules.reduce((sum, module) => sum + module.specified, 0),
        completed: modules.reduce((sum, module) => sum + module.completed, 0),
        conformance_tested: modules.reduce((sum, module) => sum + module.conformance_tested, 0),
      },
      modules,
      codebases: counts.map((chain) => fromProject(chain.codebase)),
    };
  };

  const statusAt = (exitCode: number | undefined): { status: RunStatus; signal: string | null; error: string | null } => {
    const signal = exitCode !== undefined ? (SIGNALS[exitCode] ?? null) : null;
    if (crash !== undefined) return { status: "crashed", signal: null, error: crash };
    if (ended !== undefined) return { status: ended.status, signal: null, error: ended.error ?? null };
    if (exitCode === undefined) return { status: "running", signal: null, error: null };
    if (signal !== null) return { status: "interrupted", signal, error: null };
    return { status: exitCode === 0 ? "completed" : "crashed", signal: null, error: exitCode === 0 ? null : `exited with ${exitCode} before the run ended` };
  };

  const build = (exitCode?: number): Record<string, unknown> => {
    const now = finishedAt ?? Date.now();
    // In the order they started; one queued again as another never ran, and is not a pulse of its own.
    const jobs = (attempt(sources.jobs) ?? []).filter((job) => job.replacedBy === undefined).sort((a, b) => a.sequence - b.sequence);
    const outcome = statusAt(exitCode);
    const projectRoot = options.projectDir;
    return {
      schema_version: REPORT_SCHEMA_VERSION,
      turri: identity,
      command: options.command,
      spec_file: resolve(options.specFile),
      project_dir: projectRoot,
      build_dir: options.buildDir !== undefined ? resolve(options.buildDir) : null,
      conformance_tests: options.conformanceTests,
      review: options.review ?? null,
      mutation_testing: options.mutationTesting ?? null,
      models: {
        ...Object.fromEntries(
          Object.entries(options.models).map(([role, choice]) => [role, { model: choice.model ?? null, thinking: choice.thinking ?? null }]),
        ),
        observed: Object.fromEntries(
          [...new Set(events.map((event) => event.role ?? "unknown"))].sort().map((role) => [role, [...new Set(events.filter((event) => (event.role ?? "unknown") === role).map((event) => event.model ?? "unknown"))].sort()]),
        ),
      },
      started_at: new Date(startedAt).toISOString(),
      finished_at: finishedAt !== undefined ? new Date(finishedAt).toISOString() : null,
      duration_seconds: Math.round((now - startedAt) / 100) / 10,
      outcome: {
        status: outcome.status,
        exit_code: exitCode ?? null,
        signal: outcome.signal,
        error: outcome.error,
        modules: attempt(sources.modules) ?? null,
      },
      usage: usageOf(jobs),
      pulses: pulsesOf(jobs, now),
      functionalities: functionalitiesOf(attempt(sources.completion)),
      spec_gaps: specGapsOf(jobs),
      turn_incidents: turnIncidentsOf(),
      ...(exitParts ?? {}),
      logs: {
        jobs_dir: fromProject(join(projectRoot, ".turri", "jobs")),
        debug_dir: fromProject(join(projectRoot, ".turri", "debug")),
        sessions_dir: fromProject(join(projectRoot, ".turri", "sessions")),
      },
    };
  };

  const write = (exitCode?: number) => {
    try {
      writeAtomically(file, `${JSON.stringify(build(exitCode), null, 2)}\n`);
    } catch (error) {
      console.error(`Could not write the run report ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  if (options.onExit !== false) {
    process.on("uncaughtExceptionMonitor", (error) => {
      crash ??= error instanceof Error ? (error.stack ?? error.message) : String(error);
    });
    process.once("exit", (code) => {
      finishedAt = Date.now();
      exitParts = attempt(sources.atExit);
      stopListening();
      write(code);
    });
  }
  write();

  return {
    attach(given) {
      sources = given;
    },
    end(status, error) {
      ended = { status, ...(error !== undefined ? { error } : {}) };
    },
    crashed(error) {
      crash ??= error instanceof Error ? error.message : String(error);
    },
    write: () => write(),
    build,
  };
}
