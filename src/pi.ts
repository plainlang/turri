import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { loadRules, renderRulesBlock } from "./rules.ts";
import { configModuleOfBuild, inheritModel, readProjectConfig, ROLE_THINKING, roleModel, roleTurnLimitMs, splitModelSpec, type AgentRole, type ProjectConfig } from "./config.ts";
import { maskToolResults } from "./grow/masking.ts";
import { checkAgainstScript, ENVIRONMENT_ERROR_TOOL, EnvironmentError, environmentErrorTool, sandboxGapOf } from "./grow/environment-error.ts";
import { MODULES_DIR, projectRootOf, sessionsDir } from "./grow/paths.ts";
import {
  currentStopSignal,
  describeToolCall,
  describeToolResult,
  JobStoppedError,
  shownName,
  reportActivity,
  reportNow,
  reportAgent,
  reportTranscript,
  reportUsage,
} from "./grow/activity.ts";
import { debugLogOf, startDebugLog } from "./grow/debug-log.ts";

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

/**
 * How hard an agent thinks: the level the config or the model it is given names; else its role's (ROLE_THINKING) - the
 * work thinks little, the judgement more; else the conversation's, for an agent with no role.
 */
export function agentThinking(named: ThinkingLevel | undefined, role: AgentRole | undefined, conversation: () => ThinkingLevel | undefined): ThinkingLevel | undefined {
  return named ?? (role !== undefined ? ROLE_THINKING[role] : undefined) ?? conversation();
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

let providerSource: (() => ModelRegistry | undefined) | undefined;

/**
 * Where sub-agents take the providers pi's extensions registered from: the conversation that started them.
 *
 * A sub-agent is started without extensions (see subAgentResources), so its models are only what pi's own
 * configuration has - models.json and auth.json. A provider an extension registers - a company's own LLM
 * gateway, say - is in the conversation's model registry and nowhere else: the conversation could use its
 * models and a render or skill agent told to use them could not find them. So every sub-agent's model
 * runtime is given the providers the conversation's registry holds when the agent starts - the provider,
 * not the extension that registered it.
 */
export function inheritProviders(source: () => ModelRegistry | undefined): void {
  providerSource = source;
}

/** A model runtime for a sub-agent: pi's configuration, with the providers the conversation's extensions registered. */
async function subAgentModelRuntime(): Promise<ModelRuntime> {
  const agentDir = getAgentDir();
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  let source: ModelRegistry | undefined;
  try {
    source = providerSource?.();
  } catch {
    // The conversation it came from is gone: pi's own configuration is what there is.
  }
  if (source === undefined) return runtime;
  const registry = new ModelRegistry(runtime);
  for (const id of source.getRegisteredProviderIds()) {
    const native = source.getRegisteredNativeProvider(id);
    const config = source.getRegisteredProviderConfig(id);
    try {
      if (native !== undefined) registry.registerProvider(native);
      else if (config !== undefined) registry.registerProvider(id, config);
    } catch {
      // One provider that will not register leaves the others, and pi's own, usable.
    }
  }
  // Its models are listed as the registrations land; the agent's model is looked up right after.
  await runtime.refresh({ allowNetwork: false });
  return runtime;
}

const RULES_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), "genome", "rules");

/**
 * What a sub-agent session is made of: pi's resources without any extensions.
 *
 * Left to itself, pi builds every session from the user's configuration - including every
 * installed extension. When turri is installed globally, that means each render agent,
 * judge and skill executor loads a whole second copy of turri inside itself: its
 * tools, its hooks, its job registry, all bound to a session that is thrown away minutes
 * later. That copy then outlives its session in module state and breaks the next one. A
 * sub-agent is given exactly what it needs instead; for agents that work on specs, that
 * includes the ***plain rules, which otherwise only reached them through that stray copy.
 *
 * Nor any context file. pi puts every AGENTS.md / CLAUDE.md from the agent's folder up - the
 * project's, the user's ~/.pi/agent one - into its system prompt; a rendering agent works in
 * plain_modules/<module>/code, so it would be given whatever the project says about itself. An
 * agent turri starts sees only what turri gives it. The conversation still loads
 * them, as pi does.
 *
 * Nor any of pi's skills. pi lists every skill it finds - the user's, the project's - in the system prompt, for the
 * agent to load when one fits; an agent turri starts has one job, and turri runs its gated skills itself,
 * giving each step to an agent as its task. The conversation keeps them.
 */
