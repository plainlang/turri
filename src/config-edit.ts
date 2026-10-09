import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { adoptLegacyConfig, AGENT_ROLES, CONFIG_FILE, chosenStack, projectConfigFile, stackConfigFileIn, stacksOf, splitModelSpec, THINKING_LEVELS } from "./config.ts";

/**
 * `/turri-config`'s side of config.turri.yaml: every setting turri reads, what it takes - a yes or no, one of a few words, a
 * number, a model, a list - and when a change to it takes effect, so the person knows whether to wait for the next
 * pulse or not at all. A change is written into the file line by line, its comments and the commented-out examples
 * kept; `models:` and `agent-env:`, which nest, are written again whole, their own comments lost.
 */

/** When a change takes effect. Nothing turri reads needs a restart: what is fixed at its start is changed live. */
export type Effect = "now" | "next-message" | "next-pulse" | "next-plan" | "next-test-run" | "next-landing" | "next-regrow";

export type SettingKind = "boolean" | "choice" | "number" | "model" | "list" | "path" | "budget";

export interface Setting {
  /** As written in the file - a nested one by its path: `models.coding`, `models.coding.turn-limit`, `agent-env.files`. */
  key: string;
  /** What it does, in a line. */
  about: string;
  kind: SettingKind;
  /** What it is when it is not set. */
  unset: string;
  effect: Effect;
  /** The words it takes (choice), or the values offered first (number, budget, list). */
  options?: string[];
  /** The least a number may be. */
  min?: number;
  /** Set in the project's config.turri.yaml only: a stack's file does not change it. */
  projectOnly?: boolean;
}

/** What each effect is, said to the person. */
export const EFFECT_TEXT: Record<Effect, string> = {
  now: "in effect now",
  "next-message": "in effect from your next message",
  "next-pulse": "in effect from the next pulse - one running now keeps what it started with",
  "next-plan": "in effect the next time the work is planned - at the next pulse",
  "next-test-run": "in effect from the next test run - the running pulse's too",
  "next-landing": "in effect from the next pulse that lands - the running one too",
  "next-regrow": "in effect for the next regrow that names no .plain file",
};

const SECONDS = ["0", "60", "120", "180", "300"];

/** A role's line: which agents it is, for the list. */
const ROLE_ABOUT: Record<(typeof AGENT_ROLES)[number] | "default", string> = {
  default: "every role not named",
  chat: "the conversation - as harness-model, which it wins over",
  chooser: "chooses what gets conformance tests under turri regrow",
  planner: "cuts the work into pulses",
  diagnosis: "looks into a pulse that failed for good",
  release: "the release agent",
  coding: "writes the code - as coding-model, which it wins over",
  conformance: "writes the conformance tests",
  explorer: "explores the code for a conformance run",
  reviewer: "reviews the code and its unit tests",
  "test-reviewer": "reviews the conformance tests",
  judge: "judges a failing conformance run - as judge-model, which it wins over",
  arbiter: "weighs a second review",
  debugger: "a fresh look at unit tests that keep failing the same way",
};

