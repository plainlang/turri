import { cpSync, rmSync } from "node:fs";
import { basename, dirname } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ensureInVmScratch } from "./paths.ts";
import { NOTES_FILE } from "./notes.ts";
import { STATE_FILE } from "./state.ts";
import { runCommand, truncateOutput } from "./testing.ts";

/**
 * How a person tries out what was just built.
 *
 * Passing unit tests says the code agrees with itself; it says nothing to someone who wants
 * to use the software. The agent that wrote the code is the one that knows how to start it,
 * so it is asked - and every command in its answer is then run by the harness, servers
 * included, so the instructions a person is handed have been followed at least once. The answer
 * is kept to a few plain steps: what to run or do, and what they will see.
 */

export type StepKind = "command" | "long_running" | "manual";

export interface TryStep {
  /** A shell command, or for a manual step, what to do. */
  do: string;
  /** What the person should see. */
  expect: string;
  /**
   * command: exits by itself, so the harness runs it. long_running: a server or an
   * interactive program, started but not waited on. manual: something done by hand, such as
   * opening a page.
   */
  kind: StepKind;
  /** Set when the harness ran it. */
  exitCode?: number;
}

export interface TryIt {
  /** Where the steps run from: a copy of the build made for trying it. */
  dir?: string;
  /** One-off preparation, such as installing dependencies. Run before the steps. */
  setup: string[];
  steps: TryStep[];
  /** Setup commands that failed when the harness ran them. */
  failedSetup?: string[];
}

/** How much a person is asked to read. Beyond this, the answer goes back to be made plainer. */
const LIMITS = { setup: 3, steps: 5, do: 160, expect: 120 };

