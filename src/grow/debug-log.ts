import { appendFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { currentJob, reportActivity, reportTranscript } from "./activity.ts";
import { ensureInScratch, MODULES_DIR, projectRootOf, scratchDir } from "./paths.ts";

/**
 * Every render agent's whole conversation, streamed to a file of its own as it happens - always.
 *
 * `/watch` shows a job's transcript, but clipped - a tool call's arguments to 600 characters, its
 * result to 2000 - and only while pi is running. When an agent goes wrong, what it was actually
 * given and what actually came back is what there is to go on. So each agent a render starts -
 * coding, conformance, repair, the spec-steps planner - writes everything to `.turri/debug/`
 * in the project: the system prompt, every prompt, its replies and thinking as they stream, every
 * tool call with its arguments and its whole result, each response's stop reason and usage, and the
 * provider's retries and errors.
 *
 * Each event is on disk the moment it arrives, so a crashed or killed run leaves its log up to
 * the moment it stopped, and `tail -f` follows an agent live. The folder is in the project, not in
 * `plain_modules`, so no agent can read another's log. A log that cannot be written is given up
 * on, never allowed to fail the render.
 */

/** `.turri/debug` in the project: beside `plain_modules`, never inside it. */
export function debugDir(project: string): string {
  return join(scratchDir(join(project, MODULES_DIR)), "debug");
}

/**
 * Where the log of an agent working in `cwd` goes: always outside what that agent can reach. In
 * `plain_modules`, or in the project that holds it, that is the project's; an explicit build
 * folder elsewhere is its own fence (see `modulesRootOf`), so its logs go beside it, not in it.
 */
export function debugDirFor(cwd: string): string {
  const dir = resolve(cwd);
  if (dir.split(sep).includes(MODULES_DIR)) return debugDir(projectRootOf(dir));
  if (existsSync(join(dir, MODULES_DIR))) return debugDir(dir);
  return join(dirname(dir), ".turri", "debug");
}

/** The part of a pi session a debug log reads. */
export interface DebuggedSession {
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  readonly model?: { provider?: string; id?: string } | undefined;
  readonly thinkingLevel?: string;
  readonly systemPrompt?: string;
  readonly sessionFile?: string | undefined;
}

export interface DebugLog {
  readonly file: string;
  /** A prompt the agent is sent, whole. */
  prompt(text: string): void;
  /** Something the harness has to say about the turn: that it ended, and how. */
  note(line: string): void;
}

const logs = new WeakMap<object, DebugLog>();

/** The debug log a session is streaming to, if it has one. */
export function debugLogOf(session: object): DebugLog | undefined {
  return logs.get(session);
}

/**
 * Start streaming a session to a log of its own. `label` says what the agent is - `app 3 coding
 * agent` - and names the file.
 */
export function startDebugLog(
  session: DebuggedSession,
  options: { cwd: string; label: string; tools?: string[] },
): DebugLog | undefined {
  let file: string;
  try {
    const dir = debugDirFor(options.cwd);
    ensureInScratch(dirname(dir), dir);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = options.label.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "agent";
    file = join(dir, `${stamp}-${name}.log`);
    for (let n = 2; existsSync(file); n += 1) file = join(dir, `${stamp}-${name}-${n}.log`);
    appendFileSync(file, header(session, options), { flag: "wx" });
  } catch (error) {
    reportActivity(`debug log not started: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }

  let broken = false;
  const write = (text: string) => {
    if (broken) return;
    try {
      appendFileSync(file, text);
    } catch (error) {
      // Given up on, not retried: a disk that is full or a folder that went is not going to
      // come back mid-turn, and the render matters more than its log.
      broken = true;
      reportActivity(`debug log stopped: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  let prompts = 0;
  /** Each call's number and start, by its id: calls in one response run at once and end in any order. */
  const toolStarted = new Map<string, { n: number; at: number }>();
  let calls = 0;
  /** How much of the reply or thinking block in progress has streamed. */
  let streamed = 0;

  const record = (event: AgentSessionEvent) => {
    switch (event.type) {
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (update.type === "text_start" || update.type === "thinking_start") {
          streamed = 0;
          write(`\n${stamp()} ${update.type === "text_start" ? "reply" : "thinking"}\n`);
        } else if (update.type === "text_delta" || update.type === "thinking_delta") {
          streamed += update.delta.length;
          write(update.delta);
        } else if (update.type === "text_end" || update.type === "thinking_end") {
          // A block can arrive whole, with no deltas - redacted thinking does: then its end has it.
          write(streamed === 0 && update.content ? `${update.content}\n` : "\n");
        }
        break;
      }
      case "tool_execution_start":
        calls += 1;
        toolStarted.set(event.toolCallId, { n: calls, at: Date.now() });
        write(`\n${stamp()} → #${calls} ${event.toolName}\n${formatArgs(event.args)}`);
        break;
      case "tool_execution_end": {
        const started = toolStarted.get(event.toolCallId);
        toolStarted.delete(event.toolCallId);
        const which = started !== undefined ? `#${started.n} ` : "";
        const took = started !== undefined ? ` · ${duration(Date.now() - started.at)}` : "";
        write(`\n${stamp()} ← ${which}${event.toolName} ${event.isError ? "failed" : "done"}${took}\n${indent(resultText(event.result))}`);
        break;
      }
      case "message_end": {
        const message = event.message as {
          role?: string;
          stopReason?: string;
          errorMessage?: string;
          content?: Array<{ type?: string; name?: string; arguments?: unknown }>;
          usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total: number } };
        };
        if (message.role !== "assistant") break;
        const parts = [`stop: ${message.stopReason ?? "unknown"}`];
        if (message.usage !== undefined) {
          const { input, output, cacheRead, cacheWrite, cost } = message.usage;
          parts.push(`tokens: ${input} in, ${output} out, ${cacheRead} cache read, ${cacheWrite} cache write`);
          if (typeof cost?.total === "number") parts.push(`$${cost.total.toFixed(4)}`);
        }
        write(`\n${stamp()} end of response · ${parts.join(" · ")}\n`);
        if (message.errorMessage !== undefined) write(`${stamp()} error: ${message.errorMessage}\n`);
        // A response cut off runs none of its tool calls, so they never reach the lines above.
        if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length") {
          for (const block of message.content ?? []) {
            if (block.type === "toolCall") write(`${stamp()} (cut off, not run) → ${block.name ?? "a tool"}\n${formatArgs(block.arguments ?? {})}`);
          }
        }
        break;
      }
      case "auto_retry_start":
        write(`\n${stamp()} provider retry ${event.attempt} of ${event.maxAttempts} in ${duration(event.delayMs)}: ${event.errorMessage}\n`);
        break;
      case "auto_retry_end":
        write(`${stamp()} provider retry ${event.success ? "succeeded" : `gave up${event.finalError ? `: ${event.finalError}` : ""}`}\n`);
        break;
      case "compaction_start":
        write(`\n${stamp()} compacting the context (${event.reason})\n`);
        break;
      case "compaction_end":
        write(
          `${stamp()} compaction ${event.aborted ? "aborted" : event.errorMessage ? `failed: ${event.errorMessage}` : "done"}\n`,
        );
        break;
    }
  };

  // pi calls this from inside the agent's turn: nothing in it may throw back into that.
  session.subscribe((event) => {
    try {
      record(event);
    } catch (error) {
      write(`\n${stamp()} (an event could not be logged: ${error instanceof Error ? error.message : String(error)})\n`);
    }
  });

  const log: DebugLog = {
    file,
    prompt(text) {
      prompts += 1;
      write(`\n\n${"=".repeat(24)} prompt ${prompts} · ${stamp()} ${"=".repeat(24)}\n${text}\n`);
    },
    note(line) {
      write(`\n${stamp()} ${line}\n`);
    },
  };
  logs.set(session, log);

  const shown = relative(projectRootOf(options.cwd), file);
  reportActivity(`debug log: ${shown}`);
  reportTranscript({ kind: "stage", text: `debug log: ${file}` });
  return log;
}

