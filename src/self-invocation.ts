/**
 * Keeping the conversation's agent on its own tools.
 *
 * The agent has a shell, and turri has a command line - so it can build a module by
 * running `turri regenerate` through bash, or start another pi with `pi -p`. That run is a
 * second, headless turri: outside this conversation's job queue, its panel and
 * `/halt`, on whatever model the command line picks, fighting the conversation's own jobs for
 * the same build directories. It is never the right call unless the person asked for the
 * command line, so the harness refuses it and names the tool to use instead.
 */

/** The tool that does what a turri subcommand does, from inside the conversation. */
const TOOL_FOR: Record<string, string> = {
  regenerate: "regenerate",
  glimpse: "glimpse",
  conform: "conform",
  cultivate: "cultivate",
  release: "release",
  "spec-diff": "regenerate",
  chat: "nothing - you are the conversation already",
  ask: "nothing - you are the conversation already",
};

/** The npm scripts in this repo, by the subcommand they run. */
const NPM_SCRIPT: Record<string, string> = {
  regenerate: "regenerate",
  conform: "conform",
  cultivate: "cultivate",
  chat: "chat",
  ask: "ask",
};

/** The source entry points, by the subcommand they are. */
const ENTRY: Record<string, string> = {
  "regenerate-cli": "regenerate",
  "conform-cli": "conform",
  "spec-diff-cli": "spec-diff",
  "cultivate-cli": "cultivate",
  "release-cli": "release",
};

/** Where a command starts: the start of the string, or after a separator. */
const AT_COMMAND = String.raw`(?:^|[\s;&|()\x60$])`;

/**
 * What a shell command would run of turri or pi itself, if anything: the subcommand,
 * or "pi" for another pi. `turri validate`, `drift` and `lineage` are not in it - they start no
 * agent - and neither are setup and doctor.
 */
export function selfInvocation(command: string): string | undefined {
  const cli = new RegExp(`${AT_COMMAND}(?:npx\\s+)?turri\\s+(regenerate|glimpse|conform|cultivate|release|spec-diff)\\b`).exec(command);
  if (cli) return cli[1];
  const launcher = new RegExp(`(?:bin/turri\\.mjs|src/cli\\.ts)\\s+(regenerate|glimpse|conform|cultivate|release|spec-diff)\\b`).exec(command);
  if (launcher) return launcher[1];
  // turri alone, or with options, is the conversation - where a command starts, not a word an argument names (`which turri`).
  const bare =
    /(?:^|[;&|()\x60$]\s*|\bnohup\s+|\bnpx\s+)turri(?=\s+-|\s*$|\s*[;&|)>])(?:\s+(-\S+))?/.exec(command) ??
    /(?:bin\/turri\.mjs|src\/cli\.ts)(?=\s+-|\s*$|\s*[;&|)>])(?:\s+(-\S+))?/.exec(command);
  if (bare && !["-h", "--help"].includes(bare[1] ?? "")) return "chat";
  const npm = new RegExp(`${AT_COMMAND}npm\\s+run\\s+(${Object.values(NPM_SCRIPT).join("|")})\\b`).exec(command);
  if (npm) return npm[1];
  const entry = new RegExp(`src/(${Object.keys(ENTRY).join("|")})\\.ts\\b`).exec(command);
  if (entry) return ENTRY[entry[1]!];
  if (/pi-launch\.ts\b/.test(command)) return "pi";
  // Another pi - but only one that would run an agent. pi configuring or describing itself
  // (installing an extension, listing models, its version) is pi's own business.
  for (const match of command.matchAll(new RegExp(`${AT_COMMAND}(?:npx\\s+)?pi(?:\\s+(\\S+)|\\s*$|\\s*[;&|)])`, "g"))) {
    const first = match[1];
    if (first === undefined || !PI_CONFIGURES.has(first)) return "pi";
  }
  return undefined;
}

/** pi's commands and flags that manage or describe pi rather than start an agent. */
const PI_CONFIGURES = new Set([
  "install", "remove", "uninstall", "update", "list", "config", "auth",
  "--version", "-v", "--help", "-h", "--list-models",
]);

/**
 * Whether the person's message asks for the command line: it says so, or names the command.
 * Read from their own words only - an agent that decided on its own does not get through.
 */
export function askedForCommandLine(message: string): boolean {
  const text = message.toLowerCase();
  return (
    /\b(headless|command[ -]line|cli|terminal|shell|in bash|via bash|through bash|npm run|nohup)\b/.test(text) ||
    /\bturri\s+(regenerate|glimpse|conform|spec-diff|cultivate|release)\b/.test(text) ||
    /(^|\s)turri\s+-p\b/.test(text) ||
    /(^|\s)pi\s+-p\b/.test(text)
  );
}

/** What the agent is told when the call is refused. */
export function refusal(what: string): string {
  const instead =
    what === "pi"
      ? "Do not start another agent: do the work here, with this conversation's tools."
      : `Use ${TOOL_FOR[what] ?? "the matching turri tool"} instead.`;
  return (
    `Not run: that starts turri${what === "pi" ? "'s agent" : ` ${what}`} again from the shell - a separate, headless ` +
    "run outside this conversation, its jobs, the panel and /halt. " +
    `${instead} Run turri from the command line only when the user asks for that.`
  );
}

/** The instruction that goes into the conversation's system prompt. */
export const TOOLS_NOT_CLI = [
  "<turri-tools>",
  "In this conversation, you do your work with your tools - regenerate, conform, cultivate and the rest - which run as",
  "background jobs the user can watch and halt. To try what is grown, release it - never by hand in plain_modules. Never",
  "run your own command line (turri regenerate, glimpse, conform, spec-diff, cultivate, release, turri itself; npm run",
  "regenerate and the like) or start another pi through bash:",
  "that is a separate headless run the user cannot see or stop. Only when the user explicitly asks for the",
  "command line, run it. Configuring pi itself - pi install, update, list, config, auth, or its settings files -",
  "is fine; it starts no agent.",
  "</turri-tools>",
].join("\n");