export async function subAgentResources(cwd: string, withRules: boolean, system?: string): Promise<DefaultResourceLoader> {
  // Less any the project leaves out (rules-off).
  const rules = withRules ? renderRulesBlock(loadRules(RULES_DIR, readProjectConfig(projectRootOf(cwd)).rulesOff ?? [])) : "";
  const extra = [rules, system ?? ""].filter((part) => part !== "");
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noContextFiles: true,
    noSkills: true,
    appendSystemPrompt: extra.length > 0 ? extra : undefined,
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
/** For each agent with a shell: where it works, and what it reported the environment lacks, if it did. */
const environmentReports = new WeakMap<AgentSession, { cwd: string; reported: { report?: { missing: string; neededBy: string; shownBy?: string } } }>();

/** The agent's turn ended on report_environment_error: the pulse stops with what it said, as it said it. */
function throwIfEnvironmentReported(session: AgentSession): void {
  const entry = environmentReports.get(session);
  const report = entry?.reported.report;
  if (entry === undefined || report === undefined) return;
  entry.reported.report = undefined;
  const parts = resolve(entry.cwd).split(sep);
  const index = parts.lastIndexOf(MODULES_DIR);
  const moduleName = index >= 0 && parts.length > index + 1 ? parts[index + 1]! : basename(resolve(entry.cwd));
  // A file it names that is on this machine: not missing - turri's sandbox hid it, and the fix is a line of config.
  const sandbox = sandboxGapOf([report.missing, report.neededBy, report.shownBy ?? ""].join("\n"), { project: projectRootOf(entry.cwd) });
  throw new EnvironmentError({ moduleName, missing: report.missing, neededBy: report.neededBy, ...(report.shownBy !== undefined ? { shownBy: report.shownBy } : {}), source: "agent", ...(sandbox !== undefined ? { sandbox } : {}) });
}

/** A turn with one thing left to do: every tool but these is refused, the tools the session has left as they are. */
export interface TurnOptions {
  onlyTools?: string[];
}

/** The tools a session's turn may use, while one is restricted (ask's `onlyTools`). */
const turnTools = new WeakMap<AgentSession, Set<string>>();

/** How many calls a restricted turn may have refused before it is stopped. */
export const REFUSED_BEFORE_STOP = 3;

/**
 * `run`, with every tool of the session but `names` refused (guardRepeats refuses them) until it ends. The tools
 * themselves are left as they are, so the tools the model is sent - and its prompt cache - stay the same.
 */
export async function withOnlyTools<T>(session: AgentSession, names: string[], run: () => Promise<T>): Promise<T> {
  turnTools.set(session, new Set(names));
  try {
    return await run();
  } finally {
    turnTools.delete(session);
  }
}

export async function ask(session: AgentSession, text: string, onDelta?: (delta: string) => void, turn?: TurnOptions): Promise<string> {
  if (turn?.onlyTools === undefined) return askUnrestricted(session, text, onDelta);
  return withOnlyTools(session, turn.onlyTools, () => askUnrestricted(session, text, onDelta));
}

async function askUnrestricted(session: AgentSession, text: string, onDelta?: (delta: string) => void): Promise<string> {
  // Between turns, not during one: the work so far, summed up, once it has grown past the threshold.
  // The summary keeps no images: they go with the next message again.
  if (await compactIfDue(session)) {
    const images = sessionImages.get(session);
    if (images !== undefined) images.sent = false;
  }
  // A provider that is overloaded or unreachable for a moment is waited out, longer than pi's own
  // retries do, rather than failing the whole run; the agent carries on where it was.
  let prompt = text;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const reply = await askOnce(session, prompt, onDelta);
      throwIfEnvironmentReported(session);
      return reply;
    } catch (error) {
      if (!(error instanceof ProviderError) || !TRANSIENT_PROVIDER_ERROR.test(error.message) || attempt >= PROVIDER_RETRIES) throw error;
      const wait = PROVIDER_RETRY_DELAY_MS * 2 ** attempt;
      reportActivity(`  the model provider is failing for now - trying again in ${Math.round(wait / 1000)}s (${attempt + 1} of ${PROVIDER_RETRIES})`);
      debugLogOf(session)?.note(`provider failing - trying again in ${Math.round(wait / 1000)}s: ${error.message.slice(0, 200)}`);
      await waitOrStop(wait);
      prompt = "Carry on where you were: the model provider failed part-way through your last turn.";
    }
  }
}

/** How many times, after pi's own retries, a turn whose provider failed for a moment is tried again - and the first wait, doubled each time. */
export const PROVIDER_RETRIES = 3;
export const PROVIDER_RETRY_DELAY_MS = Number(process.env.TURRI_PROVIDER_RETRY_DELAY ?? 15) * 1000;