/** Every setting, in the order the list shows them. */
export function settings(rules: string[] = []): Setting[] {
  const roles = (["default", ...AGENT_ROLES] as const).flatMap((role): Setting[] => [
    {
      key: `models.${role}`,
      about: `the ${role} role's model and thinking - ${ROLE_ABOUT[role]}`,
      kind: "model",
      unset: role === "default" ? "harness-model's, for the conversation's side; coding-model's for the rest" : "default's",
      effect: role === "chat" ? "now" : "next-pulse",
      ...(role === "chat" ? { projectOnly: true } : {}),
    },
    {
      key: `models.${role}.turn-limit`,
      about: `seconds each turn of the ${role} role's agents has - 0 for none`,
      kind: "number",
      unset: "default's, else turn-limit",
      effect: "next-pulse",
      options: SECONDS,
      min: 0,
    },
  ]);
  return [
    { key: "harness-model", about: "the model you talk to: it writes the specs and plans the work", kind: "model", unset: "pi's own choice", effect: "now", projectOnly: true },
    { key: "coding-model", about: "the model that writes the code", kind: "model", unset: "harness-model", effect: "next-pulse" },
    { key: "judge-model", about: "the judge and the test review of a conformance run", kind: "model", unset: "coding-model", effect: "next-pulse" },
    { key: "module", about: "the .plain file turri regrow builds when none is named", kind: "path", unset: "the folder's .plain files", effect: "next-regrow", projectOnly: true },
    { key: "conformance-tests", about: "which functional specs get conformance tests", kind: "choice", options: ["all", "chosen", "false"], unset: "all, where a module has test reqs", effect: "next-plan" },
    { key: "conformance-budget", about: "under conformance-tests: chosen, how many may be chosen - a count or a share", kind: "budget", options: ["10%", "30%", "50%", "5", "10"], unset: "no limit", effect: "next-plan" },
    { key: "review", about: "whether the code and its tests are reviewed once they pass", kind: "boolean", unset: "true", effect: "next-pulse" },
    { key: "allow-to-stop-jobs", about: "whether turri stops a running pulse the spec has moved on from", kind: "boolean", unset: "true", effect: "now" },
    { key: "release-after-pulse", about: "whether every pulse that lands code releases it", kind: "boolean", unset: "false", effect: "next-landing" },
    { key: "unittests-script", about: "the unit testing script, by path from the project root", kind: "path", unset: "the one run_unittests*.sh found", effect: "next-test-run" },
    { key: "conformance-tests-script", about: "the conformance testing script, by path from the project root", kind: "path", unset: "the one run_conformance_tests*.sh found", effect: "next-test-run" },
    { key: "prepare-environment-script", about: "run on the build before every conformance testing script run, by path from the project root - optional", kind: "path", unset: "the one prepare_environment*.sh found, else none", effect: "next-test-run" },
    { key: "static-checks-script", about: "the static checks script, by path from the project root - optional", kind: "path", unset: "the one run_static_checks*.sh found", effect: "next-test-run" },
    { key: "testing-scripts-run-on", about: "what the testing scripts run on: the code itself, or a fresh copy", kind: "choice", options: ["in-place", "copy"], unset: "in-place", effect: "next-test-run" },
    { key: "parallel-jobs", about: "how many pulses run at once, on modules that share nothing", kind: "number", options: ["1", "2", "3", "4", "6"], min: 1, unset: "half this machine's cores, one to four", effect: "now", projectOnly: true },
    { key: "max-specs-per-pulse", about: "the most functional specs the planner groups into one pulse", kind: "number", options: ["1", "2", "3", "4", "5", "6"], min: 1, unset: "3", effect: "next-plan" },
    { key: "max-lines-per-pulse", about: "the most lines of spec in one pulse before a group is split", kind: "number", options: ["60", "120", "200", "300"], min: 1, unset: "120", effect: "next-plan" },
    { key: "turn-limit", about: "seconds each agent turn has, for every role without its own - 0 for none", kind: "number", options: SECONDS, min: 0, unset: "120", effect: "next-pulse" },
    { key: "compact-at", about: "tokens of work an agent holds before it is compacted between turns", kind: "number", options: ["50000", "100000", "150000", "200000"], min: 1000, unset: "100000", effect: "next-pulse", projectOnly: true },
    { key: "rules-off", about: "***plain rules left out of the spec-writing agents' prompts", kind: "list", options: rules, unset: "none", effect: "next-message", projectOnly: true },
    { key: "agent-env.files", about: "dotenv files whose variables the agents' commands get", kind: "list", unset: "none", effect: "next-pulse", projectOnly: true },
    { key: "agent-env.vars", about: "variables from turri's environment the agents' commands get, by name", kind: "list", unset: "none", effect: "next-pulse", projectOnly: true },
    { key: "toolchains", about: "folders of this machine an agent's commands may read beside the usual ones", kind: "list", unset: "none", effect: "next-pulse", projectOnly: true },
    ...roles,
  ];
}

