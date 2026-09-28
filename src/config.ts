import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";

/**
 * The project's `config.yaml`, at its root - the folder that holds `plain_modules`.
 *
 * One file for what a project says about how it is built:
 *
 * ```yaml
 * module: prism_cli.plain                                   # what `plainwright module` builds by default
 * harness-model:                                            # the model you chat with in `plainwright chat`
 *   model: anthropic/claude-opus-5-5
 *   thinking: high
 * coding-model:                                             # the rendering agents (default: harness-model)
 *   model: google/gemini-3.1-flash
 *   thinking: medium
 * judge-model:                                              # the judge and the test review (default: coding-model)
 *   model: google/gemini-3.1-pro
 * conformance-tests: false                                  # write and run conformance tests (default: when there are test reqs)
 * unittests-script: test_scripts/run_unittests.sh           # the testing scripts - see test-scripts.ts
 * conformance-tests-script: test_scripts/run_conformance_tests.sh
 * testing-scripts: host                                     # where they run: in the VM (default), or on this machine - see test-scripts.ts
 * ```
 *
 * Each model is a model reference and a thinking level (off, minimal, low, medium, high, xhigh, max),
 * either of which may be left out; a bare string is the model alone. What a model leaves out it takes
 * from the one it inherits: judge-model from coding-model, coding-model from harness-model. They are
 * defaults: `--harness-model` / `--coding-model` / `--judge-model` on the command line win over them,
 * and so does a model chosen during the conversation (pi's /model, set_render_model). `model:` is read
 * as `coding-model`, which it was before there were two.
 *
 * Keys are written with dashes; underscores are read the same (`conformance_tests`). Keys it
 * does not know - a codeplain `config.yaml` carries several - are ignored, and so is a value of
 * the wrong type. Everything is optional, and what is given on the command line wins.
 */

export const CONFIG_FILE = "config.yaml";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** A model, and how hard it thinks - either may be left to the one it inherits from. */
export interface ModelChoice {
  /** "provider/model-id". */
  model?: string;
  thinking?: ThinkingLevel;
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

/** The three models as they hold: the judge inherits from the coding model, the coding model from the harness model. */
export function projectModels(config: Pick<ProjectConfig, "harnessModel" | "codingModel" | "judgeModel">): {
  harness?: ModelChoice;
  coding?: ModelChoice;
  judge?: ModelChoice;
} {
  const harness = config.harnessModel;
  const coding = inheritModel(config.codingModel, harness);
  return { harness, coding, judge: inheritModel(config.judgeModel, coding) };
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

export interface ProjectConfig {
  /** The .plain file the module command builds when it is given none. */
  module?: string;
  /** The model `plainwright chat` starts with: the one the person talks to. */
  harnessModel?: ModelChoice;
  /** The model the rendering agents run on - every render, conformance, repair and spec change. Unset: the harness model. */
  codingModel?: ModelChoice;
  /**
   * The model of the agents that give a verdict in a conformance run - the judge, which says whether
   * the code, the tests or the spec is wrong, and the test review. Unset: the coding model.
   */
  judgeModel?: ModelChoice;
  /** Whether conformance tests are written and run. Unset: when the module has test reqs. */
  conformanceTests?: boolean;
  /** Path from the root to the unit testing script. */
  unittestsScript?: string;
  /** Path from the root to the conformance testing script. */
  conformanceTestsScript?: string;
  /**
   * Where the harness runs the testing scripts: in the sandbox VM (the default), or in place on
   * this machine - for an integration embedded in a host codebase the VM does not hold.
   */
  testingScripts?: "vm" | "host";
}

/** The config keys, as written in the file. */
export const CONFIG_KEYS = {
  module: "module",
  harnessModel: "harness-model",
  codingModel: "coding-model",
  judgeModel: "judge-model",
  conformanceTests: "conformance-tests",
  unittestsScript: "unittests-script",
  conformanceTestsScript: "conformance-tests-script",
  testingScripts: "testing-scripts",
} as const satisfies Record<keyof ProjectConfig, string>;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The project's config, or nothing of it when there is no file or it does not parse. */
export function readProjectConfig(root: string): ProjectConfig {
  const path = join(root, CONFIG_FILE);
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
    conformanceTests: typeof conformance === "boolean" ? conformance : undefined,
    unittestsScript: text(raw[CONFIG_KEYS.unittestsScript]),
    conformanceTestsScript: text(raw[CONFIG_KEYS.conformanceTestsScript]),
    testingScripts: raw[CONFIG_KEYS.testingScripts] === "host" ? "host" : raw[CONFIG_KEYS.testingScripts] === "vm" ? "vm" : undefined,
  };
}
