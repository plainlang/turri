import {
  AgentSession,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

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

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      out += event.assistantMessageEvent.delta;
      onDelta?.(event.assistantMessageEvent.delta);
    }
    if (event.type === "message_end") {
      const message = event.message as { role?: string; stopReason?: string; errorMessage?: string };
      if (message.role === "assistant" && message.stopReason === "error") {
        providerError = message.errorMessage ?? "the provider returned an error";
      }
    }
  });

  try {
    await session.prompt(text, { expandPromptTemplates: false });
  } finally {
    unsubscribe();
  }

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
}): Promise<AgentSession> {
  const { session } = await createAgentSession({
    cwd: opts.cwd,
    tools: opts.tools,
    customTools: opts.customTools,
    sessionManager: SessionManager.inMemory(opts.cwd),
  });

  if (opts.model !== undefined) {
    const model = findModel(session, opts.model);
    if (model === undefined) {
      throw new Error(`Model '${opts.model}' is not configured. Check the provider's API key.`);
    }
    await session.setModel(model);
  }

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
  });
  return { session, modelNote };
}
