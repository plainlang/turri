import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { ROLE_THINKING, type AgentRole } from "./config.ts";

/**
 * `turri init-config`: a project's first config.yaml - the two models, a strong one to talk to and a smaller one to
 * write the code - so a new project starts with a choice that works rather than an empty file. It asks which vendor's
 * models you use and fills in theirs; every other key is there too, commented out, each with what it does and an
 * example value: uncommented, each is read as written. docs/config.md has the whole of each.
 *
 * Then it says what to do next: where the file is - turri reads it from that folder and the folders below it, nowhere
 * else - and how to sign in to the vendor so pi, which turri runs on, can reach the models.
 */

/** A vendor whose models the quick start config is filled in with. */
export type Vendor = "anthropic" | "openai" | "google" | "other";

interface VendorPreset {
  label: string;
  /** The model you talk to: it writes the specs and plans the work. */
  harness: string;
  /** The smaller, cheaper one that writes the code. */
  coding: string;
  /** A strong model for the commented-out judge, reviewer and debugger examples. */
  strong: string;
  /** The environment variables pi reads the vendor's keys from - pi's own names (pi.dev, providers). */
  keys: Array<{ vendor: string; variable: string }>;
}

export const VENDORS: Record<Vendor, VendorPreset> = {
  anthropic: {
    label: "Anthropic",
    harness: "anthropic/claude-opus-5-5",
    coding: "anthropic/claude-haiku-5-5",
    strong: "anthropic/claude-sonnet-5-5",
    keys: [{ vendor: "Anthropic", variable: "ANTHROPIC_API_KEY" }],
  },
  openai: {
    label: "OpenAI",
    harness: "openai/gpt-6-astra",
    coding: "openai/gpt-6-luna",
    strong: "openai/gpt-6.1-sol",
    keys: [{ vendor: "OpenAI", variable: "OPENAI_API_KEY" }],
  },
  google: {
    label: "Google",
    harness: "google/gemini-3.1-pro-preview",
    coding: "google/gemini-3.1-flash-lite",
    strong: "google/gemini-3.1-pro-preview",
    keys: [{ vendor: "Google", variable: "GEMINI_API_KEY" }],
  },
  // A mix - the strongest to talk to, a cheap one to code - and the starting point for any other provider pi supports.
  other: {
    label: "Other",
    harness: "anthropic/claude-opus-5-5",
    coding: "google/gemini-3.1-flash-lite",
    strong: "google/gemini-3.1-pro-preview",
    keys: [
      { vendor: "Anthropic", variable: "ANTHROPIC_API_KEY" },
      { vendor: "Google", variable: "GEMINI_API_KEY" },
    ],
  },
};

/** A config line's text, padded to where its comment starts - at least one space before it. */
const column = (text: string, width: number) => (text.length >= width ? `${text} ` : text.padEnd(width));

/** How hard the model you talk to thinks, as written: the conversation, the planner and the rest of its side. */
const HARNESS_THINKING = "medium";

/** A role's commented-out entry: its model, and the thinking it has unless one is named - as turri runs it unset. */
function role(name: AgentRole, model: string | undefined, comment: string): string {
  const fields = [...(model !== undefined ? [`model: ${model}`] : []), `thinking: ${ROLE_THINKING[name]}`].join(", ");
  return `${column(`#   ${name}: { ${fields} }`, 72)}# ${comment}`;
}

