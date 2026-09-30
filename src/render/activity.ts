import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What a background job is doing right now.
 *
 * A render is minutes of agents working with nothing on screen. The work is several layers
 * deep - a chain, a module, a functionality, an agent session, its tool calls - and
 * threading a callback through all of them would touch every signature on the way. Instead
 * each job runs inside its own async context, and anything underneath it reports into
 * whichever job it is running for: the render steps say which stage they are at, and every
 * agent session reports its tool calls. Outside a job, reporting is a no-op.
 */

export interface ActivitySink {
  /** Which stage of the work this is, e.g. "writing code and unit tests". */
  stage(label: string): void;
  /** One thing that just happened, e.g. "✎ write greeter.py". */
  activity(line: string): void;
  /**
   * What is happening at this moment, e.g. "thinking", or undefined when nothing is.
   * `keepSince` updates the words without restarting the clock on it.
   */
  now(label: string | undefined, options?: { keepSince?: boolean }): void;
  /** What one model response cost. */
  usage(usage: UsageReport): void;
  /** One piece of the full conversation, for reading it back while it happens. */
  transcript(entry: TranscriptEntry): void;
  /** Aborted when the job is asked to stop. */
  signal?: AbortSignal;
  /** Which job this is, for what records it - a debug log's header. */
  job?: { id: string; kind: string; summary: string };
  /** The spec was found to contradict itself - for the person to decide. */
  specConflict?(conflict: SpecConflict): void;
  /** The functional spec being built now, or nothing when none is. */
  spec?(spec: BuildingSpec | undefined): void;
}

/** A functional spec as it is being built: where it sits, and its text as the spec has it. */
export interface BuildingSpec {
  /** E.g. "rt_tuples functionality 2 of 5". */
  label: string;
  text: string;
  /**
   * When work on it began - set by the job, and kept while the same one goes on to its next stage
   * (its conformance tests, the whole suite), so its time is the whole of it.
   */
  since?: number;
}

/** Say which functional spec is being built now - shown with the job, and in its transcript. */
export function reportSpec(spec: BuildingSpec | undefined): void {
  store.getStore()?.spec?.(spec);
}

/**
 * Two functional specs that cannot both hold, as a conformance run's judge found them - the times
 * it takes to count. Nothing in the code or the tests can fix it: the person decides which is meant.
 */
export interface SpecConflict {
  /** The module whose conformance run found it, and its .plain file. */
  moduleName: string;
  plainFile: string;
  /**
   * The two functionalities - in that module, or in one it requires - each with its module, its
   * id there, the .plain file it is in, and its functional spec as that file has it.
   */
  specs: Array<{ module: string; frid: string; plainFile: string; text: string }>;
  /** What the judge said each time it raised it, oldest first. */
  reasons: string[];
}

/** Say the spec contradicts itself, to the job this runs for. */
export function reportSpecConflict(conflict: SpecConflict): void {
  store.getStore()?.specConflict?.(conflict);
}

/** Raised inside a job that was asked to stop, so the work unwinds instead of carrying on. */
export class JobStoppedError extends Error {
  constructor() {
    super("Stopped on request.");
    this.name = "JobStoppedError";
  }
}

/** The stop signal of the job this code is running for, if it is running for one. */
export function currentStopSignal(): AbortSignal | undefined {
  return store.getStore()?.signal;
}

/** The job this code is running for, if it is running for one. */
export function currentJob(): { id: string; kind: string; summary: string } | undefined {
  return store.getStore()?.job;
}

/**
 * The conversation an agent is having, as it happens: what it was asked, what it wrote and
 * thought, what it called and what came back. Text and thinking arrive as deltas and are
 * joined to the entry before them of the same kind.
 */
export interface TranscriptEntry {
  /** `diff`: a spec change the job is about to render, as a git diff. */
  kind: "stage" | "spec" | "diff" | "prompt" | "text" | "thinking" | "tool" | "result";
  text: string;
  /** For a result: whether the tool failed. */
  error?: boolean;
  /** The whole of it, where `text` is clipped for the screen - a tool call's arguments, its result. */
  full?: string;
  /** Which agent it is from, e.g. "app 1 judge", and what it runs on - for a prompt, a reply, a thought, a tool call, a result. */
  agent?: { label: string; model?: string };
}

