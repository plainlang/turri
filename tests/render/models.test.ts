import { describe, expect, it } from "vitest";
import { createJobRegistry } from "../../src/render/jobs.ts";
import { type CatalogModel, describeChoices, type ModelChoices, modelFor, resolveModel } from "../../src/render/models.ts";
import { createRenderQueue, type RenderRunner } from "../../src/render/queue.ts";

/** A catalog like pi's: some providers have credentials here, most do not. */
const MODELS: CatalogModel[] = [
  { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
  { provider: "openai", id: "gpt-5.5-pro", name: "GPT-5.5 Pro" },
  { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
  { provider: "amazon-bedrock", id: "openai.gpt-5.5", name: "GPT-5.5" },
  { provider: "google", id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite" },
  { provider: "google", id: "gemini-3.1-flash-lite-preview", name: "Gemini 3.1 Flash Lite Preview" },
  { provider: "google", id: "gemini-3.6-flash", name: "Gemini 3.6 Flash" },
  { provider: "openrouter", id: "google/gemini-3.6-flash", name: "Google: Gemini 3.6 Flash" },
];

const catalog = (withCredentials: string[]) => ({
  getAll: () => MODELS,
  hasConfiguredAuth: (model: CatalogModel) => withCredentials.includes(model.provider),
});

describe("resolving what the person called a model", () => {
  const here = catalog(["openai", "google"]);

  it("takes an exact provider/id, or a bare id", () => {
    expect(resolveModel("google/gemini-3.6-flash", here)).toMatchObject({ ok: true, model: "google/gemini-3.6-flash" });
    expect(resolveModel("gpt-4o-mini", here)).toMatchObject({ ok: true, model: "openai/gpt-4o-mini" });
  });

  it("takes a loose name that fits one model with credentials", () => {
    expect(resolveModel("Gemini 3.6 Flash", here)).toMatchObject({ ok: true, model: "google/gemini-3.6-flash" });
    expect(resolveModel("gpt 4o mini", here)).toMatchObject({ ok: true, model: "openai/gpt-4o-mini" });
  });

  it("takes the one that is exactly what was said, over ones that only contain it", () => {
    expect(resolveModel("gpt 5.5", here)).toMatchObject({ ok: true, model: "openai/gpt-5.5" });
    expect(resolveModel("gpt 5.5 pro", here)).toMatchObject({ ok: true, model: "openai/gpt-5.5-pro" });
  });

  it("asks, rather than guessing, when a name fits several", () => {
    const resolution = resolveModel("gemini flash 3.1", here);
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.message).toContain("fits more than one model");
    expect(resolution.candidates).toEqual([
      "google/gemini-3.1-flash-lite (Gemini 3.1 Flash Lite)",
      "google/gemini-3.1-flash-lite-preview (Gemini 3.1 Flash Lite Preview)",
    ]);
  });

  it("never picks a model without credentials, and says whose are missing", () => {
    const resolution = resolveModel("google/gemini-3.6-flash", catalog(["openai"]));
    expect(resolution).toMatchObject({ ok: false, message: expect.stringContaining("google has no credentials") });
    const loose = resolveModel("gemini 3.6 flash", catalog(["openai"]));
    expect(loose).toMatchObject({ ok: false, message: expect.stringContaining("no model that has credentials") });
  });

  it("says when nothing matches at all", () => {
    expect(resolveModel("nonsense", here)).toMatchObject({ ok: false, message: expect.stringContaining("No model matches") });
  });
});

describe("the model a job runs on", () => {
  it("is the one chosen for its kind of work, else for everything, else the chat's", () => {
    const chosen: ModelChoices = {};
    expect(modelFor(chosen, "spec_changes", "openai/gpt-5.5")).toBe("openai/gpt-5.5");
    chosen.all = "openai/gpt-4o-mini";
    expect(modelFor(chosen, "spec_changes", "openai/gpt-5.5")).toBe("openai/gpt-4o-mini");
    chosen.spec_changes = "google/gemini-3.6-flash";
    expect(modelFor(chosen, "spec_changes", "openai/gpt-5.5")).toBe("google/gemini-3.6-flash");
    expect(modelFor(chosen, "functionalities", "openai/gpt-5.5")).toBe("openai/gpt-4o-mini");
    expect(describeChoices({ spec_changes: "google/gemini-3.6-flash" }, "openai/gpt-5.5")).toBe(
      "- spec changes: google/gemini-3.6-flash\n- functionalities: openai/gpt-5.5 (the chat's model)",
    );
  });

  it("is settled when the job is queued: an earlier job keeps its model when the choice changes", async () => {
    const chosen: ModelChoices = {};
    const ranOn: Array<string | undefined> = [];
    const run: RenderRunner = async (request) => {
      ranOn.push(request.model);
      return { report: "done" };
    };
    const registry = createJobRegistry();
    const queue = createRenderQueue({ registry, cwd: ".", run, modelFor: (work) => modelFor(chosen, work, "openai/gpt-5.5") });

    const first = queue.enqueue({ plainFile: "app.plain", frid: "1" });
    chosen.functionalities = "google/gemini-3.6-flash";
    const second = queue.enqueue({ plainFile: "app.plain", frid: "2" });
    await queue.drain();

    expect(ranOn).toEqual(["openai/gpt-5.5", "google/gemini-3.6-flash"]);
    expect([registry.get(first.jobId)!.model, registry.get(second.jobId)!.model]).toEqual(["openai/gpt-5.5", "google/gemini-3.6-flash"]);
  });
});

describe("the project's model, from config.yaml", () => {
  it("is what renders run on when nothing was chosen in the session, and says where it came from", async () => {
    const { describeChoices, modelFor } = await import("../../src/render/models.ts");
    const project = "amazon-bedrock/eu.anthropic.claude-sonnet-5";
    expect(modelFor({}, "functionalities", project ?? "google/gemini-3.1-flash")).toBe(project);
    expect(modelFor({ functionalities: "openai/gpt-5.5" }, "functionalities", project)).toBe("openai/gpt-5.5");
    expect(describeChoices({ spec_changes: "openai/gpt-5.5" }, "google/gemini-3.1-flash", { model: project, from: "config.yaml" })).toBe(
      `- spec changes: openai/gpt-5.5\n- functionalities: ${project} (config.yaml)`,
    );
    expect(describeChoices({}, "google/gemini-3.1-flash")).toContain("google/gemini-3.1-flash (the chat's model)");
  });
});
