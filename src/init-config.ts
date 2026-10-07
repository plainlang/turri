import { existsSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * `turri init-config`: a project's first config.yaml - the two models, a strong one to talk to and a smaller one to
 * write the code - so a new project starts with a choice that works rather than an empty file. docs/config.md has
 * every other key.
 */

export const QUICK_START_CONFIG = [
  "# Any model pi supports works (https://pi.dev): a capable one to talk to, a smaller, cheaper one for the coding.",
  "harness-model: anthropic/claude-opus-5-5     # you talk to it: it writes the specs and plans the work",
  "coding-model: google/gemini-3.1-flash-lite   # it writes the code - or openai/gpt-6-luna",
  "",
].join("\n");

/** Write the quick start config.yaml in `dir` - never over one already there, unless `force`. Says what it did. */
export function initConfig(dir: string, options: { force?: boolean } = {}): { written: boolean; message: string } {
  const path = join(dir, "config.yaml");
  const shown = relative(process.cwd(), path) || "config.yaml";
  if (existsSync(path) && options.force !== true) {
    return { written: false, message: `${shown} is already there - left as it is. turri init-config --force writes it again.` };
  }
  writeFileSync(path, QUICK_START_CONFIG);
  return {
    written: true,
    message: [
      `Wrote ${shown}:`,
      "",
      QUICK_START_CONFIG.trimEnd(),
      "",
      "These are an example: any model pi supports works (https://pi.dev) - change the two lines to the ones you have,",
      "keeping a capable model to talk to and a smaller one for the coding. Sign in to their providers - an API key such",
      "as ANTHROPIC_API_KEY and GEMINI_API_KEY, or /login once turri has started - and run turri.",
      "Every other key: docs/config.md.",
    ].join("\n"),
  };
}

/** `turri init-config [--force] [folder]`. */
export function main(args: string[]): number {
  if (args.includes("-h") || args.includes("--help")) {
    console.log("usage: turri init-config [--force] [folder]\n\nWrite a quick start config.yaml - the model you talk to and the one that writes the code - in the folder, the current one by default.");
    return 0;
  }
  const folder = args.find((arg) => !arg.startsWith("-")) ?? process.cwd();
  if (!existsSync(folder)) {
    console.error(`${folder} does not exist.`);
    return 1;
  }
  const result = initConfig(folder, { force: args.includes("--force") });
  (result.written ? console.log : console.error)(result.message);
  return result.written ? 0 : 1;
}