export function reportTranscript(entry: TranscriptEntry): void {
  store.getStore()?.transcript(entry);
}

/** The part of a model response's usage a job adds up. */
export interface UsageReport {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/**
 * What a stage is about, said so the person knows what the name is: "module backend", or "module
 * backend, functionality 2". A stage leads with it: `${unitOf(moduleName, frid)}: running the tests`.
 */
export function unitOf(moduleName: string, frid?: string): string {
  return frid === undefined ? `module ${moduleName}` : `module ${moduleName}, functionality ${frid}`;
}

export function reportUsage(usage: UsageReport): void {
  store.getStore()?.usage(usage);
}

/** "1.2k tok · $0.03", or "" when nothing has been spent yet. */
export function describeUsage(usage: UsageReport | undefined): string {
  if (usage === undefined) return "";
  const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  if (tokens === 0) return "";
  const size = tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
  return usage.cost > 0 ? `${size} tok · $${usage.cost.toFixed(2)}` : `${size} tok`;
}

const store = new AsyncLocalStorage<ActivitySink>();

export function withActivity<T>(sink: ActivitySink, run: () => Promise<T>): Promise<T> {
  return store.run(sink, run);
}

export function reportStage(label: string): void {
  store.getStore()?.stage(label);
}

export function reportActivity(line: string): void {
  store.getStore()?.activity(line);
}

export function reportNow(label: string | undefined, options?: { keepSince?: boolean }): void {
  store.getStore()?.now(label, options);
}

const MAX_ARG = 60;

function clip(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > MAX_ARG ? `${one.slice(0, MAX_ARG - 1)}…` : one;
}

/**
 * Paths as they are inside `plain_modules`: everything up to and including it left out, wherever
 * a path to it appears - `/Users/…/project/plain_modules/app/code/main.py` is `app/code/main.py`.
 * The rest of the path is the same for every line, and is what pushes the part that differs off
 * the end of it.
 */
export function withinModules(text: string): string {
  return text.replace(/(?:(?:\/|~\/)(?:[^\s'"`/]+\/)*|(?<![\w.-]))plain_modules\//g, "");
}

/** A tool call as one short line. Unknown tools still show up, by name. */
export function describeToolCall(name: string, args: Record<string, unknown> | undefined): string {
  const text = (key: string) => (typeof args?.[key] === "string" ? withinModules(args[key] as string) : undefined);
  const path = text("path");
  const command = text("command");
  const pattern = text("pattern");

  switch (name) {
    case "write":
      return `✎ write ${path ?? ""}`.trimEnd();
    case "edit":
      return `✎ edit ${path ?? ""}`.trimEnd();
    case "read":
      return `  read ${path ?? ""}`.trimEnd();
    case "ls":
    case "find":
    case "grep":
      return `  ${name} ${clip(pattern ?? path ?? "")}`.trimEnd();
    case "bash":
      return `$ ${clip(command ?? "")}`;
    case "run_unit_tests":
    case "run_conformance_tests":
      return `▶ ${name === "run_unit_tests" ? "unit tests" : "conformance tests"}: the project's script`;
    default:
      return `  ${name}`;
  }
}

/** The outcome of a test run, or nothing for tools whose outcome is not worth a line. */
export function describeToolResult(name: string, result: unknown, isError: boolean): string | undefined {
  if (name !== "run_unit_tests" && name !== "run_conformance_tests") {
    return isError ? `  ✗ ${name} failed` : undefined;
  }
  const exitCode = (result as { details?: { exitCode?: unknown } } | undefined)?.details?.exitCode;
  if (typeof exitCode !== "number") return undefined;
  return exitCode === 0 ? "  ✓ passing" : `  ✗ failing (exit ${exitCode})`;
}
