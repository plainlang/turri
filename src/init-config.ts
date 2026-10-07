import { existsSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * `turri init-config`: a project's first config.yaml - the two models, a strong one to talk to and a smaller one to
 * write the code - so a new project starts with a choice that works rather than an empty file. Every other key is
 * there too, commented out, each with what it does and an example value: uncommented, each is read as written.
 * docs/config.md has the whole of each.
 */

export const QUICK_START_CONFIG = [
  "# Any model pi supports works (https://pi.dev): a capable one to talk to, a smaller, cheaper one for the coding.",
  "harness-model: anthropic/claude-opus-5-5     # you talk to it: it writes the specs and plans the work",
  "coding-model: google/gemini-3.1-flash-lite   # it writes the code - or openai/gpt-6-luna",
  "",
  "# Every other key, commented out: unset, each is as its comment says. Uncomment one to try it. docs/config.md has them all.",
  "",
  "# The .plain file turri regrow and regrow build when none is named.",
  "# module: app.plain",
  "",
  "# The judge and test review of a conformance run (unset: coding-model). A model is provider/id, provider/id:thinking,",
  "# or { model, thinking } - thinking is off, minimal, low, medium, high, xhigh or max.",
  "# judge-model: google/gemini-3.1-pro:high",
  "",
  "# Each agent role's own model, thinking and turn limit (unset: every role on coding-model, the conversation's side on",
  "# harness-model). What an entry leaves out it takes from default.",
  "# models:",
  "#   default: google/gemini-3.1-flash-lite",
  "#   chat: anthropic/claude-opus-5-5           # the conversation - as harness-model, which it wins over",
  "#   chooser: anthropic/claude-opus-5-5        # chooses what gets conformance tests under turri regrow",
  "#   planner: anthropic/claude-opus-5-5        # cuts the work into pulses",
  "#   diagnosis: anthropic/claude-opus-5-5      # looks into a pulse that failed for good",
  "#   release: anthropic/claude-opus-5-5        # turri release's agent",
  "#   coding: { model: google/gemini-3.1-flash-lite, thinking: high, turn-limit: 180 }   # as coding-model, which it wins over",
  "#   conformance: google/gemini-3.1-flash-lite # writes the conformance tests",
  "#   explorer: google/gemini-3.1-flash-lite    # explores the code for a conformance run",
  "#   reviewer: { thinking: low }               # reviews the code and its unit tests",
  "#   test-reviewer: google/gemini-3.1-pro      # reviews the conformance tests",
  "#   judge: google/gemini-3.1-pro              # judges a failing conformance run - as judge-model, which it wins over",
  "#   arbiter: google/gemini-3.1-pro            # weighs a second review",
  "#   debugger: google/gemini-3.1-pro           # a fresh look at unit tests that keep failing the same way",
  "",
  "# Conformance tests: all (or true) - every functional spec of a module with test reqs; chosen - those with acceptance",
  "# tests and those chosen in the conversation; false - none written or run (unset: all).",
  "# conformance-tests: chosen",
  "",
  "# Under conformance-tests: chosen, how many functional specs of a module may be chosen - a count or a share (unset: no limit).",
  "# conformance-budget: 30%",
  "",
  "# Whether the code and its tests are reviewed once they pass (unset: true).",
  "# review: false",
  "",
  "# Whether turri stops a running pulse the spec has moved on from (unset: true). false: it lands, the change grown on top.",
  "# allow-to-stop-jobs: false",
  "",
  "# Whether every pulse that lands code releases it, as the project's release guidance says (unset: false).",
  "# release-after-pulse: true",
  "",
  "# The testing scripts, by path from the project root (unset: the one run_unittests*.sh / run_conformance_tests*.sh /",
  "# run_static_checks*.sh at the root, else in test_scripts/). The static checks are optional and decide nothing.",
  "# unittests-script: test_scripts/run_unittests_python.sh",
  "# conformance-tests-script: test_scripts/run_conformance_tests_python.sh",
  "# static-checks-script: test_scripts/run_static_checks_python.sh",
  "",
  "# What the testing scripts run on: in-place - the code itself; copy - a fresh copy of it (unset: in-place).",
  "# testing-scripts-run-on: copy",
  "",
  "# Seconds each agent turn has, for every role without its own; 0 for none (unset: 120).",
  "# turn-limit: 180",
  "",
  "# How many pulses run at once, on modules that share nothing (unset: half this machine's cores, one to four).",
  "# parallel-jobs: 2",
  "",
  "# Tokens of work an agent holds before it is compacted between turns; at least 1000 (unset: 100000).",
  "# compact-at: 150000",
  "",
  "# Rules left out of the spec-writing agents' prompts - the files of genome/rules/, without .md (unset: none).",
  "# rules-off: [concise-specs]",
  "",
  "# Credentials the agents' commands need while they work: dotenv files by path, and variables from turri's",
  "# environment by name (unset: none). Their values are masked in everything an agent is shown.",
  "# agent-env:",
  "#   files: [.env]",
  "#   vars: [MY_SERVICE_API_KEY]",
  "",
  "# Folders of this machine an agent's commands may read beside the usual ones - a toolchain somewhere unusual (unset: none).",
  "# toolchains: [/srv/zig]",
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
      QUICK_START_CONFIG.slice(0, QUICK_START_CONFIG.indexOf("\n\n")),
      "",
      "These are an example: any model pi supports works (https://pi.dev) - change the two lines to the ones you have,",
      "keeping a capable model to talk to and a smaller one for the coding. Sign in to their providers - an API key such",
      "as ANTHROPIC_API_KEY and GEMINI_API_KEY, or /login once turri has started - and run turri.",
      "Every other key is in it, commented out, with what it does: uncomment one to try it. docs/config.md has them all.",
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