/** Commands that work in the sandbox's Linux and not in the person's terminal. */
const NOT_PORTABLE = /(^|[\s;&|(])(sudo|apk|apt|apt-get|yum|dnf|pacman|zypper)\s/;

/** What is wrong with an answer, in words the agent can act on - or nothing when it is fine. */
export function tryItProblems(tryIt: TryIt): string[] {
  const problems: string[] = [];
  if (tryIt.setup.length > LIMITS.setup) problems.push(`${tryIt.setup.length} setup commands - at most ${LIMITS.setup}; chain related ones with &&.`);
  if (tryIt.steps.length > LIMITS.steps) problems.push(`${tryIt.steps.length} steps - at most ${LIMITS.steps}; show only what the person needs to see it work.`);
  for (const command of tryIt.setup) {
    if (command.includes("\n")) problems.push(`setup \`${command.split("\n")[0]}…\` spans lines - one line each.`);
    if (NOT_PORTABLE.test(command)) problems.push(`setup \`${command}\` uses a Linux-only package manager or sudo - the person runs it in their own terminal.`);
  }
  tryIt.steps.forEach((step, index) => {
    const n = index + 1;
    if (step.do.includes("\n")) problems.push(`step ${n} spans lines - one action per step.`);
    if (step.do.length > LIMITS.do) problems.push(`step ${n} is ${step.do.length} characters - at most ${LIMITS.do}.`);
    if (step.expect.includes("\n") || step.expect.length > LIMITS.expect) {
      problems.push(`step ${n}'s "you should see" is too long - one short sentence, at most ${LIMITS.expect} characters.`);
    }
    if (step.kind !== "manual" && NOT_PORTABLE.test(step.do)) {
      problems.push(`step ${n} uses a Linux-only package manager or sudo - the person runs it in their own terminal.`);
    }
  });
  return problems;
}

export function createTryItTool(onSubmit: (tryIt: TryIt) => void) {
  return defineTool({
    name: "describe_how_to_try_it",
    label: "Describe how to try it",
    description:
      "Tell the person, in a few plain steps, how to see what you just built working: what to run or do, and what " +
      "they should see. Commands are run first to check them, from a fresh copy of the working directory with no " +
      `dependencies installed. At most ${LIMITS.setup} setup commands and ${LIMITS.steps} steps, one line each.`,
    parameters: Type.Object({
      setup: Type.Array(Type.String(), {
        description: "One-off preparation, e.g. installing dependencies - one line each, portable (no sudo, no apt/apk). Empty if none.",
      }),
      steps: Type.Array(
        Type.Object({
          do: Type.String({
            description:
              "One action: a command to paste into a terminal, or for a manual step a plain instruction such as " +
              "'Open http://localhost:8000 and click Sign in'.",
          }),
          expect: Type.String({
            description: "What they should see, in one short sentence with the concrete value, e.g. 'It prints Hello, Ana!'",
          }),
          kind: Type.Union(
            [Type.Literal("command"), Type.Literal("long_running"), Type.Literal("manual")],
            {
              description:
                "command: exits on its own. long_running: a server or interactive program that keeps running " +
                "(it is started and checked, then stopped). manual: done by hand, e.g. clicking in a browser.",
            },
          ),
        }),
        { minItems: 1 },
      ),
    }),
    async execute(_id, params) {
      const tryIt = { setup: params.setup, steps: params.steps };
      const problems = tryItProblems(tryIt);
      if (problems.length > 0) {
        throw new Error(
          ["Not recorded - make it plainer and shorter, then call describe_how_to_try_it again:", "", ...problems.map((p) => `- ${p}`)].join("\n"),
        );
      }
      onSubmit(tryIt);
      return {
        content: [{ type: "text" as const, text: "Recorded." }],
        details: params,
        terminate: true,
      };
    },
  });
}

/** `what`: what was just built, as the start of a sentence - "Functionality 3", "The spec change". */
export function tryItPrompt(what: string): string {
  return [
    `${what} is built and its unit tests pass. Now tell the person who asked for it how to try it`,
    "themselves. Call describe_how_to_try_it.",
    "",
    "Write for someone who has not seen the code and will read this once:",
    "- A few steps - usually two or three, never more than five. Each is one action: a command to paste,",
    "  or a plain instruction (\"Open http://localhost:8000 and click Sign in\", \"Enter ana@example.com\").",
    "- `expect` is what they will see, in one short sentence with the concrete value (\"It prints",
    "  Hello, Ana!\", \"The page shows your name in the top right\"). No explanations, no internals, no",
    "  alternatives, no \"you can also\".",
    "- Use the real entry point - the CLI, the server, the page - with concrete inputs, never placeholders.",
    "  Show what was just built. What was built before only where it is needed to get there.",
    "- They run the commands in their own terminal, on macOS or Linux, from a fresh copy of the working",
    "  directory with nothing installed. Put installing in `setup`, inside the directory (a virtual",
    "  environment, a local node_modules) - never globally, never with sudo, apt or apk.",
    "- Every command is run first to check it works. Mark each step honestly: a server or anything that",
    "  keeps running is `long_running` - it is started, checked, and the steps after it run against it -",
    "  and anything done by hand in a browser is `manual`.",
    "- If there is genuinely nothing to run - a library with no entry point - give the shortest snippet",
    "  that calls it, as a command.",
    "",
    "For example:",
    "  setup: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt",
    "  1. long_running: .venv/bin/uvicorn app.main:app --port 8000 -> The server says it is running on port 8000.",
    "  2. command: curl -s localhost:8000/greet?name=Ana -> It prints {\"message\": \"Hello, Ana!\"}.",
    "  3. manual: Open http://localhost:8000/docs and try /greet -> You see the same greeting.",
  ].join("\n");
}

export function failedStepsPrompt(tryIt: TryIt, outputs: Map<string, string>): string {
  const failed = [
    ...(tryIt.failedSetup ?? []),
    ...tryIt.steps.filter((s) => s.exitCode !== undefined && s.exitCode !== 0).map((s) => s.do),
  ];
  return [
    "These did not work when run from a fresh copy of the working directory, with nothing installed - a",
    "server step means it was not still running a few seconds after it was started:",
    "",
    ...failed.map((command) => `$ ${command}\n${outputs.get(command) ?? ""}`.trimEnd()),
    "",
    "Fix the instructions, or the code if the software really does not behave as it should, and",
    "call describe_how_to_try_it again. Do not remove or weaken a test.",
  ].join("\n");
}

/** What is not copied: caches, installed dependencies, and the harness's own bookkeeping. */
const NOT_COPIED = new Set([".git", ".plainwright", NOTES_FILE, "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", STATE_FILE]);

/**
 * A fresh copy of the build to try it from, replacing any earlier copy for this functionality.
 *
 * Installed dependencies are left behind on purpose. A virtual environment holds absolute
 * paths and breaks when moved, and a copy that already has everything installed would let
 * setup steps that do not work pass the check. So the steps are checked from where the
 * person starts: the code, and nothing else.
 */
export function prepareTryDir(buildDir: string, dest: string): string {
  rmSync(dest, { recursive: true, force: true });
  ensureInVmScratch(buildDir, dirname(dest));
  cpSync(buildDir, dest, { recursive: true, filter: (source) => !NOT_COPIED.has(basename(source)) });
  return dest;
}

/** How long a server is given to come up before the steps after it run, and how often they retry. */
const SERVER_WARMUP_SECONDS = 4;
const RETRIES_AFTER_SERVER = 5;

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * Run the setup and every step that can be run, in order, in the directory the person will use -
 * the way they will run them.
 *
 * A `command` is run and must exit 0. A `long_running` one - a server - is started in the
 * background and must still be running a few seconds later; the steps after it then run against
 * it, retried briefly while it warms up, and it is stopped at the end. A `manual` step is done by
 * hand and cannot be checked. Stops at the first setup failure, since nothing after it means
 * anything.
 */
export async function checkTryIt(
  dir: string,
  tryIt: TryIt,
  run: (cwd: string, command: string) => Promise<{ exitCode: number; output: string }> = runCommand,
  options: { pause?: (seconds: number) => Promise<void> } = {},
): Promise<{ tryIt: TryIt; outputs: Map<string, string>; ok: boolean }> {
  const pause = options.pause ?? ((seconds: number) => new Promise<void>((done) => setTimeout(done, seconds * 1000)));
  const outputs = new Map<string, string>();
  const failedSetup: string[] = [];

  for (const command of tryIt.setup) {
    const result = await run(dir, command);
    outputs.set(command, truncateOutput(result.output));
    if (result.exitCode !== 0) {
      failedSetup.push(command);
      return { tryIt: { ...tryIt, failedSetup }, outputs, ok: false };
    }
  }

  const steps: TryStep[] = [];
  const servers: string[] = [];
  try {
    for (const [index, step] of tryIt.steps.entries()) {
      if (step.kind === "manual") {
        steps.push(step);
        continue;
      }
      if (step.kind === "long_running") {
        // Its own process group, its output in the sandbox's /tmp - not in the person's copy.
        const log = `/tmp/plainwright-try-${index}.log`;
        const started = await run(dir, `setsid nohup bash -c ${shellQuote(step.do)} > ${log} 2>&1 < /dev/null & echo $!`);
        const pid = started.output.trim().split("\n").at(-1)?.trim() ?? "";
        if (started.exitCode !== 0 || !/^\d+$/.test(pid)) {
          outputs.set(step.do, truncateOutput(started.output));
          steps.push({ ...step, exitCode: started.exitCode || 1 });
          continue;
        }
        servers.push(pid);
        await pause(SERVER_WARMUP_SECONDS);
        // Still there, and not a zombie: a server that exits is not reaped in the sandbox, and a
        // zombie still answers kill -0.
        const alive = await run(
          dir,
          `if [ -r /proc/${pid}/status ] && ! grep -q '^State:[[:space:]]*Z' /proc/${pid}/status; then echo running; else cat ${log}; exit 1; fi`,
        );
        outputs.set(step.do, truncateOutput(alive.output));
        steps.push({ ...step, exitCode: alive.exitCode });
        continue;
      }
      // A command after a server may meet it still starting up: give it a few tries.
      let result = await run(dir, step.do);
      for (let retry = 0; result.exitCode !== 0 && servers.length > 0 && retry < RETRIES_AFTER_SERVER; retry += 1) {
        await pause(2);
        result = await run(dir, step.do);
      }
      outputs.set(step.do, truncateOutput(result.output));
      steps.push({ ...step, exitCode: result.exitCode });
    }
  } finally {
    if (servers.length > 0) {
      await run(dir, `kill -- ${servers.map((pid) => `-${pid}`).join(" ")} 2>/dev/null; kill ${servers.join(" ")} 2>/dev/null; true`);
    }
  }

  const ok = steps.every((step) => step.exitCode === undefined || step.exitCode === 0);
  return { tryIt: { ...tryIt, steps }, outputs, ok };
}

/**
 * Ask the agent how the person can try what it just built, and check the answer: the setup
 * and every step that finishes on its own are run in a fresh copy of the build, and a failure
 * goes back to the agent once. Returns the steps as checked - each marked with whether it
 * worked - or nothing when the agent gave none.
 *
 * In a copy made for the person, never the build: the next render works in the build, and
 * whatever trying it leaves behind - a database, installed packages - stays out of the
 * codebase. A fresh copy each time, so a fix is what gets checked.
 */
const TRY_IT_FIX_ROUNDS = 3;

export async function settleTryIt(input: {
  buildDir: string;
  tryDir: string;
  /** From tryItPrompt. */
  prompt: string;
  /** Put a prompt to the agent; resolves to what it passed to describe_how_to_try_it, if anything. */
  ask: (prompt: string) => Promise<TryIt | undefined>;
  stage: (label: string) => void;
}): Promise<TryIt | undefined> {
  input.stage("working out how you can try it");
  const described = await input.ask(input.prompt);
  if (described === undefined) return undefined;
  const check = (steps: TryIt) => checkTryIt(prepareTryDir(input.buildDir, input.tryDir), { ...steps, dir: input.tryDir });
  input.stage("running the try-it steps to check they work");
  let checked = await check(described);
  // A command that does not work when the person pastes it is worse than none: it goes back to
  // be fixed until it works, or the rounds run out - and then it is shown as not working.
  for (let round = 1; !checked.ok && round <= TRY_IT_FIX_ROUNDS; round += 1) {
    input.stage(`a try-it step did not work - fixing it (round ${round} of ${TRY_IT_FIX_ROUNDS})`);
    const fixed = await input.ask(failedStepsPrompt(checked.tryIt, checked.outputs));
    if (fixed === undefined) break;
    checked = await check(fixed);
  }
  return checked.tryIt;
}
