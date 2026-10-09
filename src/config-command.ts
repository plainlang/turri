import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_FILE, LEGACY_CONFIG_FILE, THINKING_LEVELS, usesLegacyConfig } from "./config.ts";
import {
  currentValue,
  dotenvFiles,
  EFFECT_TEXT,
  overriddenBy,
  parseValue,
  pathOptions,
  readConfigText,
  settingOf,
  settings,
  shownValue,
  writeSetting,
  type Setting,
} from "./config-edit.ts";

/**
 * `/turri-config`: every setting of the project's config.turri.yaml from the chat - `/turri-config` alone lists them,
 * `/turri-config review` asks for review's value, `/turri-config review false` sets it. Each is written into the file
 * and takes effect as it says - now, at your next message, at the next pulse - never only once turri starts again:
 * what turri fixes at its start is changed live here (live).
 */

/** What a change does to turri as it runs, beside the file: each says what it did, or nothing. */
export interface LiveHooks {
  /** The chat's model is now this - provider/id:thinking - or, undefined, no longer set in the file. */
  chatModel(spec: string | undefined, ctx: ExtensionContext): Promise<string | undefined>;
  /** The coding model changed in the file: one chosen this session - --coding-model, engine - gives way to it. */
  codingModel(): string | undefined;
  /** How many pulses run at once: the number, or the machine's default. */
  parallelJobs(count: number | undefined): string | undefined;
}

export interface TurriConfigOptions {
  /** The folder whose config.turri.yaml the chat reads. */
  cwd: string;
  /** The ***plain rules there are, by name - what rules-off takes. */
  rules: () => string[];
  /** The chat's model, provider/id:thinking, after a change - read as the file has it now. */
  chatSpec: () => string | undefined;
  live: LiveHooks;
}

/** The option that unsets a setting, for a setting. */
const unsetOption = (setting: Setting) => `unset - ${setting.unset}`;
const TYPE_ANOTHER = "type another…";
const DONE = "done";
const ROLES_ENTRY = "models.<role> - each agent role's own model, thinking and turn limit…";

/** The models pi can reach here, signed in: provider/id. */
function reachable(ctx: ExtensionContext | undefined): string[] {
  try {
    return (ctx?.modelRegistry.getAvailable() ?? []).map((model) => `${model.provider}/${model.id}`).sort();
  } catch {
    return [];
  }
}

/** A setting's line in the list: its key, what it is now - or what it is unset - and what it does. */
function listLine(setting: Setting, text: string): string {
  const value = currentValue(text, setting.key);
  return `${setting.key}: ${value === undefined ? `(unset - ${setting.unset})` : shownValue(value)}`;
}

