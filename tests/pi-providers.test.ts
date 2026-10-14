import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExecutor, inheritProviders } from "../src/pi.ts";

let root: string;
let previousAgentDir: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "turri-providers-"));
  // pi's own configuration is empty: no models.json, no auth.json - the provider comes only from an extension.
  mkdirSync(join(root, "agent"));
  mkdirSync(join(root, "project", "plain_modules"), { recursive: true });
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
});
afterEach(() => {
  inheritProviders(() => undefined);
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
});

/** The conversation's registry, with a provider an extension registered - a company's own gateway. */
async function conversationWithGateway(): Promise<ModelRegistry> {
  const registry = new ModelRegistry(await ModelRuntime.create({ authPath: join(root, "agent", "auth.json"), modelsPath: null }));
  registry.registerProvider("arcus", {
    baseUrl: "https://llm.example.com/v1",
    apiKey: "test-key",
    api: "openai-completions",
    models: [{ id: "gpt-5.6-luna", name: "Luna", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8_000 }],
  });
  return registry;
}

describe("a sub-agent's models", () => {
  it("include the providers the conversation's extensions registered, which it loads none of", async () => {
    const registry = await conversationWithGateway();
    inheritProviders(() => registry);
    const session = await createExecutor({ cwd: join(root, "project", "plain_modules"), customTools: [], tools: [], model: "arcus/gpt-5.6-luna" });
    expect(`${session.model?.provider}/${session.model?.id}`).toBe("arcus/gpt-5.6-luna");
  });

  it("are pi's configuration alone without a conversation - an unattended run - and say so for a model it lacks", async () => {
    await expect(createExecutor({ cwd: join(root, "project", "plain_modules"), customTools: [], tools: [], model: "arcus/gpt-5.6-luna" })).rejects.toThrow(/'arcus\/gpt-5.6-luna' is not a model pi knows/);
  });
});
