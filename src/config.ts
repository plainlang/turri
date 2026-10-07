import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { load as loadYaml } from "js-yaml";
import { projectDirOf } from "./grow/paths.ts";

/**
 * The project's `config.yaml`, at its root - the folder that holds `plain_modules`.
 *
 * One file for what a project says about how it is built:
 *
 * ```yaml
 * module: prism_cli.plain                                   # what `turri regrow` builds by default
 * harness-model:                                            # the model you chat with in `turri chat`
 *   model: anthropic/claude-opus-5-5
 *   thinking: high
 * coding-model:                                             # the rendering agents (default: harness-model)
 *   model: google/gemini-3.1-flash
 *   thinking: medium
 * judge-model:                                              # the judge and the test review (default: coding-model)
 *   model: google/gemini-3.1-pro
 * conformance-tests: chosen                                 # all, chosen (those with acceptance tests, and those the chat chose) or false (default: all, with test reqs)
 * conformance-budget: 30%                                   # under chosen: how many functional specs a module may have chosen, beside those with acceptance tests - a count or a share (default: no limit)
 * review: false                                             # review the code and its tests once they pass (default: true)
 * allow-to-stop-jobs: false                                 # stop a running job the spec moved on from (default: true)
 * release-after-pulse: true                                 # release what each pulse lands, as its last stage, before the next pulse (default: false)
 * rules-off: [integrations]                                 # ***plain rules to leave out of the prompts, by name (default: none)
 * unittests-script: test_scripts/run_unittests.sh           # the testing scripts - see test-scripts.ts
 * conformance-tests-script: test_scripts/run_conformance_tests.sh
 * static-checks-script: test_scripts/run_static_checks.sh   # optional: type checks, linters - see test-scripts.ts
 * testing-scripts-run-on: in-place                         # what the testing scripts run on: in-place (default), or copy - see test-scripts.ts
 * turn-limit: 150                                           # seconds each turn of an agent a render starts has (default: 120; 0 for none)
 * models:                                                   # each agent role's own model, thinking and turn limit - see AGENT_ROLES
 *   default: amazon-bedrock/global.openai.gpt-6-luna         #   every role not named
 *   coding: { model: amazon-bedrock/eu.anthropic.claude-sonnet-5, thinking: high, turn-limit: 150 }
 *   explorer: google/gemini-3.1-flash-lite
 * ```
 *
 * `models:` names a model, a thinking level and a turn limit per agent role (AGENT_ROLES), each falling back as
 * roleModel says: a role it does not name takes `default`, and what an entry leaves out it takes from there too.
 * `harness-model`, `coding-model` and `judge-model` are the same as `models: chat`, `coding` and `judge`, which win
 * over them. The turn limit is the role's own, else `default`'s, else `turn-limit:`, else two minutes;
 * TURRI_TURN_LIMIT wins over all of them.
 *
 * Each model is a model reference and a thinking level (off, minimal, low, medium, high, xhigh, max),
 * either of which may be left out; a bare string is the model alone. What a model leaves out it takes
 * from the one it inherits: judge-model from coding-model, coding-model from harness-model. They are
 * defaults: `--harness-model` / `--coding-model` / `--judge-model` on the command line win over them,
 * and so does a model chosen during the conversation (pi's /model, engine). `model:` is read
 * as `coding-model`, which it was before there were two.
 *
 * Keys are written with dashes; underscores are read the same (`conformance_tests`). Keys it
 * does not know - a codeplain `config.yaml` carries several - are ignored, and so is a value of
 * the wrong type. Everything is optional, and what is given on the command line wins.
 *
 * A project whose modules do not share a stack - a Python backend and a React frontend beside
 * each other, importing one common module - gives each its own settings in `config.<module>.yaml`
 * beside `config.yaml`: `config.backend.yaml` for `backend.plain`. A module is built with
 * `config.yaml`, and its own file over it, key by key - a model it names takes what it leaves out
 * from the project's. A module without a file of its own takes the one of the first module down
 * its `requires` chain that has one: a chain is one codebase, on one stack. `module:` and
 * `harness-model:` are the project's alone - there is one conversation - and are not read from a
 * module's file.
 */

export const CONFIG_FILE = "config.yaml";

/** A module's own config file's name: `config.backend.yaml` for the module `backend`. */
export function moduleConfigFile(module: string): string {
  return `config.${module}.yaml`;
}