/** A provider error that passes: overloaded, rate limited, unreachable, timed out. */
const TRANSIENT_PROVIDER_ERROR =
  /\b(429|500|502|503|504|529)\b|overloaded|high demand|rate.?limit|too many requests|unavailable|fetch failed|network|connection|timed? ?out|ECONNRESET|socket|terminated/i;

/** Wait, unless the job is stopped first. */
async function waitOrStop(ms: number): Promise<void> {
  const stop = currentStopSignal();
  if (stop?.aborted) throw new JobStoppedError();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    stop?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });
  if (stop?.aborted) throw new JobStoppedError();
}

async function askOnce(session: AgentSession, text: string, onDelta?: (delta: string) => void): Promise<string> {
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
  // Calls to one tool failing one after another - arguments it refuses, or errors - with nothing going through.
  let failing = 0;
  let failingTool: string | undefined;
  let stoppedFailing = false;
  reportNow("waiting for the model");
  // Every entry says which agent it is from, and what it runs on - for reading one agent at a time.
  const agent = agentOf(session);
  const transcript = (entry: Parameters<typeof reportTranscript>[0]) => reportTranscript(agent !== undefined ? { ...entry, agent } : entry);
  // Its task is in its instructions, not in the conversation: the first turn shows it, for reading back.
  const task = pendingTask.get(session);
  pendingTask.delete(session);
  transcript({ kind: "prompt", text: task !== undefined ? `${task}\n\n${text}` : text });
  if (agent !== undefined) reportAgent({ label: agent.label, ...(agent.model !== undefined ? { model: agent.model } : {}), turns: 1 });

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        out += update.delta;
        onDelta?.(update.delta);
        transcript({ kind: "text", text: update.delta });
      } else if (update.type === "thinking_delta") {
        transcript({ kind: "thinking", text: update.delta });
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
          reportNow(`writing ${block?.name !== undefined ? shownName(block.name) : "a tool"} call · ${size} chars`, { keepSince: true });
        }
      }
    }
    if (event.type === "tool_execution_start") {
      const args = JSON.stringify(event.args ?? {});
      transcript({ kind: "tool", text: `${shownName(event.toolName)} ${clipText(args, MAX_TOOL_ARGS)}`, full: `${shownName(event.toolName)} ${args}` });
      const took = Date.now() - stepStarted;
      // Which agent made the call, by its role: several work in one pulse.
      const role = agentRoles.get(session);
      const line = `${role !== undefined ? `(${role}) ` : ""}${describeToolCall(event.toolName, event.args)}`;
      reportActivity(took >= 1000 ? `${line}   (model ${seconds(took)})` : line);
      reportNow(`running ${shownName(event.toolName)}`);
    }
    if (event.type === "tool_execution_end") {
      failing = event.isError ? (event.toolName === failingTool ? failing + 1 : 1) : 0;
      failingTool = event.isError ? event.toolName : undefined;
      if (failing >= FAILURES_BEFORE_STOP && !stoppedFailing) {
        // A call its tool refuses never reaches the tool, so no guard on the tools sees it: an agent can
        // make the same bad call, worded a little differently, thousands of times. Its turn ends here, and
        // the harness goes on from there, as after any turn.
        stoppedFailing = true;
        reportActivity(`  stopped the agent's turn: ${failing} ${shownName(event.toolName)} calls failed in a row`);
        debugLogOf(session)?.note(`turn stopped: ${failing} ${event.toolName} calls failed in a row`);
        void session.abort();
      }
      const output = resultText(event.result);
      transcript({ kind: "result", text: clipText(output, MAX_TOOL_RESULT), error: event.isError, full: output });
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
        const spent = { input, output, cacheRead, cacheWrite, cost: cost?.total ?? 0 };
        reportUsage(spent);
        if (agent !== undefined) reportAgent({ label: agent.label, usage: spent });
      }
      // A provider error counts only if the turn ends on it: a later message that ends well - pi's own retry, the
      // stream picked up again - means it recovered, and the turn's work stands.
      if (message.role === "assistant" && message.stopReason === "error") {
        providerError = message.errorMessage ?? "the provider returned an error";
      } else if (message.role === "assistant") {
        providerError = undefined;
      }
    }
    if (event.type === "auto_retry_end" && event.success) providerError = undefined;
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

  // For the agent's log: the whole prompt and how the turn ended; the session streams the rest.
  const debug = debugLogOf(session);
  const turnStarted = Date.now();
  // A timed turn is ended when the time is up. The agent is not told: a turn cut short is taken up again by the
  // harness, and a clock in the prompt only hurries the work. It ends at the next request to the model, not in the
  // middle of one: a request aborted in flight is billed whole and uncached, and its answer thrown away. What is running
  // then - the model answering, a tool - finishes; past the grace on top of the limit, it is ended where it is.
  const limitMs = timedSessions.get(session) ?? 0;
  const timed = limitMs > 0;
  let outOfTime = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let backstop: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const endTurn = (how: string) => {
    if (stopped) return;
    stopped = true;
    reportActivity(`  stopped the agent's turn: its ${formatLimit(limitMs)} are up`);
    debug?.note(`turn stopped: its ${formatLimit(limitMs)} are up${how}`);
    void session.abort();
  };
  const atNextRequest = timed
    ? session.subscribe((event) => {
        if (outOfTime && (event as { type?: string }).type === "turn_start") endTurn("");
      })
    : undefined;
  if (timed) {
    timer = setTimeout(() => {
      outOfTime = true;
      backstop = setTimeout(() => endTurn(" - and the grace after it: ended where it was"), TURN_GRACE_MS);
    }, limitMs);
  }
  // What the model is sent, and only that: its task is its system prompt, which the log already holds whole.
  debug?.prompt(text);

  try {
    // Its images, when its conversation does not hold them: the first turn, and the first after a compaction.
    const images = sessionImages.get(session);
    const attach = images !== undefined && !images.sent ? images.images : undefined;
    // The log holds what the model is sent as text; an image is not text, so the log says it went too.
    if (attach !== undefined) debug?.note(`sent with this message: ${attach.length === 1 ? "1 image" : `${attach.length} images`} (${attach.map((image) => image.mimeType).join(", ")})`);
    await session.prompt(text, { expandPromptTemplates: false, ...(attach !== undefined ? { images: attach } : {}) });
    if (images !== undefined) images.sent = true;
  } catch (error) {
    debug?.note(`turn failed after ${seconds(Date.now() - turnStarted)}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (backstop !== undefined) clearTimeout(backstop);
    atNextRequest?.();
    unsubscribe();
    stop?.removeEventListener("abort", onStop);
    reportNow(undefined);
  }
  if (stopped) out = `${out.trim()}\n\n[the turn was stopped: its ${formatLimit(limitMs)} were up]`.trim();

  if (stop?.aborted) {
    debug?.note(`turn stopped on request after ${seconds(Date.now() - turnStarted)}`);
    throw new JobStoppedError();
  }

  // A turn ended for its time is ended, whatever the provider was doing then.
  if (providerError !== undefined && !stopped) {
    debug?.note(`turn ended with a provider error after ${seconds(Date.now() - turnStarted)}: ${providerError}`);
    throw new ProviderError(`${session.model?.id ?? "model"}: ${providerError}`);
  }

  debug?.note(`turn finished after ${seconds(Date.now() - turnStarted)}`);
  return out.trim();
}

/**
 * How long one turn of an agent a render starts may take: past it, the turn ends where it is and
 * the harness goes on as after any turn - it runs the tests, and judges. TURRI_TURN_LIMIT sets
 * it, in seconds; 0 turns it off.
 */
export const DEFAULT_TURN_LIMIT_MS = 120 * 1000;

/** TURRI_TURN_LIMIT, in seconds: over the config's turn limits, for every agent. */
const TURN_LIMIT_FROM_ENV = process.env.TURRI_TURN_LIMIT !== undefined && process.env.TURRI_TURN_LIMIT.trim() !== "" ? Number(process.env.TURRI_TURN_LIMIT) * 1000 : undefined;

/** How long past the turn limit what is running then - the model answering, a tool - may take to finish. */
export const TURN_GRACE_MS = Number(process.env.TURRI_TURN_GRACE ?? 60) * 1000;

/** A session's task, in its instructions, until its first turn shows it in the transcript. */
const pendingTask = new WeakMap<object, string>();

/** An image an agent is sent with a message. */
export interface AgentImage {
  type: "image";
  data: string;
  mimeType: string;
}

/** A session's images, and whether its conversation holds them now: not at first, nor after a compaction. */
const sessionImages = new WeakMap<object, { images: AgentImage[]; sent: boolean }>();

/**
 * Refuses, before any agent of a job starts, a named model that reads no images when the job's spec links some -
 * rather than once the work is under way. Unnamed, the model is pi's default: `createExecutor` refuses it then.
 */
export async function refuseIfModelIsBlind(modelSpec: string | undefined, count: number): Promise<void> {
  if (count === 0) return;
  const chosen = splitModelSpec(modelSpec).model;
  const slash = chosen?.indexOf("/") ?? -1;
  if (chosen === undefined || slash === -1) return;
  refuseIfBlind(new ModelRegistry(await subAgentModelRuntime()).find(chosen.slice(0, slash), chosen.slice(slash + 1)), count);
}

/** A model that cannot read images, given images to read. */
export class ModelCannotReadImagesError extends Error {}

/**
 * Stops an agent whose model reads no images being given some: it would work blind from the spec's images. Says
 * which model, and what to do - a coding model that reads images, or the images described in text instead.
 */
export function refuseIfBlind(model: { provider: string; id: string; input?: readonly string[] } | undefined, count: number): void {
  if (model === undefined || model.input?.includes("image") === true) return;
  throw new ModelCannotReadImagesError(
    `The spec links ${count === 1 ? "an image" : `${count} images`} (PNG or JPEG), and ${model.provider}/${model.id} cannot read images. ` +
      "Set coding-model in config.yaml to a model that reads images, or describe what the image shows in a text file and link that instead.",
  );
}

/**
 * What an agent opens with when its task is in its instructions. The task - the spec, how to read it, what to do
 * and the rules - is its system prompt, not its first message: compaction sums up the conversation and never the
 * system prompt, so what the agent works from stays word for word as it was, however long the work runs, and stays
 * in the cached prefix of every call.
 */
export const BEGIN = "Begin. Your task is in your instructions.";

/** How a session's work is summed up when it grows past the threshold: what the summary has to keep, for its role. */
export interface Compaction {
  instructions: string;
  /** Tokens of conversation - past the system prompt - past which it is compacted. Default: the project's compact-at, else DEFAULT_COMPACT_AT. */
  atTokens?: number;
}

/** Tokens of conversation past which a session that keeps working is compacted, when the project does not say. */
export const DEFAULT_COMPACT_AT = 100_000;

const compactions = new WeakMap<object, Required<Compaction>>();

/** Have a session compacted between turns, as `compaction` says: what createExecutor does for an agent given one. */
export function keepCompacted(session: object, compaction: Required<Compaction>): void {
  compactions.set(session, compaction);
}

/** A rough count, as pi's own estimate makes it: four characters a token. */
function tokensIn(text: string): number {
  return Math.ceil(text.length / 4);
}

function thousands(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : `${tokens}`;
}

/**
 * Compact a session's work when its conversation - what it has done, not its instructions - has grown past its
 * threshold. An agent that keeps its session through a job re-reads everything it did on every call: this keeps
 * that bounded, as pi's own compaction does only when the context window is nearly full. The summary keeps what
 * its role needs; its instructions are untouched. A compaction that fails leaves the session as it was.
 */
export async function compactIfDue(session: AgentSession): Promise<boolean> {
  const settings = compactions.get(session);
  if (settings === undefined) return false;
  let tokens: number | null | undefined;
  try {
    tokens = session.getContextUsage()?.tokens;
  } catch {
    return false;
  }
  if (tokens === null || tokens === undefined) return false;
  const conversation = tokens - tokensIn(session.systemPrompt ?? "");
  if (conversation < settings.atTokens) return false;
  const agent = agentOf(session);
  const who = agent?.label ?? "the agent";
  reportActivity(`  compacting ${who}'s work: ${thousands(conversation)} tokens of it, past ${thousands(settings.atTokens)}`);
  try {
    const result = await session.compact(settings.instructions);
    const usage = result.usage as { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total: number } } | undefined;
    if (usage !== undefined) {
      const spent = { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, cost: usage.cost?.total ?? 0 };
      reportUsage(spent);
      if (agent !== undefined) reportAgent({ label: agent.label, usage: spent });
    }
    if (agent !== undefined) reportAgent({ label: agent.label, compactions: 1 });
    reportActivity(`  compacted ${who}'s work${result.estimatedTokensAfter !== undefined ? ` to about ${thousands(result.estimatedTokensAfter)} tokens` : ""}`);
    debugLogOf(session)?.note(`compacted: ${result.tokensBefore} tokens before${result.estimatedTokensAfter !== undefined ? `, about ${result.estimatedTokensAfter} after` : ""}`);
    return true;
  } catch (error) {
    reportActivity(`  could not compact ${who}'s work - it goes on as it is: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`);
    return false;
  }
}

