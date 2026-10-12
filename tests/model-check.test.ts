import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProjectConfig } from "../src/config.ts";
import { checkModels, fixFor, modelsInUse, type ModelAccess } from "../src/model-check.ts";
import { checkProjectModels } from "../src/setup.ts";

/** A provider stand-in: the models it knows, and what each answers - an error, or nothing when it answers. */
function provider(known: Record<string, string[]>, answers: Record<string, string | undefined> = {}): ModelAccess & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    find: (name, id) => (known[name]?.includes(id) ? `${name}/${id}` : undefined),
    known: (name) => known[name] ?? [],
    async ask(model) {
      asked.push(String(model));
      return answers[String(model)];
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "turri-model-check-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the models a config uses", () => {
  it("are the two models, judge-model when set, and every role models: gives a model - each once, with what names it", () => {
    writeFileSync(
      join(dir, "config.turri.yaml"),
      "harness-model: anthropic/claude-opus-5-5:medium\ncoding-model: anthropic/claude-haiku-5-5:low\nmodels:\n  planner: anthropic/claude-opus-5-5\n  judge: openai/gpt-6.1-sol\n  reviewer: { thinking: medium }\n",
    );
    expect(modelsInUse(readProjectConfig(dir))).toEqual([
      { spec: "anthropic/claude-opus-5-5", usedBy: ["harness-model", "models.planner"] },
      // The reviewer names only how it thinks: it runs on the coding model, already there.
      { spec: "anthropic/claude-haiku-5-5", usedBy: ["coding-model"] },
      { spec: "openai/gpt-6.1-sol", usedBy: ["models.judge"] },
    ]);
  });
});

describe("checking the models answer", () => {
  it("asks each model once, and says it answered", async () => {
    const access = provider({ "amazon-bedrock": ["global.openai.gpt-6-astra"] });
    const [verdict] = await checkModels([{ spec: "amazon-bedrock/global.openai.gpt-6-astra", usedBy: ["harness-model"] }], access);
    expect(verdict).toMatchObject({ ok: true, spec: "amazon-bedrock/global.openai.gpt-6-astra" });
    expect(access.asked).toEqual(["amazon-bedrock/global.openai.gpt-6-astra"]);
  });

  it("says what the provider said, and to check the credentials pi reads for it, when it refuses them", async () => {
    const access = provider({ openai: ["gpt-6-astra"] }, { "openai/gpt-6-astra": 'OpenAI API error (401): {"message":"Incorrect API key provided"}\nmore' });
    const [verdict] = await checkModels([{ spec: "openai/gpt-6-astra", usedBy: ["harness-model"] }], access);
    expect(verdict).toMatchObject({ ok: false, problem: 'OpenAI API error (401): {"message":"Incorrect API key provided"}' });
    expect(verdict!.ok === false && verdict!.fix).toContain("OPENAI_API_KEY");
  });

  it("names the closest models pi knows for one it does not, asking nothing", async () => {
    const access = provider({ anthropic: ["claude-fable-5", "claude-haiku-4-5", "claude-haiku-5-5", "claude-opus-5-5"] });
    const [verdict] = await checkModels([{ spec: "anthropic/claude-haiku-9-9", usedBy: ["coding-model"] }], access);
    expect(verdict).toMatchObject({ ok: false, problem: "pi knows no model claude-haiku-9-9 at anthropic" });
    expect(verdict!.ok === false && verdict!.fix).toMatch(/^did you mean anthropic\/claude-haiku-/);
    expect(verdict!.ok === false && verdict!.fix).not.toContain("fable");
    expect(access.asked).toEqual([]);
  });

  it("says when pi knows no such provider, or the model is not provider/model-id", async () => {
    const access = provider({});
    const verdicts = await checkModels(
      [
        { spec: "nobody/model", usedBy: ["harness-model"] },
        { spec: "gpt-6-astra", usedBy: ["coding-model"] },
      ],
      access,
    );
    expect(verdicts.map((verdict) => verdict.ok === false && verdict.problem)).toEqual(["pi knows no provider nobody", "not provider/model-id"]);
  });

  it("tells Bedrock's missing model access, a region and a busy provider apart from a credential", () => {
    expect(fixFor("amazon-bedrock", "AccessDeniedException: You don't have access to the model with the specified model ID.")).toContain("model access");
    expect(fixFor("amazon-bedrock", "The security token included in the request is invalid.")).toContain("AWS_PROFILE");
    expect(fixFor("amazon-bedrock", "getaddrinfo ENOTFOUND bedrock-runtime.nowhere-1.amazonaws.com")).toContain("AWS_REGION");
    expect(fixFor("google", "429 Resource has been exhausted (e.g. check quota).")).toContain("try again later");
    // pi has no credentials for it at all: sign in, not "see what the provider said".
    expect(fixFor("anthropic", "Provider is not configured: anthropic")).toBe("sign in to anthropic: ANTHROPIC_API_KEY, or /login in turri");
  });
});

describe("turri doctor, in a project", () => {
  it("has a line for each model the config names - ready, or what is wrong and what to do", async () => {
    writeFileSync(join(dir, "config.turri.yaml"), "harness-model: openai/gpt-6-astra:medium\ncoding-model: openai/gpt-6-luna:low\n");
    const access = provider({ openai: ["gpt-6-astra", "gpt-6-luna"] }, { "openai/gpt-6-luna": "401 Unauthorized" });
    const checks = await checkProjectModels(dir, access);
    expect(checks).toEqual([
      expect.objectContaining({ level: "ok", name: "harness-model", detail: expect.stringMatching(/^openai\/gpt-6-astra answered/) }),
      expect.objectContaining({ level: "missing", name: "coding-model", detail: "openai/gpt-6-luna", more: ["401 Unauthorized"], fix: expect.stringContaining("OPENAI_API_KEY") }),
    ]);
  });

  it("says so when the config names no model", async () => {
    writeFileSync(join(dir, "config.turri.yaml"), "review: false\n");
    expect(await checkProjectModels(dir, provider({}))).toEqual([expect.objectContaining({ level: "missing", detail: "config.turri.yaml names none" })]);
  });
});