/** The quick start config.yaml for a vendor's models. */
export function quickStartConfig(vendor: Vendor = "other"): string {
  const { harness, coding, strong } = VENDORS[vendor];
  // The two model lines' comments start in one column, past the longer of them.
  const width = Math.max(46, `harness-model: ${harness}:${HARNESS_THINKING}`.length + 2, `coding-model: ${coding}:${ROLE_THINKING.coding}`.length + 2);
  return [
    "# Any model pi supports works (https://pi.dev): a capable one to talk to, a smaller, cheaper one for the coding.",
    `${column(`harness-model: ${harness}:${HARNESS_THINKING}`, width)}# you talk to it: it writes the specs and plans the work`,
    `${column(`coding-model: ${coding}:${ROLE_THINKING.coding}`, width)}# it writes the code`,
    "# The :level is how hard each thinks - off, minimal, low, medium, high, xhigh or max. The reviews and judges run on the",
    "# coding model but think medium, as models: below shows.",
    "",
    "# Every other key, commented out: unset, each is as its comment says. Uncomment one to try it. docs/config.md has them all.",
    "",
    "# The .plain file turri regrow and regrow build when none is named.",
    "# module: app.plain",
    "",
    "# The judge and test review of a conformance run (unset: coding-model). A model is provider/id, provider/id:thinking,",
    "# or { model, thinking } - thinking is off, minimal, low, medium, high, xhigh or max.",
    `# judge-model: ${strong}:high`,
    "",
    "# Each agent role's own model, thinking and turn limit (unset: every role on coding-model, the conversation's side on",
    "# harness-model, each thinking as written here). What an entry leaves out it takes from default.",
    "# models:",
    `#   default: ${coding}`,
    `${column(`#   chat: ${harness}`, 72)}# the conversation - as harness-model, which it wins over`,
    role("chooser", harness, "chooses what gets conformance tests under turri regrow"),
    role("planner", harness, "cuts the work into pulses"),
    role("diagnosis", harness, "looks into a pulse that failed for good"),
    role("release", coding, "turri release's agent, and release-after-pulse's"),
    `${column(`#   coding: { model: ${coding}, thinking: ${ROLE_THINKING.coding}, turn-limit: 180 }`, 72)}# as coding-model, which it wins over`,
    role("conformance", coding, "writes the conformance tests"),
    role("explorer", coding, "explores the code for a conformance run"),
    role("reviewer", undefined, "reviews the code and its unit tests"),
    role("test-reviewer", strong, "reviews the conformance tests"),
    role("judge", strong, "judges a failing conformance run - as judge-model, which it wins over"),
    role("arbiter", strong, "weighs a second review"),
    role("debugger", strong, "a fresh look at unit tests that keep failing the same way"),
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
    "# How big a pulse may be: the most functional specs the planner groups into one (unset: 3), and the most lines of",
    "# spec - its functional specs with the definitions they bring - before a group is split again (unset: 120).",
    "# max-specs-per-pulse: 5",
    "# max-lines-per-pulse: 200",
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
}

/** The quick start config for the mix of vendors: what turri wrote before it asked. */
export const QUICK_START_CONFIG = quickStartConfig("other");

/** A vendor from what was typed: its number in the list, or its name. */
export function vendorOf(answer: string): Vendor | undefined {
  const typed = answer.trim().toLowerCase();
  const names = Object.keys(VENDORS) as Vendor[];
  const byNumber = /^\d+$/.test(typed) ? names[Number(typed) - 1] : undefined;
  return byNumber ?? names.find((name) => name === typed || VENDORS[name].label.toLowerCase() === typed);
}

/** The shell profile an exported key is kept in, for the shell this person uses. */
function shellProfile(): string {
  const shell = basename(process.env.SHELL ?? "");
  if (shell === "zsh") return "~/.zshrc";
  if (shell === "fish") return "~/.config/fish/config.fish";
  return "~/.bashrc";
}

/** How to sign in to the vendor's models, as pi takes them: a key in the environment, or /login. */
function signInText(vendor: Vendor): string[] {
  const { keys } = VENDORS[vendor];
  const windows = process.platform === "win32";
  const set = (variable: string) => (windows ? `setx ${variable} "..."` : `export ${variable}=...`);
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return [
    `Sign in to ${keys.map((key) => key.vendor).join(" and ")}, so pi - which turri runs on - can reach the models. Either:`,
    `  - set the key${keys.length === 1 ? "" : "s"} in the shell you start turri from:`,
    ...keys.map((key) => `      ${set(key.variable)}`),
    windows
      ? "    setx keeps it for every new terminal - open a new one before you run turri."
      : `    add the line${keys.length === 1 ? "" : "s"} to ${shellProfile()} to keep ${keys.length === 1 ? "it" : "them"} for every new terminal;`,
    `  - or start turri and type /login, and sign in there: pi keeps the credential in ${join(agentDir, "auth.json")}.`,
    ...(vendor === "other"
      ? ["Another provider: change the two models to any pi supports, and set its key - pi's providers and their keys are at https://pi.dev."]
      : []),
  ];
}

/** Write the quick start config.yaml in `dir` - never over one already there, unless `force`. Says what it did. */
export function initConfig(dir: string, options: { force?: boolean; vendor?: Vendor } = {}): { written: boolean; message: string } {
  const folder = resolve(dir);
  const path = join(folder, "config.yaml");
  const vendor = options.vendor ?? "other";
  if (existsSync(path) && options.force !== true) {
    return { written: false, message: `${path} is already there - left as it is. turri init-config --force writes it again.` };
  }
  const config = quickStartConfig(vendor);
  writeFileSync(path, config);
  const here = resolve(process.cwd()) === folder;
  return {
    written: true,
    message: [
      `Wrote ${path}, with ${vendor === "other" ? "a mix of" : `${VENDORS[vendor].label}'s`} models:`,
      "",
      config.split("\n").slice(1, 3).map((line) => `  ${line}`).join("\n"),
      "",
      ...signInText(vendor),
      "",
      "This config belongs to this folder:",
      `  ${folder}`,
      "turri reads it when it runs there, or in a folder below it: it uses the nearest config.yaml upwards from where it",
      "starts. Started anywhere else - beside a clone of turri, say - turri does not see it: run turri init-config there too.",
      "",
      "Every other key is in it, commented out, with what it does: uncomment one to try it. docs/config.md has them all.",
      "",
      `Then: ${here ? "" : `cd ${folder} && `}turri`,
    ].join("\n"),
  };
}

const USAGE = [
  "usage: turri init-config [--vendor anthropic|openai|google|other] [--force] [folder]",
  "",
  "Write a quick start config.yaml in the folder, the current one by default: the model you talk to and the one that",
  "writes the code, from the vendor you use. Asked when --vendor is not given and this is a terminal; otherwise other -",
  "a mix of Anthropic and Google, the starting point for any provider pi supports.",
].join("\n");

/** Ask which vendor's models to use - a number or a name - until the answer is one of them. */
async function askVendor(): Promise<Vendor> {
  const names = Object.keys(VENDORS) as Vendor[];
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Which vendor's models do you use?");
    names.forEach((name, index) => {
      const { label, harness, coding } = VENDORS[name];
      console.log(`  ${index + 1}) ${label.padEnd(10)}${name === "other" ? "a mix, or another provider - " : ""}${harness} to talk to, ${coding} to code`);
    });
    for (;;) {
      const chosen = vendorOf(await rl.question(`Choose 1-${names.length}: `));
      if (chosen !== undefined) return chosen;
      console.log(`Type a number from 1 to ${names.length}, or a vendor's name.`);
    }
  } finally {
    rl.close();
  }
}

