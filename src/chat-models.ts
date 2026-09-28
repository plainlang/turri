import { modelSpec, projectModels, type ProjectConfig } from "./config.ts";

/**
 * The two models of `plainwright chat`, from its arguments and the project's config.yaml.
 *
 * The harness model is the one the person talks to: pi's own `--model`, which `--harness-model`
 * is another name for, or else `harness-model:` in config.yaml. The coding model is the one
 * every render runs on: `--coding-model`, or else `coding-model:` in config.yaml - pi knows
 * nothing of it, so it reaches the extension through the environment. Either can still be
 * changed in the conversation: pi's /model, set_render_model.
 */

/** The environment variable a chat's --coding-model reaches the extension through. */
export const CODING_MODEL_ENV = "PLAINWRIGHT_CODING_MODEL";

/** Take a `--name value` or `--name=value` out of the arguments: its value, and the rest. The last one wins. */
export function takeOption(args: string[], name: string): { value?: string; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === name && i + 1 < args.length) value = args[++i];
    else if (arg.startsWith(`${name}=`)) value = arg.slice(name.length + 1);
    else rest.push(arg);
  }
  return { value, rest };
}

/** pi's arguments, with the harness model in them, and the coding model for the extension. */
export function chatModels(
  args: string[],
  config: Pick<ProjectConfig, "harnessModel" | "codingModel" | "judgeModel">,
): { piArgs: string[]; codingModel?: string } {
  const coding = takeOption(args, "--coding-model");
  const harness = takeOption(coding.rest, "--harness-model");
  const piArgs = harness.rest;
  // pi's own flags win: a --model or --provider given as they are is left alone.
  const given = piArgs.some((arg) => /^--(model|provider)(=|$)/.test(arg));
  const harnessModel = given ? undefined : (harness.value ?? modelSpec(projectModels(config).harness));
  return { piArgs: harnessModel !== undefined ? ["--model", harnessModel, ...piArgs] : piArgs, codingModel: coding.value };
}