/** A setting by its key - `review`, `models.coding` - or nothing. */
export function settingOf(key: string, rules: string[] = []): Setting | undefined {
  return settings(rules).find((setting) => setting.key === key.trim().toLowerCase().replace(/_/g, "-"));
}

/** A value read from what was typed: what to write, or that it is to be unset, or why it cannot be. */
export type Parsed = { value: unknown } | { unset: true } | { error: string };

/** The words that unset a setting. */
const UNSET = new Set(["unset", "default", "none", "-"]);

/**
 * What was typed for a setting, read as the file takes it: `true`/`false`, one of its words, a number at least its least,
 * a model `provider/id` with an optional `:thinking`, a list by commas. `known`: whether a model can be reached here -
 * when it is given, one that cannot is refused.
 */
export function parseValue(setting: Setting, typed: string, known?: (model: string) => boolean): Parsed {
  const text = typed.trim();
  if (UNSET.has(text.toLowerCase())) return { unset: true };
  if (text === "") return { error: `${setting.key} needs a value - or unset, for ${setting.unset}.` };
  switch (setting.kind) {
    case "boolean": {
      const word = text.toLowerCase();
      if (["true", "yes", "on"].includes(word)) return { value: true };
      if (["false", "no", "off"].includes(word)) return { value: false };
      return { error: `${setting.key} is true or false.` };
    }
    case "choice": {
      const word = text.toLowerCase();
      if (setting.options?.includes(word)) return { value: setting.key === "conformance-tests" && word === "false" ? false : word };
      return { error: `${setting.key} is one of ${setting.options?.join(", ")}.` };
    }
    case "number": {
      const number = Number(text);
      if (!Number.isInteger(number) || number < (setting.min ?? 0)) return { error: `${setting.key} is a whole number of at least ${setting.min ?? 0}.` };
      return { value: number };
    }
    case "budget": {
      if (/^\d+$/.test(text)) return { value: Number(text) };
      const share = /^(\d+(?:\.\d+)?)\s*%$/.exec(text);
      if (share !== null && Number(share[1]) <= 100) return { value: `${share[1]}%` };
      return { error: `${setting.key} is a count, such as 5, or a share, such as 30%.` };
    }
    case "model": {
      const { model, thinking } = splitModelSpec(text);
      const colon = text.lastIndexOf(":");
      if (colon !== -1 && thinking === undefined && !text.slice(colon + 1).includes("/")) {
        return { error: `How hard it thinks is one of ${THINKING_LEVELS.join(", ")}: ${text.slice(colon + 1)} is not.` };
      }
      if (model === undefined) return { error: `${setting.key} is a model, provider/id - with :thinking if you like, such as :low.` };
      if (!model.includes("/")) return { error: `A model is written provider/id, such as anthropic/claude-opus-5-5: ${model} is not.` };
      if (known !== undefined && !known(model)) return { error: `${model} is not a model turri can reach here - sign in to its provider, or choose another.` };
      return { value: text };
    }
    case "list": {
      const items = text.split(",").map((item) => item.trim()).filter((item) => item !== "");
      if (setting.options !== undefined && setting.options.length > 0) {
        const unknown = items.filter((item) => !setting.options!.includes(item));
        if (unknown.length > 0) return { error: `Not one of ${setting.key}'s: ${unknown.join(", ")}. It takes ${setting.options.join(", ")}.` };
      }
      return { value: items };
    }
    case "path":
      return { value: text };
  }
}