function header(session: DebuggedSession, options: { cwd: string; label: string; tools?: string[] }): string {
  const job = currentJob();
  const model = session.model?.id !== undefined ? `${session.model.provider ?? "?"}/${session.model.id}` : "pi's default";
  const lines = [
    `turri debug log · ${options.label}`,
    `started   ${new Date().toISOString()}`,
    `job       ${job !== undefined ? `${job.id} · ${job.kind} · ${job.summary}` : "none - run from the command line, or waited on"}`,
    `model     ${model}${session.thinkingLevel !== undefined ? ` · thinking ${session.thinkingLevel}` : ""}`,
    `cwd       ${options.cwd}`,
    `session   ${session.sessionFile ?? "not saved"}`,
    ...(options.tools !== undefined ? [`tools     ${options.tools.join(", ")}`] : []),
  ];
  const system = session.systemPrompt;
  return `${lines.join("\n")}\n${system ? `\n${"=".repeat(24)} system prompt ${"=".repeat(24)}\n${system}\n` : ""}`;
}

/** Local time of day to the millisecond: when each thing happened, and how long between them. */
function stamp(): string {
  const now = new Date();
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `[${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}]`;
}

function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/** Every line indented, so a tool's output stands apart from the lines around it. */
function indent(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 10) end -= 1;
  if (end === 0) return "";
  return `${text.slice(0, end).split("\n").map((line) => `    ${line}`).join("\n")}\n`;
}

/** A tool call's arguments, one per line, whole: a file's content is shown as the file, not as JSON. */
function formatArgs(args: unknown): string {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return indent(JSON.stringify(args) ?? "");
  return Object.entries(args as Record<string, unknown>)
    .map(([key, value]) =>
      typeof value === "string" && value.includes("\n")
        ? `  ${key}:\n${indent(value)}`
        : `  ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}\n`,
    )
    .join("");
}

/** A tool result's text, whole; anything else in it is named rather than dropped silently. */
function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  if (!Array.isArray(content)) return result === undefined ? "" : (JSON.stringify(result) ?? "");
  return content.map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : `[${part.type ?? "unknown"} content]`)).join("\n");
}