export function registerTurriConfig(pi: ExtensionAPI, options: TurriConfigOptions): void {
  const { cwd } = options;
  // The models for completions, which are given no context: the last one seen.
  let seen: ExtensionContext | undefined;
  pi.on("session_start", (_event, ctx) => {
    seen = ctx;
  });

  /** Set a setting to what was typed - or unset it - and say what it did and when it takes effect. */
  const apply = async (setting: Setting, typed: string, ctx: ExtensionContext): Promise<void> => {
    const models = reachable(ctx);
    const parsed = parseValue(setting, typed, models.length > 0 ? (model) => models.includes(model) : undefined);
    if ("error" in parsed) {
      ctx.ui.notify(parsed.error, "error");
      return;
    }
    const value = "unset" in parsed ? undefined : parsed.value;
    // The first setting written where the project is still read from config.yaml: copied to config.turri.yaml first.
    const adopting = usesLegacyConfig(cwd);
    const text = writeSetting(cwd, setting.key, value);
    const notes: string[] = [];
    // What turri fixed at its start, changed now.
    if (setting.key === "harness-model" || setting.key === "models.chat") {
      const said = await options.live.chatModel(options.chatSpec(), ctx);
      if (said !== undefined) notes.push(said);
    }
    if (setting.key === "coding-model" || setting.key === "models.coding" || setting.key === "models.default") {
      const said = options.live.codingModel();
      if (said !== undefined) notes.push(said);
    }
    if (setting.key === "parallel-jobs") {
      const said = options.live.parallelJobs(typeof value === "number" ? value : undefined);
      if (said !== undefined) notes.push(said);
    }
    if (adopting) notes.push(`${LEGACY_CONFIG_FILE} was copied to ${CONFIG_FILE} first - turri reads its own file from now on, and leaves ${LEGACY_CONFIG_FILE} as it is.`);
    notes.push(...overriddenBy(cwd, text, setting));
    const what = value === undefined ? `${setting.key} unset - ${setting.unset}` : `${setting.key}: ${shownValue(value)}`;
    ctx.ui.notify([`${what} - written to ${CONFIG_FILE}, ${EFFECT_TEXT[setting.effect]}.`, ...notes].join("\n"), "info");
  };

  /** Ask for a setting's value, as its kind takes it: what is typed comes back, or nothing when the dialog is left. */
  const askValue = async (setting: Setting, ctx: ExtensionContext): Promise<string | undefined> => {
    const text = readConfigText(cwd);
    const now = currentValue(text, setting.key);
    const title = `${setting.key} - ${setting.about}\nNow: ${now === undefined ? `unset - ${setting.unset}` : shownValue(now)}`;
    const pick = async (choices: string[], typed = true): Promise<string | undefined> => {
      const offered = [...choices, ...(typed ? [TYPE_ANOTHER] : []), unsetOption(setting)];
      const chosen = await ctx.ui.select(title, offered);
      if (chosen === undefined) return undefined;
      if (chosen === unsetOption(setting)) return "unset";
      if (chosen === TYPE_ANOTHER) return ctx.ui.input(title, setting.kind === "path" ? "path from the project root" : "value");
      return chosen;
    };
    switch (setting.kind) {
      case "boolean":
        return pick(["true", "false"], false);
      case "choice":
        return pick(setting.options ?? [], false);
      case "number":
      case "budget":
        return pick(setting.options ?? []);
      case "path":
        return pick(pathOptions(cwd, setting.key));
      case "model": {
        const model = await pick(reachable(ctx));
        // Typed with its level - provider/id:low - it is whole already.
        if (model === undefined || model === "unset" || model.includes(":")) return model;
        const level = await ctx.ui.select(`${model} - how hard it thinks`, [...THINKING_LEVELS, "the role's own level"]);
        if (level === undefined) return undefined;
        return level === "the role's own level" ? model : `${model}:${level}`;
      }
      case "list": {
        const choices = setting.key === "agent-env.files" ? dotenvFiles(cwd) : (setting.options ?? []);
        if (choices.length === 0) {
          const typed = await ctx.ui.input(`${title}\nType them, separated by commas - or unset.`, Array.isArray(now) ? now.join(", ") : "");
          return typed;
        }
        // A tick a chosen one: pick to turn one on or off, done to keep them.
        const chosen = new Set(Array.isArray(now) ? (now as unknown[]).map(String) : []);
        for (;;) {
          const offered = [DONE, ...choices.map((choice) => `${chosen.has(choice) ? "✓" : " "} ${choice}`), unsetOption(setting)];
          const picked = await ctx.ui.select(`${title}\nPick to turn one on or off, then done.`, offered);
          if (picked === undefined) return undefined;
          if (picked === unsetOption(setting)) return "unset";
          if (picked === DONE) return chosen.size === 0 ? "unset" : [...chosen].join(", ");
          const name = picked.slice(2);
          if (chosen.has(name)) chosen.delete(name);
          else chosen.add(name);
        }
      }
    }
  };

  /** Pick a setting from the list - the models of each role behind one entry. */
  const askSetting = async (ctx: ExtensionContext): Promise<Setting | undefined> => {
    const text = readConfigText(cwd);
    const all = settings(options.rules());
    const top = all.filter((setting) => !setting.key.startsWith("models."));
    const lines = [...top.map((setting) => listLine(setting, text)), ROLES_ENTRY];
    const chosen = await ctx.ui.select(`/turri-config - the project's ${CONFIG_FILE}. Pick a setting to change:`, lines);
    if (chosen === undefined) return undefined;
    if (chosen === ROLES_ENTRY) {
      const roles = all.filter((setting) => setting.key.startsWith("models."));
      const role = await ctx.ui.select("Which role's model or turn limit?", roles.map((setting) => listLine(setting, text)));
      return role === undefined ? undefined : roles.find((setting) => role.startsWith(`${setting.key}:`));
    }
    return top.find((setting) => chosen.startsWith(`${setting.key}:`));
  };

  pi.registerCommand("turri-config", {
    description: `Change a setting of the project's ${CONFIG_FILE}`,
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const all = settings(options.rules());
      const space = prefix.indexOf(" ");
      if (space === -1) {
        const items = all.filter((setting) => setting.key.startsWith(prefix.trim().toLowerCase()));
        return items.length === 0 ? null : items.map((setting) => ({ value: `${setting.key} `, label: setting.key, description: setting.about }));
      }
      const setting = settingOf(prefix.slice(0, space), options.rules());
      if (setting === undefined) return null;
      const typed = prefix.slice(space + 1).trimStart();
      const candidates =
        setting.kind === "boolean"
          ? ["true", "false"]
          : setting.kind === "model"
            ? typed.includes(":")
              ? THINKING_LEVELS.map((level) => `${typed.slice(0, typed.lastIndexOf(":"))}:${level}`)
              : reachable(seen)
            : setting.kind === "path"
              ? pathOptions(cwd, setting.key)
              : setting.key === "agent-env.files"
                ? dotenvFiles(cwd)
                : (setting.options ?? []);
      const items = [...candidates, "unset"].filter((candidate) => candidate.startsWith(typed)).slice(0, 40);
      return items.length === 0 ? null : items.map((candidate) => ({ value: `${setting.key} ${candidate}`, label: candidate }));
    },
    handler: async (args, ctx) => {
      seen = ctx;
      const typed = args.trim();
      const space = typed.indexOf(" ");
      const key = space === -1 ? typed : typed.slice(0, space);
      const value = space === -1 ? "" : typed.slice(space + 1).trim();
      if (!ctx.hasUI && (key === "" || value === "")) return;
      let setting: Setting | undefined;
      if (key === "") {
        setting = await askSetting(ctx);
        if (setting === undefined) return;
      } else {
        setting = settingOf(key, options.rules());
        if (setting === undefined) {
          const near = settings(options.rules()).filter((entry) => entry.key.includes(key.toLowerCase())).map((entry) => entry.key);
          ctx.ui.notify(`No setting ${key}.${near.length > 0 ? ` Did you mean ${near.slice(0, 5).join(", ")}?` : " /turri-config alone lists them."}`, "error");
          return;
        }
      }
      const given = value !== "" ? value : await askValue(setting, ctx);
      if (given === undefined) return;
      await apply(setting, given, ctx);
    },
  });
}
