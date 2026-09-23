import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { loadRules, renderRulesBlock } from "./rules.ts";
import { projectRootOf, sessionsDir } from "./render/paths.ts";
import {
  currentStopSignal,
  describeToolCall,
  describeToolResult,
  JobStoppedError,
  reportActivity,
  reportNow,
  reportTranscript,
  reportUsage,
} from "./render/activity.ts";

type ThinkingLevel = Parameters<AgentSession["setThinkingLevel"]>[0];

let thinkingSource: (() => ThinkingLevel | undefined) | undefined;

/**
 * Where sub-agents take their thinking level from: the conversation that started them.
 *
 * The model is inherited explicitly, by name, all the way down. The thinking level is just
 * as much a choice the person made - and left alone pi falls back to its own default, so a
 * conversation turned down for speed would hand every render agent a slower one. Read at
 * the moment each session starts, so a change mid-conversation applies to the next agent.
 */
export function inheritThinkingLevel(source: () => ThinkingLevel | undefined): void {
  thinkingSource = source;
}

function inheritedThinkingLevel(): ThinkingLevel | undefined {
  try {
    return thinkingSource?.();
  } catch {
    // The conversation it came from is gone - a reload, a resumed session. pi's default is
    // a worse guess than the conversation's level, but a far better one than a failed build.
    return undefined;
  }
}

const RULES_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), "forge", "rules");

/**
 * What a sub-agent session is made of: pi's resources without any extensions.
 *
 * Left to itself, pi builds every session from the user's configuration - including every
 * installed extension. When plainwright is installed globally, that means each render agent,
 * judge and skill executor loads a whole second copy of plainwright inside itself: its
 * tools, its hooks, its job registry, all bound to a session that is thrown away minutes
 * later. That copy then outlives its session in module state and breaks the next one. A
 * sub-agent is given exactly what it needs instead; for agents that work on specs, that
 * includes the ***plain rules, which otherwise only reached them through that stray copy.
 */
async function subAgentResources(cwd: string, withRules: boolean): Promise<DefaultResourceLoader> {
  const rules = withRules ? renderRulesBlock(loadRules(RULES_DIR)) : "";
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    appendSystemPrompt: rules !== "" ? [rules] : undefined,
  });
  await loader.reload();
  return loader;
}