/** The modules a project folder has config files of their own for, by name. */
export function modulesWithConfig(root: string): string[] {
  try {
    return readdirSync(root)
      .map((name) => /^config\.(.+)\.yaml$/.exec(name)?.[1])
      .filter((name): name is string => name !== undefined)
      .sort();
  } catch {
    return [];
  }
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** A model, and how hard it thinks - either may be left to the one it inherits from. */
export interface ModelChoice {
  /** "provider/model-id". */
  model?: string;
  thinking?: ThinkingLevel;
}

/**
 * The agents turri starts, by what they do - each can be given its own model, thinking and turn limit (`models:`).
 * The code fixer of a conformance run and the repair agent are coding agents; the unit-test and conformance arbiters
 * are both `arbiter`.
 */
export const AGENT_ROLES = ["chat", "chooser", "planner", "diagnosis", "release", "coding", "conformance", "explorer", "reviewer", "test-reviewer", "judge", "arbiter", "debugger"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** The roles on the conversation's side: without their own entry they take the chat's model, not `default`. */
const CHAT_SIDE: readonly AgentRole[] = ["chat", "chooser", "planner", "diagnosis", "release"];

/** A role's model and thinking, and how long each of its turns may take, in seconds - each may be left out. */
export interface RoleChoice extends ModelChoice {
  turnLimit?: number;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * A model choice as the one string every agent is given, in pi's own form: "provider/id", with
 * ":level" when it names how hard to think - ":level" alone for the default model thinking so.
 */
export function modelSpec(choice: ModelChoice | undefined): string | undefined {
  if (choice === undefined || (choice.model === undefined && choice.thinking === undefined)) return undefined;
  return `${choice.model ?? ""}${choice.thinking !== undefined ? `:${choice.thinking}` : ""}`;
}

/** A model spec back into its model and thinking level - "provider/id:high", "provider/id", ":high". */
export function splitModelSpec(spec: string | undefined): ModelChoice {
  const given = spec?.trim() ?? "";
  if (given === "") return {};
  const colon = given.lastIndexOf(":");
  const level = colon === -1 ? undefined : given.slice(colon + 1);
  if (colon !== -1 && isThinkingLevel(level)) {
    const model = given.slice(0, colon);
    return { ...(model !== "" ? { model } : {}), thinking: level };
  }
  return { model: given };
}

/** A choice with what it leaves out taken from the one it inherits from - or that one, when it is not given at all. */
export function inheritModel(own: ModelChoice | undefined, from: ModelChoice | undefined): ModelChoice | undefined {
  if (own === undefined) return from;
  const model = own.model ?? from?.model;
  const thinking = own.thinking ?? from?.thinking;
  return { ...(model !== undefined ? { model } : {}), ...(thinking !== undefined ? { thinking } : {}) };
}

/**
 * The three models as they hold: the judge inherits from the coding model, the coding model from the harness model -
 * `models:` over them: `chat` over harness-model, `coding` over coding-model, `judge` over judge-model, and `default`
 * between the harness model and the rest.
 */
export function projectModels(config: Pick<ProjectConfig, "harnessModel" | "codingModel" | "judgeModel" | "models">): {
  harness?: ModelChoice;
  coding?: ModelChoice;
  judge?: ModelChoice;
} {
  const models = config.models ?? {};
  const harness = inheritModel(choiceOf(models.chat), config.harnessModel);
  const coding = inheritModel(choiceOf(models.coding), inheritModel(config.codingModel, inheritModel(choiceOf(models.default), harness)));
  return { harness, coding, judge: inheritModel(choiceOf(models.judge), inheritModel(config.judgeModel, inheritModel(choiceOf(models.default), coding))) };
}

/** A role entry's model and thinking alone. */
function choiceOf(entry: RoleChoice | undefined): ModelChoice | undefined {
  if (entry === undefined || (entry.model === undefined && entry.thinking === undefined)) return undefined;
  return { ...(entry.model !== undefined ? { model: entry.model } : {}), ...(entry.thinking !== undefined ? { thinking: entry.thinking } : {}) };
}

/**
 * What the config itself says a role runs on - its own entry, the legacy key that names it (judge-model for the judge
 * and the test review), then `default` (the chat's side: the chat's model instead) - or nothing when it says nothing
 * of it, and the role runs on what it is given: the job's model, which the command line and the conversation choose.
 * The coding role always runs on what it is given: its config is already in it (projectModels).
 */
export function roleModel(config: Pick<ProjectConfig, "harnessModel" | "judgeModel" | "models">, role: AgentRole): ModelChoice | undefined {
  if (role === "coding") return undefined;
  const models = config.models ?? {};
  const own = choiceOf(models[role]);
  // The debugger looks at the coding agent's failure: without its own entry it runs on the coding model it is given.
  if (role === "debugger") return own;
  if (CHAT_SIDE.includes(role)) return own === undefined ? undefined : inheritModel(own, inheritModel(choiceOf(models.chat), config.harnessModel));
  const legacy = role === "judge" || role === "test-reviewer" ? config.judgeModel : undefined;
  return inheritModel(own, inheritModel(legacy, choiceOf(models.default)));
}

/** How long each turn of a role's agents may take, in milliseconds: its own, `default`'s, `turn-limit:`'s - or undefined, the harness's default. */
export function roleTurnLimitMs(config: Pick<ProjectConfig, "models" | "turnLimit">, role: AgentRole | undefined): number | undefined {
  const models = config.models ?? {};
  const seconds = (role !== undefined ? models[role]?.turnLimit : undefined) ?? models.default?.turnLimit ?? config.turnLimit;
  return seconds !== undefined ? seconds * 1000 : undefined;
}

/** A model as the config gives it: a string, or `model:` and `thinking:`. */
function modelChoice(value: unknown): ModelChoice | undefined {
  if (typeof value === "string") return text(value) !== undefined ? splitModelSpec(value) : undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const model = text(raw.model) ?? text(raw.name) ?? text(raw.ref);
  const thinking = isThinkingLevel(raw.thinking) ? raw.thinking : undefined;
  if (model === undefined && thinking === undefined) return undefined;
  return { ...(model !== undefined ? { model } : {}), ...(thinking !== undefined ? { thinking } : {}) };
}

/** A role's entry under `models:`: a model string, or `model:`, `thinking:` and `turn-limit:`. */
function roleChoice(value: unknown): RoleChoice | undefined {
  const choice = modelChoice(value);
  const raw = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const turnLimit = turnLimitSetting(raw["turn-limit"] ?? raw.turn_limit);
  if (choice === undefined && turnLimit === undefined) return undefined;
  return { ...(choice ?? {}), ...(turnLimit !== undefined ? { turnLimit } : {}) };
}

/** A turn limit in seconds: a whole number, 0 for none. */
function turnLimitSetting(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

/** `models:` - each role's entry, by its name; `default` for every role not named. */
function modelsSetting(value: unknown): ProjectConfig["models"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const models: NonNullable<ProjectConfig["models"]> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const name = key.replace(/_/g, "-");
    if (name !== "default" && !(AGENT_ROLES as readonly string[]).includes(name)) continue;
    const choice = roleChoice(entry);
    if (choice !== undefined) models[name as AgentRole | "default"] = choice;
  }
  return Object.keys(models).length > 0 ? models : undefined;
}

export interface ProjectConfig {
  /** The .plain file the module command builds when it is given none. */
  module?: string;
  /** The model `turri chat` starts with: the one the person talks to. */
  harnessModel?: ModelChoice;
  /** The model the rendering agents run on - every render, conformance, repair and spec change. Unset: the harness model. */
  codingModel?: ModelChoice;
  /**
   * The model of the agents that give a verdict in a conformance run - the judge, which says whether
   * the code, the tests or the spec is wrong, and the test review. Unset: the coding model.
   */
  judgeModel?: ModelChoice;
  /**
   * Whether conformance tests are written and run, and for what. true (`all`): every functional spec the code is built
   * from. "chosen": the ones with acceptance tests, and those the conversation chose with bind - kept once
   * their tests land. false: none, unless the conversation asks. Unset: all, when the module has test reqs.
   */
  conformanceTests?: boolean | "chosen";
  /**
   * Under `conformance-tests: chosen`: how many of a module's functional specs may be chosen for conformance tests, beside
   * those with acceptance tests - a count, or a share of the module's functional specs (rounded up, at least one).
   * Every choice for the module counts, whenever it was made; the person's own bind is not limited. Unset: no limit.
   */
  conformanceBudget?: { count: number } | { share: number };
  /**
   * Whether the code and its unit tests - and the conformance tests - are reviewed once they pass: two reviews at
   * most, the second weighed by the arbiter. false: the work goes on once its tests pass. Unset: true.
   */
  review?: boolean;
  /**
   * Whether turri stops a running job the spec has moved on from - a spec change, or a file it links edited - and
   * grows the spec as it now is instead. false: the job runs to its end and lands what it was growing, and what
   * changed since is grown on top of it by the next job: something lands as soon as it can, the software evolving
   * job by job. The person's own halt stops a job either way. Unset: true.
   */
  allowToStopJobs?: boolean;
  /**
   * Whether every pulse that lands code releases it as its last stage, before the module's next pulse starts - an agent
   * looking for the project's release guidance as the chat does, and doing what it says. Unset: false.
   */
  releaseAfterPulse?: boolean;
  /** Path from the root to the unit testing script. */
  unittestsScript?: string;
  /** Path from the root to the conformance testing script. */
  conformanceTestsScript?: string;
  /** Path from the root to the static checks script - optional: the coding agent's to run, never a gate. */
  staticChecksScript?: string;
  /**
   * What the testing scripts run on, on this machine: the code in place (the default) - as for an integration whose
   * scripts merge it into a host codebase - or a fresh copy of the code.
   */
  testingScriptsRunOn?: "copy" | "in-place";
  /** How many jobs run at once in the chat - modules that share nothing build side by side up to it. Unset: from the machine's memory. */
  parallelJobs?: number;
  /**
   * The ***plain authoring rules (genome/rules/<name>.md) left out of the conversation's prompt and every spec-writing
   * agent's, by name: a rule a project's own skills or AGENTS.md replace. The project's alone.
   */
  rulesOff?: string[];
  /**
   * Tokens of conversation - what an agent has done, past its instructions - after which an agent that keeps its
   * session through a job is compacted between turns. The project's alone. Unset: 100k.
   */
  compactAt?: number;
  /**
   * What passes through to the agents' commands beside the scrubbed environment: every variable of the dotenv `files`
   * (paths from the project root), and the `vars` named, from the environment turri was started in. A module's own are
   * added to the project's.
   */
  agentEnv?: { files: string[]; vars: string[] };
  /**
   * Folders of this machine an agent's commands may read beside the system's and the toolchains turri finds itself: a
   * toolchain installed somewhere unusual. A module's own are added to the project's.
   */
  toolchains?: string[];
  /** Each agent role's own model, thinking and turn limit; `default` for every role not named. */
  models?: Partial<Record<AgentRole | "default", RoleChoice>>;
  /** Seconds each turn of an agent a render starts has, for every role without its own. Unset: 120. 0: none. */
  turnLimit?: number;
}

/** The config keys, as written in the file. */
export const CONFIG_KEYS = {
  module: "module",
  harnessModel: "harness-model",
  codingModel: "coding-model",
  judgeModel: "judge-model",
  conformanceTests: "conformance-tests",
  conformanceBudget: "conformance-budget",
  review: "review",
  allowToStopJobs: "allow-to-stop-jobs",
  releaseAfterPulse: "release-after-pulse",
  unittestsScript: "unittests-script",
  conformanceTestsScript: "conformance-tests-script",
  staticChecksScript: "static-checks-script",
  testingScriptsRunOn: "testing-scripts-run-on",
  parallelJobs: "parallel-jobs",
  rulesOff: "rules-off",
  compactAt: "compact-at",
  agentEnv: "agent-env",
  toolchains: "toolchains",
  models: "models",
  turnLimit: "turn-limit",
} as const satisfies Record<keyof ProjectConfig, string>;

function whatScriptsRunOn(value: unknown): "copy" | "in-place" | undefined {
  return value === "copy" || value === "in-place" ? value : undefined;
}

/** `conformance-tests:` - true or all, chosen, false. Anything else is not read. */
function conformanceSetting(value: unknown): boolean | "chosen" | undefined {
  if (typeof value === "boolean") return value;
  const word = typeof value === "string" ? value.trim().toLowerCase() : undefined;
  return word === "all" ? true : word === "chosen" ? "chosen" : word === "false" ? false : word === "true" ? true : undefined;
}

/** `conformance-budget:` - a whole number, or a share such as `30%`. Anything else is not read. */
function budgetSetting(value: unknown): ProjectConfig["conformanceBudget"] {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return { count: value };
  const share = typeof value === "string" ? /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(value) : null;
  if (share !== null && Number(share[1]) <= 100) return { share: Number(share[1]) / 100 };
  return undefined;
}

/** How many functional specs a module of `count` may have chosen under a budget: the count, or the share rounded up - at least one. */
export function budgetFor(budget: NonNullable<ProjectConfig["conformanceBudget"]>, count: number): number {
  return "count" in budget ? budget.count : Math.max(1, Math.ceil(budget.share * count));
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * The project's config - with the module's own over it, when a module is named - or nothing of it
 * when there is no file or it does not parse.
 */
export function readProjectConfig(root: string, module?: string): ProjectConfig {
  const project = readConfigFile(join(root, CONFIG_FILE));
  if (module === undefined) return project;
  const own = readConfigFile(join(root, moduleConfigFile(module)));
  // The project's alone: one conversation, one module built when none is named.
  const merged: ProjectConfig = { ...project };
  for (const key of Object.keys(CONFIG_KEYS) as Array<keyof ProjectConfig>) {
    if (key === "module" || key === "harnessModel" || key === "parallelJobs" || key === "rulesOff" || key === "compactAt" || key === "toolchains" || key === "agentEnv" || own[key] === undefined) continue;
    (merged as Record<string, unknown>)[key] = own[key];
  }
  merged.agentEnv = joinAgentEnv(project.agentEnv, own.agentEnv);
  merged.toolchains = project.toolchains !== undefined && own.toolchains !== undefined ? [...new Set([...project.toolchains, ...own.toolchains])] : (own.toolchains ?? project.toolchains);
  merged.codingModel = inheritModel(own.codingModel, project.codingModel);
  merged.judgeModel = inheritModel(own.judgeModel, project.judgeModel);
  merged.models = joinModels(project.models, own.models);
  return withoutUndefined(merged);
}

/** A module's `models:` over the project's, role by role - each entry taking what it leaves out from the project's; the chat's the project's alone. */
function joinModels(project: ProjectConfig["models"], own: ProjectConfig["models"]): ProjectConfig["models"] {
  if (own === undefined) return project;
  const joined: NonNullable<ProjectConfig["models"]> = { ...(project ?? {}) };
  for (const [role, entry] of Object.entries(own) as Array<[AgentRole | "default", RoleChoice]>) {
    if (role === "chat") continue;
    const base = project?.[role];
    const choice = inheritModel(choiceOf(entry), choiceOf(base));
    const turnLimit = entry.turnLimit ?? base?.turnLimit;
    joined[role] = { ...(choice ?? {}), ...(turnLimit !== undefined ? { turnLimit } : {}) };
  }
  return joined;
}

/** A module's `agent-env:` added to the project's. */
function joinAgentEnv(project: ProjectConfig["agentEnv"], own: ProjectConfig["agentEnv"]): ProjectConfig["agentEnv"] {
  if (project === undefined || own === undefined) return own ?? project;
  return { files: [...new Set([...project.files, ...own.files])], vars: [...new Set([...project.vars, ...own.vars])] };
}

/** An `agent-env:` as the config gives it: dotenv files and variable names, or nothing when it names neither. */
function agentEnvSetting(value: unknown): ProjectConfig["agentEnv"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const list = (items: unknown) =>
    (Array.isArray(items) ? items : typeof items === "string" ? [items] : []).filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
  const raw = value as { files?: unknown; vars?: unknown };
  const setting = { files: list(raw.files), vars: list(raw.vars) };
  return setting.files.length > 0 || setting.vars.length > 0 ? setting : undefined;
}

function withoutUndefined(config: ProjectConfig): ProjectConfig {
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined)) as ProjectConfig;
}

/** The front matter of a .plain file, or nothing of it. */
function frontmatterOf(plainFile: string): Record<string, unknown> {
  try {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(plainFile, "utf8"));
    const parsed = match ? loadYaml(match[1]!) : undefined;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The module whose config file a module is built with: its own, or else the first down its
 * `requires` chain with one - found beside the spec, in its `template/`, or at the project root.
 * Nothing when none has one: the project's config.yaml alone.
 */
export function configModuleOf(root: string, plainFile: string): string | undefined {
  const withConfig = new Set(modulesWithConfig(root));
  if (withConfig.size === 0) return undefined;
  const seen = new Set<string>();
  const visit = (file: string): string | undefined => {
    const name = basename(file, ".plain");
    if (seen.has(name)) return undefined;
    seen.add(name);
    if (withConfig.has(name)) return name;
    const requires = frontmatterOf(file).requires;
    for (const required of Array.isArray(requires) ? requires : typeof requires === "string" ? [requires] : []) {
      if (typeof required !== "string") continue;
      const found = [dirname(file), join(dirname(file), "template"), root, join(root, "template")]
        .map((dir) => join(dir, `${required}.plain`))
        .find((candidate) => existsSync(candidate));
      const hit = found !== undefined ? visit(found) : withConfig.has(required) ? required : undefined;
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  return visit(resolve(plainFile));
}

/** The config a spec is built with: its project's, with its module's own over it. */
export function configForSpec(plainFile: string): ProjectConfig {
  const root = projectDirOf(resolve(plainFile));
  return readProjectConfig(root, configModuleOf(root, plainFile));
}

/** The config a module is built with, by its codebase's name - `plain_modules/<module>/code`. */
export function configModuleOfBuild(root: string, module: string): string | undefined {
  const plainFile = [root, join(root, "template")].map((dir) => join(dir, `${module}.plain`)).find((candidate) => existsSync(candidate));
  if (plainFile !== undefined) return configModuleOf(root, plainFile);
  return modulesWithConfig(root).includes(module) ? module : undefined;
}

/** One config file, read, or nothing of it when it is not there or does not parse. */
function readConfigFile(path: string): ProjectConfig {
  let parsed: unknown;
  try {
    if (!statSync(path).isFile()) return {};
    parsed = loadYaml(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const raw = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key.replace(/_/g, "-"), value]));
  const conformance = raw[CONFIG_KEYS.conformanceTests];
  return {
    module: text(raw[CONFIG_KEYS.module]),
    harnessModel: modelChoice(raw[CONFIG_KEYS.harnessModel]),
    codingModel: modelChoice(raw[CONFIG_KEYS.codingModel]) ?? modelChoice(raw.model),
    judgeModel: modelChoice(raw[CONFIG_KEYS.judgeModel]),
    conformanceTests: conformanceSetting(conformance),
    conformanceBudget: budgetSetting(raw[CONFIG_KEYS.conformanceBudget]),
    review: typeof raw[CONFIG_KEYS.review] === "boolean" ? (raw[CONFIG_KEYS.review] as boolean) : undefined,
    allowToStopJobs: typeof raw[CONFIG_KEYS.allowToStopJobs] === "boolean" ? (raw[CONFIG_KEYS.allowToStopJobs] as boolean) : undefined,
    releaseAfterPulse: typeof raw[CONFIG_KEYS.releaseAfterPulse] === "boolean" ? (raw[CONFIG_KEYS.releaseAfterPulse] as boolean) : undefined,
    unittestsScript: text(raw[CONFIG_KEYS.unittestsScript]),
    conformanceTestsScript: text(raw[CONFIG_KEYS.conformanceTestsScript]),
    staticChecksScript: text(raw[CONFIG_KEYS.staticChecksScript]),
    testingScriptsRunOn: whatScriptsRunOn(raw[CONFIG_KEYS.testingScriptsRunOn]),
    agentEnv: agentEnvSetting(raw[CONFIG_KEYS.agentEnv]),
    toolchains: Array.isArray(raw[CONFIG_KEYS.toolchains])
      ? (raw[CONFIG_KEYS.toolchains] as unknown[]).filter((path): path is string => typeof path === "string" && path.trim() !== "").map((path) => path.trim())
      : undefined,
    rulesOff: Array.isArray(raw[CONFIG_KEYS.rulesOff]) ? (raw[CONFIG_KEYS.rulesOff] as unknown[]).filter((name): name is string => typeof name === "string") : undefined,
    compactAt:
      typeof raw[CONFIG_KEYS.compactAt] === "number" && Number.isInteger(raw[CONFIG_KEYS.compactAt]) && (raw[CONFIG_KEYS.compactAt] as number) >= 1000
        ? (raw[CONFIG_KEYS.compactAt] as number)
        : undefined,
    parallelJobs:
      typeof raw[CONFIG_KEYS.parallelJobs] === "number" && Number.isInteger(raw[CONFIG_KEYS.parallelJobs]) && (raw[CONFIG_KEYS.parallelJobs] as number) >= 1
        ? (raw[CONFIG_KEYS.parallelJobs] as number)
        : undefined,
    models: modelsSetting(raw[CONFIG_KEYS.models]),
    turnLimit: turnLimitSetting(raw[CONFIG_KEYS.turnLimit]),
  };
}