/** `turri init-config [--vendor <vendor>] [--force] [folder]`. */
export async function main(args: string[]): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  const flag = args.findIndex((arg) => arg === "--vendor" || arg.startsWith("--vendor="));
  const given = flag === -1 ? undefined : args[flag]!.includes("=") ? args[flag]!.split("=")[1]! : args[flag + 1];
  const rest = args.filter((arg, index) => !arg.startsWith("-") && !(flag !== -1 && !args[flag]!.includes("=") && index === flag + 1));
  const folder = rest[0] ?? process.cwd();
  if (!existsSync(folder)) {
    console.error(`${folder} does not exist.`);
    return 1;
  }
  let vendor: Vendor | undefined;
  if (given !== undefined) {
    vendor = vendorOf(given);
    if (vendor === undefined) {
      console.error(`Not a vendor: ${given}. One of ${Object.keys(VENDORS).join(", ")}.\n\n${USAGE}`);
      return 1;
    }
  }
  const force = args.includes("--force");
  // Nothing to ask about when it will not be written.
  if (existsSync(join(folder, "config.yaml")) && !force) {
    console.error(initConfig(folder).message);
    return 1;
  }
  vendor ??= process.stdin.isTTY && process.stdout.isTTY ? await askVendor() : "other";
  const result = initConfig(folder, { force, vendor });
  (result.written ? console.log : console.error)(result.message);
  return result.written ? 0 : 1;
}