/** The file's top-level mapping, or nothing of it. */
function loadMapping(text: string): Record<string, unknown> {
  try {
    const parsed = loadYaml(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A value as one YAML line's: `true`, `30%`, `[a, b]`, `anthropic/claude-opus-5-5:low`. */
function inline(value: unknown): string {
  return dumpYaml(value, { flowLevel: 0, lineWidth: -1 }).trim();
}

/** Where a top-level key is in the lines: its line and the end of what is indented under it. */
function blockOf(lines: string[], key: string): { at: number; end: number } | undefined {
  const at = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (at === -1) return undefined;
  let end = at + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end]!) && !/^\s*#/.test(lines[end]!)) end += 1;
  return { at, end };
}

/**
 * The file with a top-level key set to these lines, or taken out (`undefined`): in its place, its trailing comment kept
 * on a one-line value; a key not there goes under its commented-out example, else at the end.
 */
function withTopLevel(text: string, key: string, block: string[] | undefined): string {
  const lines = text.split("\n");
  const found = blockOf(lines, key);
  if (found !== undefined) {
    const comment = found.end - found.at === 1 && block?.length === 1 ? /\s+#.*$/.exec(lines[found.at]!.replace(/"[^"]*"|'[^']*'/g, ""))?.[0] : undefined;
    const replaced = block === undefined ? [] : comment !== undefined ? [`${block[0]}${comment}`] : block;
    return [...lines.slice(0, found.at), ...replaced, ...lines.slice(found.end)].join("\n");
  }
  if (block === undefined) return text;
  const example = lines.findIndex((line) => new RegExp(`^#\\s?${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`).test(line));
  if (example !== -1) {
    let end = example + 1;
    while (end < lines.length && /^#\s{2,}\S/.test(lines[end]!)) end += 1;
    return [...lines.slice(0, end), ...block, ...lines.slice(end)].join("\n");
  }
  const body = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  return `${body}${block.join("\n")}\n`;
}

/** A role's entry under `models:` - a model string, or `model`, `thinking` and `turn-limit` - as one object. */
function roleEntry(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const { model, thinking } = splitModelSpec(value);
    return { ...(model !== undefined ? { model } : {}), ...(thinking !== undefined ? { thinking } : {}) };
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

/** A role's entry as written: the model string alone when it has no turn limit, else the object - nothing when empty. */
function writtenEntry(entry: Record<string, unknown>): unknown {
  const turnLimit = entry["turn-limit"] ?? entry.turn_limit;
  const model = typeof entry.model === "string" ? entry.model : undefined;
  const thinking = typeof entry.thinking === "string" ? entry.thinking : undefined;
  if (turnLimit === undefined) {
    if (model === undefined && thinking === undefined) return undefined;
    return `${model ?? ""}${thinking !== undefined ? `:${thinking}` : ""}`;
  }
  return { ...(model !== undefined ? { model } : {}), ...(thinking !== undefined ? { thinking } : {}), "turn-limit": turnLimit };
}

/** The file with a top-level key set to a value as it is - a block, such as `models:`, written whole - in its line, or under its commented-out example. */
export function withTopLevelValue(text: string, key: string, value: unknown): string {
  const block = value !== null && typeof value === "object" && !Array.isArray(value);
  return withTopLevel(text, key, block ? dumpYaml({ [key]: value }, { flowLevel: 2, lineWidth: -1 }).trimEnd().split("\n") : [`${key}: ${inline(value)}`]);
}

/**
 * The file with a setting set to a value, or unset (`undefined`). A top-level one is changed in its line; one under
 * `models:` or `agent-env:` has that block written again whole.
 */
export function withSetting(text: string, key: string, value: unknown): string {
  const [top, ...path] = key.split(".");
  if (path.length === 0) return withTopLevel(text, top!, value === undefined ? undefined : [`${top}: ${inline(value)}`]);
  const current = loadMapping(text)[top!];
  const block: Record<string, unknown> = current !== null && typeof current === "object" && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
  if (top === "models") {
    const [role, field] = path as [string, string | undefined];
    const entry = roleEntry(block[role]);
    if (field === "turn-limit") {
      delete entry.turn_limit;
      if (value === undefined) delete entry["turn-limit"];
      else entry["turn-limit"] = value;
    } else {
      delete entry.model;
      delete entry.thinking;
      if (value !== undefined) Object.assign(entry, roleEntry(value));
    }
    const written = writtenEntry(entry);
    if (written === undefined) delete block[role];
    else block[role] = written;
  } else {
    const field = path[0]!;
    if (value === undefined) delete block[field];
    else block[field] = value;
  }
  if (Object.keys(block).length === 0) return withTopLevel(text, top!, undefined);
  const lines = dumpYaml({ [top!]: block }, { flowLevel: 2, lineWidth: -1 }).trimEnd().split("\n");
  return withTopLevel(text, top!, lines);
}

/** A setting's value as the file has it - the raw value, before turri reads it - or undefined when it is not set. */
export function currentValue(text: string, key: string): unknown {
  const [top, ...path] = key.split(".");
  const value = loadMapping(text)[top!];
  if (path.length === 0) return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const block = value as Record<string, unknown>;
  if (top === "models") {
    const raw = block[path[0]!];
    if (raw === undefined) return undefined;
    const entry = roleEntry(raw);
    if (path[1] === "turn-limit") return entry["turn-limit"] ?? entry.turn_limit;
    return writtenEntry({ model: entry.model, thinking: entry.thinking });
  }
  return block[path[0]!];
}

/** A value for showing: `true`, `anthropic/claude-opus-5-5:low`, `[.env, .env.local]`. */
export function shownValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const entry = value as Record<string, unknown>;
    return `${entry.model ?? ""}${entry.thinking !== undefined ? `:${entry.thinking}` : ""}`;
  }
  return inline(value);
}

/** The project's config.turri.yaml - or the config.yaml it is read from until it has one - its text, empty when there is neither. */
export function readConfigText(dir: string): string {
  const path = join(dir, projectConfigFile(dir));
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** What a change does beside setting the value: the files and settings that win over it, said to the person. */
export function overriddenBy(dir: string, text: string, setting: Setting): string[] {
  const notes: string[] = [];
  const wins: Record<string, string> = { "harness-model": "models.chat", "coding-model": "models.coding", "judge-model": "models.judge" };
  const over = wins[setting.key];
  if (over !== undefined && currentValue(text, over) !== undefined) notes.push(`${over} is set too, and wins over ${setting.key} - change it with /turri-config ${over}.`);
  if (setting.projectOnly === true) return notes;
  const top = setting.key.split(".")[0]!;
  for (const stack of stacksOf(dir)) {
    const file = stackConfigFileIn(dir, stack);
    const own = loadMapping(safeRead(join(dir, file)))[top];
    if (own !== undefined) notes.push(`${file} sets ${top} too, and wins while the stack ${stack} is chosen${chosenStack() === stack ? " - as it is now" : ""}.`);
  }
  return notes;
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Write a setting into the project's config.turri.yaml - made when it is not there, from config.yaml and each stack's
 * file in the old naming when they are what the project is read from - and give back the file as written.
 */
export function writeSetting(dir: string, key: string, value: unknown): string {
  adoptLegacyConfig(dir);
  const text = withSetting(readConfigText(dir), key, value);
  writeFileSync(join(dir, CONFIG_FILE), text);
  return text;
}

/** The files a path setting is offered: the testing scripts in the root and test_scripts/, or the .plain files of the folder. */
export function pathOptions(dir: string, key: string): string[] {
  const list = (folder: string, test: (name: string) => boolean) => {
    try {
      return readdirSync(join(dir, folder))
        .filter((name) => test(name) && statSync(join(dir, folder, name)).isFile())
        .map((name) => (folder === "" ? name : `${folder}/${name}`));
    } catch {
      return [];
    }
  };
  if (key === "module") return list("", (name) => name.endsWith(".plain")).sort();
  const prefix =
    key === "unittests-script" ? "run_unittests" : key === "conformance-tests-script" ? "run_conformance_tests" : key === "prepare-environment-script" ? "prepare_environment" : "run_static_checks";
  const script = (name: string) => name.startsWith(prefix) && /\.(sh|ps1)$/.test(name);
  return [...list("", script), ...list("test_scripts", script)].sort();
}

/** The dotenv files of the project root, for agent-env.files. */
export function dotenvFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => /^\.env(\..+)?$/.test(name)).sort();
  } catch {
    return [];
  }
}
