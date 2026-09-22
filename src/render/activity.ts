import { AsyncLocalStorage } from "node:async_hooks";
import { basename } from "node:path";

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

/** A tool call as one short line. Unknown tools still show up, by name. */
export function describeToolCall(name: string, args: Record<string, unknown> | undefined): string {
  const path = typeof args?.path === "string" ? args.path : undefined;
  const command = typeof args?.command === "string" ? args.command : undefined;
  const pattern = typeof args?.pattern === "string" ? args.pattern : undefined;

  switch (name) {
    case "write":
      return `✎ write ${path ?? ""}`.trimEnd();
    case "edit":
      return `✎ edit ${path ?? ""}`.trimEnd();
    case "read":
      return `  read ${path ? basename(path) : ""}`.trimEnd();
    case "ls":
    case "find":
    case "grep":
      return `  ${name} ${clip(pattern ?? path ?? "")}`.trimEnd();
    case "bash":
      return `$ ${clip(command ?? "")}`;
    case "run_unit_tests":
    case "run_conformance_tests":
      return `▶ ${name === "run_unit_tests" ? "unit tests" : "conformance tests"}: ${clip(command ?? "")}`;
    case "describe_how_to_try_it":
      return "  wrote the try-it steps";
    case "submit_triage":
      return `  triage: ${typeof args?.fault === "string" ? args.fault.replace(/_/g, " ") : "submitted"}`;
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