/** The sessions whose turns are timed, and how long each turn may take: the agents a render starts, not the conversation or a skill's. */
const timedSessions = new WeakMap<object, number>();

/** Which agent a session is, and what it runs on - for its transcript entries. */
const agentLabels = new WeakMap<object, { label: string; model?: string }>();
/** Each agent's role, to say on its activity lines which agent did what. */
const agentRoles = new WeakMap<object, AgentRole>();

function agentOf(session: object): { label: string; model?: string } | undefined {
  return agentLabels.get(session);
}

/**
 * Have this session's turns timed, as an agent a render starts has: `limitMs` each - its role's in the config - or
 * the default. TURRI_TURN_LIMIT wins over both.
 */
export function timeTurns(session: object, limitMs?: number): void {
  timedSessions.set(session, TURN_LIMIT_FROM_ENV ?? limitMs ?? DEFAULT_TURN_LIMIT_MS);
}

/** How many calls to one tool may fail in a row, nothing going through, before the agent's turn is stopped. */
export const FAILURES_BEFORE_STOP = 10;

/** How many times running the very same tool call is let through before it is refused, and before the turn is stopped. */
export const REPEATS_ALLOWED = 3;
export const REPEATS_BEFORE_STOP = 6;

/** "2 minutes", "90 seconds". */
function formatLimit(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

/** JSON with every object's keys in order, so two ways of writing the same arguments read the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

/** Tools that only look: calling one again, with nothing changed since, gives the same answer. */
const LOOKING_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** How many tool calls an agent that has one thing to decide may make before it is told to decide. */
export interface CallBudget {
  calls: number;
  /** The tools that hand over the decision - still let through past the budget. */
  finish: string[];
}

/**
 * Tools that notice an agent going round in a circle. The same call again and again with nothing in
 * between; or a look - read, grep, find, ls - made again with nothing changed since, however many
 * other looks came between: the same answer comes back. The first few go through; after that the
 * call is refused with what is happening, and if the agent carries on regardless its turn is
 * stopped - the harness goes on from there, as after any turn.
 *
 * With a budget, an agent that has one thing to decide - a verdict, a review, an account - is told
 * to decide once it has made that many calls: every tool but the one that hands it over refuses,
 * and past twice the budget its turn is stopped. Handing it over starts the count again, and forgets
 * the looks: a reviewer kept for the next review reads the files as they are by then.
 */
export function guardRepeats(tools: ToolDefinition[], session: () => AgentSession | undefined, budget?: CallBudget): ToolDefinition[] {
  let last: string | undefined;
  let times = 0;
  // Looks made since the last call that could change anything, and how often each.
  const looks = new Map<string, number>();
  let calls = 0;
  // Calls refused in the restricted turn under way, and which turn's set that was.
  let refused = 0;
  let refusedIn: Set<string> | undefined;
  return tools.map((tool) => ({
    ...tool,
    execute: async (...args: Parameters<ToolDefinition["execute"]>) => {
      const [, params] = args;
      const current = session();
      const only = current !== undefined ? turnTools.get(current) : undefined;
      if (only !== undefined && !only.has(tool.name)) {
        if (refusedIn !== only) (refused = 0), (refusedIn = only);
        refused += 1;
        if (refused > REFUSED_BEFORE_STOP) {
          reportActivity(`  stopped the agent's turn: ${refused} calls to tools this turn does not have`);
          void current?.abort();
          throw new Error(`Stopped: ${refused} calls to tools this turn does not have.`);
        }
        throw new Error(
          `Not run: your work is done and checked - this turn is for ${[...only].join(" and ")} alone, and nothing else is ` +
            `run. Call ${[...only].join(" or ")}, then finish.`,
        );
      }
      calls += 1;
      if (budget !== undefined && !budget.finish.includes(tool.name) && calls > budget.calls) {
        if (calls > budget.calls * 2) {
          reportActivity(`  stopped the agent's turn: ${calls} tool calls, past its budget of ${budget.calls}`);
          void session()?.abort();
          throw new Error(`Stopped: ${calls} tool calls, past the budget of ${budget.calls}.`);
        }
        throw new Error(
          `Not run: you have made ${budget.calls} tool calls, which is all you have. Decide now with what you know: call ` +
            `${budget.finish.join(" or ")}.`,
        );
      }
      let key: string;
      try {
        // The same call is the same whatever order its arguments come in: models reorder them freely.
        key = `${tool.name} ${canonicalJson(params ?? {})}`;
      } catch {
        key = `${tool.name} ${String(Math.random())}`;
      }
      times = key === last ? times + 1 : 1;
      last = key;
      let repeats = times;
      if (LOOKING_TOOLS.has(tool.name)) {
        const seen = (looks.get(key) ?? 0) + 1;
        looks.set(key, seen);
        repeats = Math.max(repeats, seen);
      } else {
        // Anything else may have changed what a look would find.
        looks.clear();
      }
      if (repeats > REPEATS_BEFORE_STOP) {
        reportActivity(`  stopped the agent's turn: it made the same ${tool.name} call ${repeats} times with nothing changed`);
        void session()?.abort();
        throw new Error(`Stopped: the same ${tool.name} call ${repeats} times with nothing changed.`);
      }
      if (repeats > REPEATS_ALLOWED) {
        reportActivity(`  refused a repeated ${tool.name} call (${repeats} times with nothing changed)`);
        throw new Error(
          `Not run: you have made this exact ${tool.name} call ${repeats} times, with nothing changed since - so it would give ` +
            "the same result again. Stop repeating it: use what it already told you, do something different, or finish. " +
            `After ${REPEATS_BEFORE_STOP} your turn is stopped.`,
        );
      }
      const result = await tool.execute(...args);
      // The decision handed over ends the round: a session kept for the next one starts it with its whole budget.
      if (budget?.finish.includes(tool.name)) {
        calls = 0;
        last = undefined;
        times = 0;
        looks.clear();
      }
      return result;
    },
  })) as ToolDefinition[];
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
  /**
   * "provider/model-id", with ":level" for how hard it thinks ("google/gemini-3.1-pro:high"), or
   * ":level" alone for pi's default model. Omitted: whatever pi is configured to use.
   */
  model?: string;
  /** Give it the ***plain rules - for agents that write or edit specs, not code. */
  rules?: boolean;
  /** Continue the session saved in this file, instead of starting a new one. */
  resumeFrom?: string;
  /** Added to its system prompt: its sandbox, above all - what it can reach (see confine.ts sandboxNote). */
  system?: string;
  /**
   * Its task - everything its first prompt used to say: the spec, how to read it, what to do, the rules. It goes
   * into its system prompt, after `system`, so compaction never sums it up; open the session with BEGIN.
   */
  task?: string;
  /** Given, the session keeps working through a job and is compacted between turns once its work grows past the threshold. */
  compaction?: Compaction;
  /**
   * What the agent is, e.g. "app 3 coding agent". Given, the agent is one a render started: its
   * whole conversation is streamed to a log named after it (see debug-log.ts).
   */
  label?: string;
  /** For an agent with one thing to decide: how many tool calls it has, and the tools that hand the decision over. */
  budget?: CallBudget;
  /**
   * Images its task refers to - the spec's linked images. Sent with its first message, and again after each
   * compaction, which sums them up with the rest. A model that cannot read images is refused, before any work.
   */
  images?: AgentImage[];
  /**
   * For an agent that writes and runs code: the harness's own run of the testing script, which an environment report it
   * makes is checked against before the pulse stops (checkAgainstScript). Only an agent given it has
   * report_environment_error at all.
   */
  checkEnvironment?: { run: () => Promise<{ exitCode: number; output: string }>; script: string };
  /**
   * What the agent does: its role's model, thinking and turn limit in the config (`models:`) apply - the model over
   * `model`, unless the config names none for the role.
   */
  role?: AgentRole;
}): Promise<AgentSession> {
  // Saved to disk, in the project: an agent's session is the record of what it did, and the
  // only way to pick a long run back up after the process that ran it is gone.
  const sessionManager =
    opts.resumeFrom !== undefined
      ? SessionManager.open(opts.resumeFrom)
      : SessionManager.create(opts.cwd, sessionsDir(projectRootOf(opts.cwd)));
  // An agent that writes and runs code - given the harness's run its reports are checked against - can say the machine
  // lacks what the work needs: its turn ends, and the pulse stops with it. Observers, explorers and judges cannot.
  const hasShell = opts.customTools.some((tool) => tool.name === "bash") && opts.checkEnvironment !== undefined;
  const reported: { report?: { missing: string; neededBy: string; shownBy?: string } } = {};
  const check = opts.checkEnvironment !== undefined ? checkAgainstScript(opts.checkEnvironment.run, opts.checkEnvironment.script) : undefined;
  const withEnvironmentErrors = hasShell ? [...opts.customTools, environmentErrorTool((report) => (reported.report = report), check)] : opts.customTools;
  const { session } = await createAgentSession({
    cwd: opts.cwd,
    modelRuntime: await subAgentModelRuntime(),
    tools: hasShell ? [...opts.tools, ENVIRONMENT_ERROR_TOOL] : opts.tools,
    // What an agent is shown never holds a credential the project passed: each value is its name (masking.ts).
    customTools: guardRepeats(maskToolResults(withEnvironmentErrors), () => session, opts.budget),
    sessionManager,
    resourceLoader: await subAgentResources(opts.cwd, opts.rules === true, [opts.system, opts.task].filter((part) => part !== undefined && part !== "").join("\n\n") || undefined),
  });
  if (opts.task !== undefined) pendingTask.set(session, opts.task);
  if (hasShell) environmentReports.set(session, { cwd: opts.cwd, reported });
  if (opts.compaction !== undefined) keepCompacted(session, { instructions: opts.compaction.instructions, atTokens: opts.compaction.atTokens ?? compactAtFor(opts.cwd) });

  // Its role's own model and thinking, where the config names them; otherwise what it was given.
  const config = opts.role !== undefined ? configForCwd(opts.cwd) : undefined;
  const fromRole = config !== undefined && opts.role !== undefined ? roleModel(config, opts.role) : undefined;
  const chosen = fromRole !== undefined ? (inheritModel(fromRole, splitModelSpec(opts.model)) ?? {}) : splitModelSpec(opts.model);
  if (chosen.model !== undefined) {
    const model = findModel(session, chosen.model);
    if (model === undefined) {
      throw new Error(`Model '${chosen.model}' is not configured. Check the provider's API key.`);
    }
    await session.setModel(model);
  }

  // After the model: switching models picks a thinking level of its own.
  const thinking = agentThinking(chosen.thinking, opts.role, inheritedThinkingLevel);
  if (thinking !== undefined) session.setThinkingLevel(thinking);

  if (opts.images !== undefined && opts.images.length > 0) {
    refuseIfBlind(session.model, opts.images.length);
    sessionImages.set(session, { images: opts.images, sent: false });
  }

  // After both, so the log's header says what it really runs on.
  if (opts.label !== undefined) startDebugLog(session, { cwd: opts.cwd, label: opts.label, tools: opts.tools });
  // An agent a render starts - it has a label - has its turns timed: as long as its role's turns may take.
  if (opts.label !== undefined) timeTurns(session, config !== undefined ? roleTurnLimitMs(config, opts.role) : undefined);
  sendReasoningEffort(session);
  if (opts.role !== undefined) agentRoles.set(session, opts.role);
  if (opts.label !== undefined) {
    const thinking = session.thinkingLevel;
    agentLabels.set(session, { label: opts.label, model: session.model !== undefined ? `${session.model.provider}/${session.model.id}${thinking ? `:${thinking}` : ""}` : undefined });
  }

  return session;
}

