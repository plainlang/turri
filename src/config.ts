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
 * harness-model: anthropic/claude-opus-5-5                  # the model you chat with in `plainwright chat`
 * coding-model: google/gemini-3.1-flash                     # the model the rendering agents run on
 * conformance-tests: false                                  # write and run conformance tests (default: when there are test reqs)
 * unittests-script: test_scripts/run_unittests.sh           # the testing scripts - see test-scripts.ts
 * conformance-tests-script: test_scripts/run_conformance_tests.sh
 * testing-scripts: host                                     # where they run: in the VM (default), or on this machine - see test-scripts.ts
 * ```
 *
 * Both models are defaults: `--harness-model` / `--coding-model` on the command line win over them,
 * and so does a model chosen during the conversation (pi's /model, set_render_model). `model:` is
 * read as `coding-model`, which it was before there were two.
 *
 * Keys are written with dashes; underscores are read the same (`conformance_tests`). Keys it
 * does not know - a codeplain `config.yaml` carries several - are ignored, and so is a value of
 * the wrong type. Everything is optional, and what is given on the command line wins.
 */

export const CONFIG_FILE = "config.yaml";

export interface ProjectConfig {
  /** The .plain file the module command builds when it is given none. */
  module?: string;
  /** The model `plainwright chat` starts with: the one the person talks to. */
  harnessModel?: string;
  /** The model the rendering agents run on - every render, conformance, repair and spec change. */
  codingModel?: string;
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
    harnessModel: text(raw[CONFIG_KEYS.harnessModel]),
    codingModel: text(raw[CONFIG_KEYS.codingModel]) ?? text(raw.model),
    conformanceTests: typeof conformance === "boolean" ? conformance : undefined,
    unittestsScript: text(raw[CONFIG_KEYS.unittestsScript]),
    conformanceTestsScript: text(raw[CONFIG_KEYS.conformanceTestsScript]),
    testingScripts: raw[CONFIG_KEYS.testingScripts] === "host" ? "host" : raw[CONFIG_KEYS.testingScripts] === "vm" ? "vm" : undefined,
  };
}
