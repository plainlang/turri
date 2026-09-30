/**
 * Keeping the conversation's agent on its own tools.
 *
 * The agent has a shell, and plainwright has a command line - so it can build a module by
 * running `plainwright module` through bash, or start another pi with `pi -p`. That run is a
 * second, headless plainwright: outside this conversation's job queue, its panel, `/watch` and
 * `/stop`, on whatever model the command line picks, fighting the conversation's own jobs for
 * the same build directories. It is never the right call unless the person asked for the
 * command line, so the harness refuses it and names the tool to use instead.
 */

/** The tool that does what a plainwright subcommand does, from inside the conversation. */
const TOOL_FOR: Record<string, string> = {
  render: "render_functionality",
  module: "render_module",
  regenerate: "regenerate_functionality",
  conformance: "render_functionality_conformance",
  skill: "run_skill",
  deploy: "deploy",
  forge: "run_skill",
  chat: "nothing - you are the conversation already",
  ask: "nothing - you are the conversation already",
};

/** The npm scripts in this repo, by the subcommand they run. */
const NPM_SCRIPT: Record<string, string> = {
  render: "render",
  module: "module",
  regenerate: "regenerate",
  conformance: "conformance",
  forge: "forge",
  chat: "chat",
  ask: "ask",
};

/** The source entry points, by the subcommand they are. */
const ENTRY: Record<string, string> = {
  "render-frid": "render",
  "render-module": "module",
  "regenerate-frid": "regenerate",
  "conformance-frid": "conformance",
  run: "skill",
  "deploy-cli": "deploy",
};

/** Where a command starts: the start of the string, or after a separator. */
const AT_COMMAND = String.raw`(?:^|[\s;&|()\x60$])`;

/**
 * What a shell command would run of plainwright or pi itself, if anything: the subcommand,
 * or "pi" for another pi. `plainwright check` is not in it - it validates a spec and starts no
 * agent - and neither are setup, doctor and vm-image.
 */
export function selfInvocation(command: string): string | undefined {
  const cli = new RegExp(`${AT_COMMAND}(?:npx\\s+)?plainwright\\s+(render|module|regenerate|conformance|skill|chat|deploy)\\b`).exec(command);
  if (cli) return cli[1];
  const launcher = new RegExp(`(?:bin/plainwright\\.mjs|src/cli\\.ts)\\s+(render|module|regenerate|conformance|skill|chat|deploy)\\b`).exec(command);
  if (launcher) return launcher[1];
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
    /\bplainwright\s+(render|module|regenerate|conformance|skill|chat|deploy)\b/.test(text) ||
    /(^|\s)pi\s+-p\b/.test(text)
  );
}

/** What the agent is told when the call is refused. */
export function refusal(what: string): string {
  const instead =
    what === "pi"
      ? "Do not start another agent: do the work here, with this conversation's tools."
      : `Use ${TOOL_FOR[what] ?? "the matching plainwright tool"} instead.`;
  return (
    `Not run: that starts plainwright${what === "pi" ? "'s agent" : ` ${what}`} again from the shell - a separate, headless ` +
    "run outside this conversation, its job queue, the panel, /watch and /stop. " +
    `${instead} Run plainwright from the command line only when the user asks for that.`
  );
}

/** The instruction that goes into the conversation's system prompt. */
export const TOOLS_NOT_CLI = [
  "<plainwright-tools>",
  "In this conversation, plainwright's work is done with its tools - render_functionality, render_module,",
  "regenerate_functionality, render_spec_diff, render_functionality_conformance, run_skill and the rest - which run as",
  "background jobs the user can watch and stop. To try what is built, deploy - never by hand in plain_modules. Never",
  "run plainwright's command line (plainwright render, module, regenerate, conformance, skill, chat, deploy; npm run",
  "render and the like) or start another pi through bash:",
  "that is a separate headless run the user cannot see or stop. Only when the user explicitly asks for the",
  "command line, run it. Configuring pi itself - pi install, update, list, config, auth, or its settings files -",
  "is fine; it starts no agent.",
  "</plainwright-tools>",
].join("\n");
