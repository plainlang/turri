import { describe, expect, it } from "vitest";
import { chatModels } from "../src/chat-models.ts";

describe("the two models of plainwright chat", () => {
  const config = { harnessModel: { model: "anthropic/claude-opus-5-5" } };

  it("start pi on config.yaml's harness model, and take the coding model from --coding-model", () => {
    expect(chatModels(["--coding-model", "google/gemini-3.1-flash", "-c"], config)).toEqual({
      piArgs: ["--model", "anthropic/claude-opus-5-5", "-c"],
      codingModel: "google/gemini-3.1-flash",
    });
    expect(chatModels([], {})).toEqual({ piArgs: [], codingModel: undefined });
  });

  it("let --harness-model, and pi's own --model or --provider, win over config.yaml", () => {
    expect(chatModels(["--harness-model=openai/gpt-5.5"], config).piArgs).toEqual(["--model", "openai/gpt-5.5"]);
    expect(chatModels(["--model", "sonnet"], config).piArgs).toEqual(["--model", "sonnet"]);
    expect(chatModels(["--provider=google"], config).piArgs).toEqual(["--provider=google"]);
    expect(chatModels(["--coding-model=a/b", "--coding-model", "c/d"], {}).codingModel).toBe("c/d");
  });
});
