import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * The values of the credentials a project passes to its agents (`agent-env:`) never appear in what an agent is shown
 * or what turri writes: each is replaced by its name, `[D365_CLIENT_SECRET]` - whole, URL-encoded, or split over the
 * chunks of a stream. A value is registered when the agents' environment is worked out (`agentEnvironment`), and masked
 * from then on everywhere in this process: a command's output as it streams, every tool result an agent is given and
 * every refusal, the kept whole outputs, the job and debug logs - and so the session transcripts, which hold only what
 * the tools returned.
 */

/** Shorter values are not masked: `1`, `eu`, `true` are everywhere in ordinary output. */
const MIN_LENGTH = 4;

/** Each form a value is masked in, to its name - longest first, so a value inside another is not cut in two. */
let forms: Array<[string, string]> = [];

/** Mask these values, by name, from now on. */
export function registerSecrets(values: Record<string, string>): void {
  const all = new Map(forms);
  for (const [name, value] of Object.entries(values)) {
    if (value.length < MIN_LENGTH) continue;
    for (const form of [value, encodeURIComponent(value), encodeURIComponent(value).replace(/%20/g, "+")]) all.set(form, name);
  }
  forms = [...all].sort(([a], [b]) => b.length - a.length);
}

/** For tests: mask nothing. */
export function forgetSecretsForTests(): void {
  forms = [];
}

/** The longest form registered: how much of a stream has to be held back to catch one split over chunks. */
function longest(): number {
  return forms[0]?.[0].length ?? 0;
}

/** `text` with every registered value replaced by its name. */
export function maskSecrets(text: string): string {
  if (forms.length === 0) return text;
  let masked = text;
  for (const [form, name] of forms) if (masked.includes(form)) masked = masked.split(form).join(`[${name}]`);
  return masked;
}

/**
 * A stream that masks what passes through it before `onData` sees it: the end of each chunk is held back - as long as
 * the longest value, less one - until the next shows whether a value runs across them. `end` lets the rest out.
 */
export function maskingStream(onData: (data: Buffer) => void): { write(data: Buffer): void; end(): void } {
  let held = "";
  return {
    write(data) {
      if (forms.length === 0 && held === "") {
        onData(data);
        return;
      }
      const text = maskSecrets(held + data.toString("utf8"));
      const keep = Math.max(0, longest() - 1);
      const cut = Math.max(0, text.length - keep);
      held = text.slice(cut);
      if (cut > 0) onData(Buffer.from(text.slice(0, cut)));
    },
    end() {
      if (held !== "") onData(Buffer.from(maskSecrets(held)));
      held = "";
    },
  };
}

type AnyTool = ToolDefinition<any, any, any>;

/** The tools, each result they return - and each error they throw, a refusal - masked before the agent sees it. */
export function maskToolResults<T extends AnyTool>(tools: T[]): T[] {
  return tools.map((tool) => ({
    ...tool,
    async execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
      const update = onUpdate === undefined ? undefined : (partial: any) => onUpdate(maskResult(partial));
      try {
        return maskResult(await tool.execute(toolCallId, params, signal, update, ctx));
      } catch (error) {
        if (error instanceof Error) error.message = maskSecrets(error.message);
        throw error;
      }
    },
  }));
}

function maskResult<R>(result: R): R {
  if (forms.length === 0 || result === null || typeof result !== "object") return result;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return result;
  return {
    ...result,
    content: content.map((part: { type?: string; text?: string }) => (part?.type === "text" && typeof part.text === "string" ? { ...part, text: maskSecrets(part.text) } : part)),
  };
}
