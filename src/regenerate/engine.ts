/**
 * Which model the agents of a job run on.
 *
 * By default, whatever the conversation is using. The person can say otherwise - "render spec
 * changes with Gemini Flash" - for one kind of work or for all of it, and that holds for the
 * rest of the session, for jobs started from a tool call and for jobs a skill queues alike. A
 * single tool call can also name a model for itself alone.
 *
 * A name is resolved strictly. pi's own pattern matching picks its best guess and says nothing
 * - "gpt-5" becomes a Bedrock model with no credentials, "flash" a GLM one - and a job on a
 * guessed model is worse than a question. So an exact id is taken as it is, a looser name is
 * taken only when it fits exactly one model that has credentials, and anything else comes back
 * as a short list to ask the person about.
 */

/** The part of pi's model registry this needs. */
export interface ModelCatalog {
  getAll(): ReadonlyArray<CatalogModel>;
  hasConfiguredAuth(model: CatalogModel): boolean;
}

export interface CatalogModel {
  provider: string;
  id: string;
  name?: string;
}

export type ModelResolution =
  | { ok: true; model: string; name: string }
  | { ok: false; message: string; candidates: string[] };

const MAX_CANDIDATES = 8;

function label(model: CatalogModel): string {
  return `${model.provider}/${model.id}`;
}

function describe(model: CatalogModel, catalog: ModelCatalog): string {
  const name = model.name && model.name !== model.id ? ` (${model.name})` : "";
  return `${label(model)}${name}${catalog.hasConfiguredAuth(model) ? "" : " - no credentials"}`;
}

/** The words of a model name, lowercased: "Gemini Flash 3.1" and "gemini-3.1-flash" alike. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s/_:-]+|(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/)
    .filter(Boolean);
}

function noCredentials(model: CatalogModel): ModelResolution {
  return {
    ok: false,
    message:
      `${label(model)} is known, but ${model.provider} has no credentials here. ` +
      "Log in with /login, or set the provider's API key, and try again.",
    candidates: [],
  };
}

function found(model: CatalogModel): ModelResolution {
  return { ok: true, model: label(model), name: model.name ?? model.id };
}

/** Resolve what the person called a model to one this machine can run, or say why not. */
export function resolveModel(query: string, catalog: ModelCatalog): ModelResolution {
  const wanted = query.trim();
  const all = catalog.getAll();
  const usable = (model: CatalogModel) => catalog.hasConfiguredAuth(model);

  // An exact reference: provider/id, or a bare id.
  const exact = all.filter((model) => label(model).toLowerCase() === wanted.toLowerCase());
  if (exact.length > 0) return usable(exact[0]!) ? found(exact[0]!) : noCredentials(exact[0]!);
  const byId = all.filter((model) => model.id.toLowerCase() === wanted.toLowerCase());
  const byIdUsable = byId.filter(usable);
  if (byIdUsable.length === 1) return found(byIdUsable[0]!);
  if (byId.length === 1) return noCredentials(byId[0]!);

  // A looser name: every word of it has to be in the model's provider, id or name.
  const asked = words(wanted);
  const matches = (byId.length > 1 ? byId : all).filter((model) => {
    const have = new Set(words(`${model.provider} ${model.id} ${model.name ?? ""}`));
    return asked.length > 0 && asked.every((word) => have.has(word));
  });
  const matchesUsable = matches.filter(usable);
  if (matchesUsable.length === 1) return found(matchesUsable[0]!);
  // Several fit, but one is exactly what was said - "gpt 5.5" is gpt-5.5, not gpt-5.5-pro.
  const same = (model: CatalogModel) => {
    const id = words(model.id).filter((word) => !words(model.provider).includes(word));
    const said = asked.filter((word) => !words(model.provider).includes(word));
    return id.length === said.length && said.every((word) => id.includes(word));
  };
  const exactly = matchesUsable.filter(same);
  if (exactly.length === 1) return found(exactly[0]!);

  const shown = [...matchesUsable, ...matches.filter((model) => !usable(model))].slice(0, MAX_CANDIDATES);
  if (shown.length === 0) {
    return {
      ok: false,
      message: `No model matches '${wanted}'. Give its provider/id - pi's /model lists the ones configured here.`,
      candidates: [],
    };
  }
  const more = matches.length > shown.length ? ` (and ${matches.length - shown.length} more)` : "";
  return {
    ok: false,
    message:
      matchesUsable.length === 0
        ? `'${wanted}' matches no model that has credentials here. The closest${more}:`
        : `'${wanted}' fits more than one model. Ask which one is meant${more}:`,
    candidates: shown.map((model) => describe(model, catalog)),
  };
}

/** The resolution as text for the agent: the model, or why not and what to ask. */
export function describeResolution(resolution: ModelResolution): string {
  if (resolution.ok) return `${resolution.model} (${resolution.name})`;
  return [resolution.message, ...resolution.candidates.map((candidate) => `- ${candidate}`)].join("\n");
}

/** Kinds of work a model can be chosen for. */
export type RenderWork = "spec_changes" | "functionalities";

export const WORK_LABEL: Record<RenderWork | "all", string> = {
  spec_changes: "spec changes",
  functionalities: "functionalities",
  all: "everything",
};

/** The models chosen in this session, by kind of work. Unset: the project's, or the conversation's model. */
export type ModelChoices = Partial<Record<RenderWork | "all", string>>;

/** The model a job of this kind runs on: chosen for it, chosen for everything, or the chat's. */
export function modelFor(choices: ModelChoices, work: RenderWork, chat: string | undefined): string | undefined {
  return choices[work] ?? choices.all ?? chat;
}

/**
 * Where each kind of work runs now, in a line each: chosen in this session, or the default coding
 * model - from `--coding-model` or config.turri.yaml, said which - or the conversation's.
 */
export function describeChoices(choices: ModelChoices, chat: string | undefined, project?: { model: string; from: string }): string {
  const fallback = project !== undefined ? `${project.model} (${project.from})` : `${chat ?? "pi's default model"} (the chat's model)`;
  return (["spec_changes", "functionalities"] as const)
    .map((work) => {
      const chosen = choices[work] ?? choices.all;
      return `- ${WORK_LABEL[work]}: ${chosen ?? fallback}`;
    })
    .join("\n");
}