function seconds(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const CALL_PROGRESS_MS = 500;

/** How much of a tool call's arguments and result the transcript keeps: enough to follow, not the whole file. */
const MAX_TOOL_ARGS = 600;
const MAX_TOOL_RESULT = 2000;

function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more characters]`;
}

function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** Raised when the provider itself failed, rather than the agent producing a poor answer. */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * Run one turn and return the assistant's text, streaming deltas to `onDelta`.
 *
 * A provider failure - no credits, rate limit, bad key - arrives as an assistant message
 * with `stopReason: "error"` and no content. Left alone that looks exactly like an agent
 * that chose to say nothing, and any retry loop above will keep going as if the work were
 * merely unfinished. It is raised instead.
 */
export async function ask(
  session: AgentSession,
  text: string,
  onDelta?: (delta: string) => void,
): Promise<string> {
  let out = "";
  let providerError: string | undefined;

  // Inside a background job, what the agent is doing is what the person watches - and most
  // of the time that is the model, not a tool. A write takes a millisecond; producing the
  // file it writes takes as long as the model needs to type it out. So the time from the
  // model starting a step to the tool running is shown against the tool, and while it is
  // happening the panel says which part it is at.
  let stepStarted = Date.now();
  let callChars = 0;
  let lastCallReport = 0;
  reportNow("waiting for the model");
  reportTranscript({ kind: "prompt", text });

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        out += update.delta;
        onDelta?.(update.delta);
        reportTranscript({ kind: "text", text: update.delta });
      } else if (update.type === "thinking_delta") {
        reportTranscript({ kind: "thinking", text: update.delta });
      } else if (update.type === "thinking_start") {
        reportNow("thinking");
      } else if (update.type === "text_start") {
        reportNow("writing");
      } else if (update.type === "toolcall_start") {
        callChars = 0;
        reportNow("preparing a tool call");
      } else if (update.type === "toolcall_delta") {
        callChars += update.delta.length;
        const now = Date.now();
        if (now - lastCallReport >= CALL_PROGRESS_MS) {
          lastCallReport = now;
          const block = update.partial.content[update.contentIndex] as { name?: string } | undefined;
          const size = callChars >= 1000 ? `${(callChars / 1000).toFixed(1)}k` : `${callChars}`;
          reportNow(`writing ${block?.name ?? "a tool"} call · ${size} chars`, { keepSince: true });
        }
      }
    }
    if (event.type === "tool_execution_start") {
      reportTranscript({ kind: "tool", text: `${event.toolName} ${clipText(JSON.stringify(event.args ?? {}), MAX_TOOL_ARGS)}` });
      const took = Date.now() - stepStarted;
      const line = describeToolCall(event.toolName, event.args);
      reportActivity(took >= 1000 ? `${line}   (model ${seconds(took)})` : line);
      reportNow(`running ${event.toolName}`);
    }
    if (event.type === "tool_execution_end") {
      reportTranscript({ kind: "result", text: clipText(resultText(event.result), MAX_TOOL_RESULT), error: event.isError });
      const line = describeToolResult(event.toolName, event.result, event.isError);
      if (line !== undefined) reportActivity(line);
      stepStarted = Date.now();
      reportNow("waiting for the model");
    }
    if (event.type === "message_end") {
      const message = event.message as {
        role?: string;
        stopReason?: string;
        errorMessage?: string;
        usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total: number } };
      };
      if (message.role === "assistant" && message.usage !== undefined) {
        const { input, output, cacheRead, cacheWrite, cost } = message.usage;
        reportUsage({ input, output, cacheRead, cacheWrite, cost: cost?.total ?? 0 });
      }
      if (message.role === "assistant" && message.stopReason === "error") {
        providerError = message.errorMessage ?? "the provider returned an error";
      }
    }
  });

  // A job asked to stop: abort the turn in progress, and do not start another. Every
  // agent a job runs goes through here, so this is where a stop reaches all of them.
  const stop = currentStopSignal();
  if (stop?.aborted) {
    unsubscribe();
    reportNow(undefined);
    throw new JobStoppedError();
  }
  const onStop = () => void session.abort();
  stop?.addEventListener("abort", onStop, { once: true });

  try {
    await session.prompt(text, { expandPromptTemplates: false });
  } finally {
    unsubscribe();
    stop?.removeEventListener("abort", onStop);
    reportNow(undefined);
  }

  if (stop?.aborted) throw new JobStoppedError();

  if (providerError !== undefined) {
    throw new ProviderError(`${session.model?.id ?? "model"}: ${providerError}`);
  }

  return out.trim();
}

/**
 * The executor. One session for the whole skill run, so a retry after a failed
 * gate arrives as a follow-up turn with the critique in it rather than as a cold
 * start that has forgotten what it just wrote.
 */
export async function createExecutor(opts: {
  cwd: string;
  customTools: ToolDefinition[];
  tools: string[];
  /** "provider/model-id". Omitted: whatever pi is configured to use. */
  model?: string;
  /** Give it the ***plain rules - for agents that write or edit specs, not code. */
  rules?: boolean;
  /** Continue the session saved in this file, instead of starting a new one. */
  resumeFrom?: string;
}): Promise<AgentSession> {
  // Saved to disk, in the project: an agent's session is the record of what it did, and the
  // only way to pick a long run back up after the process that ran it is gone.
  const sessionManager =
    opts.resumeFrom !== undefined
      ? SessionManager.open(opts.resumeFrom)
      : SessionManager.create(opts.cwd, sessionsDir(projectRootOf(opts.cwd)));
  const { session } = await createAgentSession({
    cwd: opts.cwd,
    tools: opts.tools,
    customTools: opts.customTools,
    sessionManager,
    resourceLoader: await subAgentResources(opts.cwd, opts.rules === true),
  });

  if (opts.model !== undefined) {
    const model = findModel(session, opts.model);
    if (model === undefined) {
      throw new Error(`Model '${opts.model}' is not configured. Check the provider's API key.`);
    }
    await session.setModel(model);
  }

  // After the model: switching models picks a thinking level of its own.
  const thinking = inheritedThinkingLevel();
  if (thinking !== undefined) session.setThinkingLevel(thinking);

  return session;
}

function findModel(session: AgentSession, spec: string) {
  const slash = spec.indexOf("/");
  if (slash === -1) throw new Error(`Model must be "provider/model-id", got "${spec}"`);
  return new ModelRegistry(session.modelRuntime).find(spec.slice(0, slash), spec.slice(slash + 1));
}

/**
 * A judge. Fresh session, one tool, and - deliberately - no access to the
 * executor's transcript. A judge that inherits the actor's reasoning inherits
 * its rationalisations, so it gets the artifact and the rubric, nothing else.
 */
export async function createJudge(opts: {
  cwd: string;
  verdictTool: ToolDefinition;
  modelSpec?: string;
  borrowAuthFrom: AgentSession;
  /** Read-only tools the rubric needs. Empty keeps the judge unable to touch anything. */
  extraTools?: string[];
}): Promise<{ session: AgentSession; modelNote: string }> {
  const modelRuntime = opts.borrowAuthFrom.modelRuntime;
  let model;
  let modelNote = "executor model";

  if (opts.modelSpec) {
    const slash = opts.modelSpec.indexOf("/");
    if (slash === -1) throw new Error(`gate model must be "provider/model-id", got "${opts.modelSpec}"`);
    const provider = opts.modelSpec.slice(0, slash);
    const modelId = opts.modelSpec.slice(slash + 1);
    const found = new ModelRegistry(modelRuntime).find(provider, modelId);
    if (found) {
      model = found;
      modelNote = opts.modelSpec;
    } else {
      modelNote = `executor model (${opts.modelSpec} not configured)`;
    }
  }

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    model,
    modelRuntime,
    tools: [...(opts.extraTools ?? []), "submit_verdict"],
    customTools: [opts.verdictTool],
    sessionManager: SessionManager.inMemory(opts.cwd),
    // Judges assess specs against the rules, so they have them too.
    resourceLoader: await subAgentResources(opts.cwd, true),
  });
  return { session, modelNote };
}