/** The project's compact-at, for an agent working in `cwd`: from its config.yaml, else the default. */
/** The config an agent working in `cwd` is under: its module's own over the project's, inside plain_modules/<module>. */
function configForCwd(cwd: string): ProjectConfig {
  try {
    const root = projectRootOf(cwd);
    const parts = resolve(cwd).split(sep);
    const index = parts.lastIndexOf(MODULES_DIR);
    const module = index >= 0 && parts.length > index + 1 ? configModuleOfBuild(root, parts[index + 1]!) : undefined;
    return readProjectConfig(root, module);
  } catch {
    return {};
  }
}

/** pi's thinking levels as the reasoning effort OpenAI's models on Bedrock take. */
const BEDROCK_OPENAI_EFFORT: Record<string, string> = { off: "none", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" };

/**
 * OpenAI's models on Bedrock are sent the session's thinking level as their reasoning effort - pi sends none for a
 * model that is not Anthropic's, and they would think at their own default whatever the config said.
 */
function sendReasoningEffort(session: AgentSession): void {
  const agent = session.agent as { onPayload?: (payload: unknown, model: unknown) => unknown };
  const before = agent.onPayload;
  agent.onPayload = async (payload: unknown, model: unknown) => withReasoningEffort((await before?.(payload, model)) ?? payload, model, session.thinkingLevel);
}

/** A provider request with its thinking level sent as reasoning effort, where the model takes one turri sends itself. */
export function withReasoningEffort(payload: unknown, model: unknown, thinkingLevel: string | undefined): unknown {
  const m = model as { api?: string; id?: string; reasoning?: boolean } | undefined;
  const effort = BEDROCK_OPENAI_EFFORT[thinkingLevel ?? ""];
  if (m?.api !== "bedrock-converse-stream" || m.reasoning !== true || !/(^|\.)openai\./.test(m.id ?? "") || effort === undefined) return payload;
  if (payload === null || typeof payload !== "object") return payload;
  const input = payload as { additionalModelRequestFields?: Record<string, unknown> };
  return { ...input, additionalModelRequestFields: { ...(input.additionalModelRequestFields ?? {}), reasoning: { effort } } };
}

function compactAtFor(cwd: string): number {
  try {
    return readProjectConfig(projectRootOf(cwd)).compactAt ?? DEFAULT_COMPACT_AT;
  } catch {
    return DEFAULT_COMPACT_AT;
  }
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
  /** What it judges and by which rubric: its instructions, as an executor's task is. Open the session with BEGIN. */
  task?: string;
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
    resourceLoader: await subAgentResources(opts.cwd, true, opts.task),
  });
  if (opts.task !== undefined) pendingTask.set(session, opts.task);
  return { session, modelNote };
}
