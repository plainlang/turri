import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { CONFIG_FILE, CONFIG_KEYS, readProjectConfig } from "../config.ts";
import { currentStopSignal, reportActivity } from "./activity.ts";
import { ensureInVmScratch, vmScratchDir } from "./paths.ts";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { keepFullOutput, listFiles, shownOutput, truncateOutput, type TestRun } from "./testing.ts";
import { COMMAND_TIMEOUT_MS } from "./vm.ts";

/**
 * The project's testing scripts, and the harness's runs of them.
 *
 * An agent runs whatever it likes while it works. Whether the work is done is decided by the
 * project's own scripts - the ones the `implement-unit-testing-script` and
 * `implement-conformance-testing-script` skills write into `test_scripts/` and link from the spec -
 * run by the harness, never by the agent. The same script, the same way, every time: done is a
 * decision the project made, not one an agent makes about its own work.
 *
 * The scripts live beside the specs, outside `plain_modules`, so no agent can reach them. They
 * run on this machine, never in a VM - the harness's runs and the agents' run_unit_tests and
 * run_conformance_tests alike, which are the only ways they are ever run: the project's own
 * script, at its own path, from the project, in the environment it was written for. What an agent
 * runs with its own bash stays in its VM. Each run is given a fresh copy of the code under a name
 * of its own - the scripts work in `/tmp/<lang>_<basename of the build>`, and every module's build
 * is called `code` - unless the project runs them on the real folders (`testing-scripts: host`).
 */

export type ScriptKind = "unit" | "conformance";

export interface TestScripts {
  /** `run_unittests_<lang>.sh <build>` */
  unit?: string;
  /** `run_conformance_tests_<lang>.sh <build> <conformance tests>` - the whole suite, at once. */
  conformance?: string;
  /** Why a script was not found where one was looked for: a name in config.yaml, two in a folder. */
  notes?: Partial<Record<ScriptKind, string>>;
  /** Conformance was turned off: the conformance testing script is not run, found or not. */
  conformanceOff?: boolean;
}

/**
 * The scripts, with the conformance testing script set aside because conformance was turned
 * off: no conformance tests are written or run - not even those already in the codebase - and
 * no agent is shown it.
 */
export function withoutConformance(scripts: TestScripts): TestScripts {
  const { conformance: _ignored, ...rest } = scripts;
  return { ...rest, conformanceOff: true };
}

/** The names the skills give each script. Only a file by one of these names is ever run. */
const NAMES: Record<ScriptKind, RegExp> = {
  unit: /^run_unit_?tests[^/]*\.sh$/i,
  conformance: /^run_conformance_?tests[^/]*\.sh$/i,
};

export function scriptKind(name: string): ScriptKind | undefined {
  return (Object.keys(NAMES) as ScriptKind[]).find((kind) => NAMES[kind].test(basename(name)));
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The key in the project's config.yaml that names each script. */
const SCRIPT_KEYS: Record<ScriptKind, string> = {
  unit: CONFIG_KEYS.unittestsScript,
  conformance: CONFIG_KEYS.conformanceTestsScript,
};
export const SCRIPTS_DIR = "test_scripts";

/**
 * The project a build belongs to: the folder that holds its plain_modules. A build folder
 * elsewhere belongs to the folder of its spec.
 */
export function projectRootFor(plainFile: string, buildDir: string): string {
  const parts = resolve(buildDir).split(sep);
  const index = parts.lastIndexOf("plain_modules");
  return index > 0 ? parts.slice(0, index).join(sep) : dirname(resolve(plainFile));
}

/** The one script of a kind in a folder, by the names the skills give them; two or more say which. */
function onlyScriptIn(dir: string, kind: ScriptKind): { path?: string; several?: string[] } {
  if (!existsSync(dir)) return {};
  const candidates = readdirSync(dir)
    .filter((name) => scriptKind(name) === kind && isFile(join(dir, name)))
    .sort();
  if (candidates.length === 1) return { path: join(dir, candidates[0]!) };
  return candidates.length > 1 ? { several: candidates } : {};
}

/**
 * The project's testing scripts, looked for in this order:
 *
 * 1. `config.yaml` at the project root - `unittests-script:` and `conformance-tests-script:`,
 *    paths from the root;
 * 2. the project root itself - the one `run_unittests*.sh` / `run_conformance_tests*.sh` there;
 * 3. `test_scripts/` - the one of each there.
 *
 * A folder holding two of a kind does not say which is meant: it is skipped, and noted, so the
 * error that stops the build can say to name one in config.yaml.
 */
export function findTestScripts(root: string): TestScripts {
  const found: TestScripts = {};
  const notes: Partial<Record<ScriptKind, string>> = {};
  const config = readProjectConfig(root);
  for (const kind of Object.keys(SCRIPT_KEYS) as ScriptKind[]) {
    const named = kind === "unit" ? config.unittestsScript : config.conformanceTestsScript;
    if (named !== undefined) {
      const path = resolve(root, named.trim());
      // Agents write in plain_modules: a script there could be changed by the work it judges.
      if (path.split(sep).includes("plain_modules")) {
        notes[kind] = `${CONFIG_FILE} names ${named.trim()} as the ${SCRIPT_KEYS[kind]}, inside plain_modules - where agents write, so it is not used.`;
      } else if (isFile(path)) {
        found[kind] = path;
        continue;
      } else {
        notes[kind] = `${CONFIG_FILE} names ${named.trim()} as the ${SCRIPT_KEYS[kind]}, and there is no such file.`;
      }
    }
    for (const dir of [root, join(root, SCRIPTS_DIR)]) {
      const { path, several } = onlyScriptIn(dir, kind);
      if (path !== undefined) {
        found[kind] = path;
        break;
      }
      if (several !== undefined && notes[kind] === undefined) {
        notes[kind] = `${dir === root ? "The project root" : `${SCRIPTS_DIR}/`} holds ${several.join(", ")} - name the one to use in ${CONFIG_FILE}.`;
      }
    }
  }
  if (Object.keys(notes).length > 0) found.notes = notes;
  return found;
}

const SKILL: Record<ScriptKind, { skill: string; file: string; what: string }> = {
  unit: { skill: "implement-unit-testing-script", file: "run_unittests", what: "unit testing script" },
  conformance: { skill: "implement-conformance-testing-script", file: "run_conformance_tests", what: "conformance testing script" },
};

/** Raised before a build starts when the script that would decide it is done is missing. */
export class MissingTestScriptError extends Error {
  // Declared fields, not parameter properties: node's own type stripping cannot run those.
  readonly moduleName: string;
  readonly kind: ScriptKind;

  constructor(moduleName: string, kind: ScriptKind, note?: string) {
    const { skill, file, what } = SKILL[kind];
    super(
      [
        `Stopped before building ${moduleName}: it has no ${what}, so nothing can decide when its ${kind === "unit" ? "unit" : "conformance"} tests pass.`,
        ...(note !== undefined ? ["", note] : []),
        "",
        "What to change in the project:",
        `- Add one with the \`${skill}\` skill: it writes \`${SCRIPTS_DIR}/${file}_<language>.sh\`.`,
        `- It is looked for in \`${CONFIG_FILE}\` at the project root (\`${SCRIPT_KEYS[kind]}: <path>\`), then in the root,`,
        `  then in \`${SCRIPTS_DIR}/\` - one ${file}*.sh in either folder is used.`,
        "",
        "Then build again.",
      ].join("\n"),
    );
    this.name = "MissingTestScriptError";
    this.moduleName = moduleName;
    this.kind = kind;
  }
}

/** The scripts a build needs, or the error that stops it before it starts. */
export function requireTestScripts(
  moduleName: string,
  scripts: TestScripts,
  needs: { conformance: boolean },
): asserts scripts is TestScripts & { unit: string } {
  if (scripts.unit === undefined) throw new MissingTestScriptError(moduleName, "unit", scripts.notes?.unit);
  if (needs.conformance && scripts.conformance === undefined) {
    throw new MissingTestScriptError(moduleName, "conformance", scripts.notes?.conformance);
  }
}

/**
 * The scripts that decide an agent's work, in its prompt - only those that will be run on it: a
 * conformance testing script an agent's work is never judged by is left out. The whole script,
 * read from the project as it is now.
 */
export function withTestingScripts(prompt: string, scripts: TestScripts, kinds: ScriptKind[], root: string): string {
  const used = kinds.filter((kind) => scripts[kind] !== undefined);
  if (used.length === 0) return prompt;
  const named = (path: string) => (path.startsWith(`${root}${sep}`) ? path.slice(root.length + 1) : basename(path));
  const rendered = used.map((kind) => {
    const path = scripts[kind]!;
    return `<script kind="${kind === "unit" ? "unit tests" : "conformance tests"}" path="${named(path)}">\n${readFileSync(path, "utf8").trimEnd()}\n</script>`;
  });

  const tools = used.map((kind) => (kind === "unit" ? "run_unit_tests" : "run_conformance_tests")).join(" and ");
  return [
    "<testing scripts>",
    rendered.join("\n\n"),
    "</testing scripts>",
    "",
    `The harness decides whether your work is done by running ${used.length === 1 ? "this script" : "these scripts"} itself, ` +
      (readProjectConfig(root).testingScripts === "host"
        ? "in place on the host machine, against the host codebase it merges your code into: "
        : "on the host machine - not in your VM - on a fresh copy of your work: ") +
      used
        .map((kind) => (kind === "unit" ? "the unit testing script as `<script> <build folder>`" : "the conformance testing script as `<script> <build folder> <whole conformance suite folder>`"))
        .join(", ") +
      ". Make the tests pass the way the script runs them.",
    `${used.length === 1 ? "It is" : "They are"} shown so you know what runs your tests - not to be run by you. ${used.length === 1 ? "It is" : "They are"} not in your ` +
      `workspace, and the path above is the project's, not one you can reach. Never copy, recreate or adapt ${used.length === 1 ? "it" : "them"} in the ` +
      `codebase, and never write a test runner of your own: call ${tools}, which run ${used.length === 1 ? "it" : "them"} exactly as the harness does - ` +
      "that run is the one that counts. Run a single test or file with bash while you work, as you like.",
    "Your bash runs in a Linux VM; these scripts run on the host, in its environment - its toolchains, its operating " +
      "system. Something that works in your shell can still fail there, and only the host's run counts. What the code " +
      "needs to be built and run belongs in the code (its dependency manifest), never only in your VM.",
    "",
    prompt,
  ].join("\n");
}

export interface ScriptRun {
  /** How the run is shown: the script's name, as the project calls it. */
  command: string;
  exitCode: number;
  output: string;
  /** Stopped by the time limit: counted as failed. */
  timedOut?: boolean;
  /** The time limit it ran under. */
  timeoutMs: number;
  /** Where the whole output is, when it was too long to be shown whole. */
  log?: string;
  /** What an agent that read the whole of it said failed and why - for the judge and whoever fixes it. */
  summary?: string;
}

/**
 * Where one script run is staged - in the project's scratch, and new for every run: the scripts
 * work in /tmp/<lang>_<basename of the build>, so the build is named for the module and this run
 * too, and no two runs - two modules testing at once - share that folder.
 */
function stagingFor(buildDir: string): { root: string; build: string; tests: string } {
  const key = randomUUID().slice(0, 12);
  const root = join(vmScratchDir(buildDir), "scripts", key);
  return { root, build: join(root, `${basename(dirname(resolve(buildDir)))}-${key}`), tests: join(root, "tests") };
}

/** The code, copied for a run; how many files. */
function stageBuild(buildDir: string, target: string): number {
  // There even when the build is empty: the scripts cd into it.
  mkdirSync(target, { recursive: true });
  const files = listFiles(buildDir);
  for (const file of files) {
    mkdirSync(dirname(join(target, file)), { recursive: true });
    copyFileSync(join(buildDir, file), join(target, file));
  }
  return files.length;
}

/** Every functionality's tests in one folder. A name already taken is renamed, never overwritten. */
function stageTests(testsDirs: string[], target: string): number {
  mkdirSync(target, { recursive: true });
  const taken = new Set<string>();
  testsDirs.forEach((dir, index) => {
    if (!existsSync(dir)) return;
    for (const file of listFiles(dir)) {
      let name = file;
      if (taken.has(name)) {
        const renamed = `${index + 1}_${basename(file)}`;
        name = dirname(file) === "." ? renamed : join(dirname(file), renamed);
      }
      taken.add(name);
      mkdirSync(dirname(join(target, name)), { recursive: true });
      copyFileSync(join(dir, file), join(target, name));
    }
  });
  return taken.size;
}

/** What the project calls a script: its path from the spec's folder when it is under it. */
function shown(script: string): string {
  const parent = dirname(dirname(script));
  return script.startsWith(`${parent}/`) ? script.slice(parent.length + 1) : basename(script);
}

/** How long a test run may take: the command time limit. Over it, the run counts as failed. */
let scriptTimeoutMs = COMMAND_TIMEOUT_MS;

/** For tests: a shorter limit than two minutes. */
export function setScriptTimeoutForTests(ms: number | undefined): void {
  scriptTimeoutMs = ms ?? COMMAND_TIMEOUT_MS;
}

/**
 * The project a build belongs to - the folder above its `plain_modules`, where the testing scripts'
 * own paths start - and whether its config.yaml has them run on the real folders, in place
 * (`testing-scripts: host`), rather than on a fresh copy.
 */
function projectOfBuild(buildDir: string): { root: string; inPlace: boolean } {
  const parts = resolve(buildDir).split(sep);
  const index = parts.lastIndexOf("plain_modules");
  const root = index > 0 ? parts.slice(0, index).join(sep) : dirname(resolve(buildDir));
  return { root, inPlace: readProjectConfig(root).testingScripts === "host" };
}

/** The model providers' keys, kept out of what runs on this machine: the tests are agents' code. */
const PROVIDER_KEY = /^(ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE|GOOGLE_GENERATIVE_AI|MISTRAL|GROQ|XAI|OPENROUTER|DEEPSEEK|CEREBRAS|TOGETHER|FIREWORKS)_API_KEY$|^AWS_BEARER_TOKEN_BEDROCK$/;

/**
 * A testing script run in place on this machine: `bash <script> <args>`, from the project, in a
 * process group of its own - so the time limit and a stopped job end it and all it started.
 */
async function runOnHost(root: string, script: string, args: string[], logDir: string): Promise<ScriptRun> {
  const timeoutMs = scriptTimeoutMs;
  const started = Date.now();
  reportActivity(`  ▶ ${shown(script)} on this machine, from ${root} (limit ${Math.round(timeoutMs / 1000)}s)`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !PROVIDER_KEY.test(key)));
  const child = spawn("bash", [script, ...args], { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data: Buffer) => (output += data.toString("utf8")));
  child.stderr.on("data", (data: Buffer) => (output += data.toString("utf8")));
  const killGroup = () => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, timeoutMs);
  const stop = currentStopSignal();
  stop?.addEventListener("abort", killGroup, { once: true });
  const exitCode = await new Promise<number>((done) => {
    child.on("close", (code) => done(code ?? 1));
    child.on("error", (error) => {
      output += String(error);
      done(1);
    });
  });
  clearTimeout(timer);
  stop?.removeEventListener("abort", killGroup);
  if (stop?.aborted) throw new Error("aborted");
  if (timedOut) output += `\n[stopped after ${Math.round(timeoutMs / 1000)}s, the time limit for a test run: counted as failed]`;
  const took = ((Date.now() - started) / 1000).toFixed(1);
  reportActivity(
    timedOut
      ? `  ✗ ${shown(script)} did not finish in ${Math.round(timeoutMs / 1000)}s - stopped, counted as failed`
      : `  ${exitCode === 0 ? "✓" : "✗"} ${shown(script)} exited ${exitCode} after ${took}s`,
  );
  const log = keepFullOutput(logDir, basename(script), output);
  return { command: shown(script), exitCode: timedOut ? 124 : exitCode, output: truncateOutput(output, log), timedOut, timeoutMs, ...(log !== undefined ? { log } : {}) };
}

/**
 * The harness's run of the unit testing script on the code as it is now - and run_unit_tests'.
 *
 * Always on this machine, never in a VM: the project's own script, at its own path, from the
 * project, in the environment it was written for. This and runConformanceScript are the only ways
 * the testing scripts are ever run. The code is a fresh copy for each run, named for its module and
 * the run - the scripts work in /tmp/<lang>_<basename of the build>, and two modules testing at once
 * must not share one - unless the project runs them in place (`testing-scripts: host`).
 */
export async function runUnitScript(buildDir: string, script: string): Promise<ScriptRun> {
  const project = projectOfBuild(buildDir);
  if (project.inPlace) return runOnHost(project.root, script, [resolve(buildDir)], buildDir);
  const staging = stagingFor(buildDir);
  rmSync(staging.root, { recursive: true, force: true });
  ensureInVmScratch(buildDir, staging.root);
  try {
    reportActivity(`  copying ${stageBuild(buildDir, staging.build)} files of the code for the unit testing script`);
    return await runOnHost(project.root, script, [staging.build], buildDir);
  } finally {
    rmSync(staging.root, { recursive: true, force: true });
  }
}

/**
 * The harness's run of the conformance testing script - and run_conformance_tests': the code, and
 * the codebase's whole conformance suite - every functionality's tests, and those carried up from
 * the modules below - in one folder, run at once. On this machine, as runUnitScript.
 */
export async function runConformanceScript(buildDir: string, testsDirs: string[], scripts: TestScripts): Promise<ScriptRun> {
  if (scripts.conformance === undefined) throw new Error("No conformance testing script to run.");
  const project = projectOfBuild(buildDir);
  const staging = stagingFor(buildDir);
  rmSync(staging.root, { recursive: true, force: true });
  ensureInVmScratch(buildDir, staging.root);
  try {
    let build: string;
    let tests: string;
    if (project.inPlace) {
      // The real folders: the real tests folder when there is one; several merged into one, first.
      build = resolve(buildDir);
      if (testsDirs.length === 1) tests = resolve(testsDirs[0]!);
      else {
        stageTests(testsDirs, staging.tests);
        tests = staging.tests;
      }
    } else {
      const code = stageBuild(buildDir, staging.build);
      const count = stageTests(testsDirs, staging.tests);
      reportActivity(`  copying ${code} files of the code and the whole conformance suite (${count} files) for the conformance testing script`);
      build = staging.build;
      tests = staging.tests;
    }
    return await runOnHost(project.root, scripts.conformance, [build, tests], buildDir);
  } finally {
    rmSync(staging.root, { recursive: true, force: true });
  }
}

/**
 * `run_unit_tests` / `run_conformance_tests`: the agent's final check before it finishes - the
 * project's testing script, run exactly as the harness will run it to decide whether the work is
 * done. It takes no command. Everything else - one test, one file, another configuration, while
 * the agent works - is what bash is for.
 */
export function createScriptTool(options: {
  kind: ScriptKind;
  script: string | undefined;
  run: () => Promise<ScriptRun>;
  runs: TestRun[];
  onRun?: (command: string, exitCode: number) => void;
}) {
  const unit = options.kind === "unit";
  const name = unit ? "run_unit_tests" : "run_conformance_tests";
  const script = options.script !== undefined ? basename(options.script) : "the project's script";
  return defineTool({
    name,
    label: unit ? "Run unit tests" : "Run conformance tests",
    description: unit
      ? `Final check before you finish: run the project's unit testing script, ${script}, on the code as it is now - exactly ` +
        "as the harness runs it to decide whether this is done. It takes no command. To run one test, one file, or the " +
        "tests any other way while you work, use bash."
      : `Run the project's conformance testing script, ${script}, on a fresh copy of the code with the whole conformance ` +
        "suite - exactly as the harness runs it to decide whether this is done. It takes no command. Your shell holds " +
        "only the tests, not the code, so this is how you run them against the code: while you work, and as the final " +
        "check before you finish.",
    promptSnippet: `${name}: the final check - the project's ${unit ? "unit" : "conformance"} testing script, as the harness runs it`,
    parameters: Type.Object({}),
    async execute() {
      const run = await options.run();
      options.runs.push({ command: run.command, exitCode: run.exitCode });
      options.onRun?.(run.command, run.exitCode);
      const text =
        run.timedOut === true
          ? timedOutFailure(run, unit ? "unit testing" : "conformance testing").replace("The harness ran", "You ran")
          : `${run.command} exited ${run.exitCode}\n\n${run.output}`;
      return {
        content: [{ type: "text" as const, text }],
        details: { command: run.command, exitCode: run.exitCode },
      };
    },
  });
}

/** A run the time limit stopped: failed, and what most often keeps a test run from ending. */
function timedOutFailure(run: ScriptRun, what: string): string {
  const limit = Math.round(run.timeoutMs / 1000);
  return [
    `The harness ran the project's ${what} script, \`${run.command}\`, and it had not finished after ${limit} seconds - the`,
    "time limit for a test run - so it was stopped, and counts as failed. This is what it had printed by then:",
    "",
    run.output.trimEnd(),
    "",
    "The output ends where it was stopped: the test running then, or the step after the last one it printed, is the one",
    "that does not finish. Most often a test waits for something that never comes:",
    "- a server or a watcher started in the foreground, instead of in the background and stopped afterwards;",
    "- a prompt waiting for input, or a command that pages its output;",
    "- a network call that never answers - a service on localhost that is not running, a host that is down;",
    "- a lock, a queue or a thread nothing releases, or a loop that never ends.",
    "Find it - run the tests on their own with bash, under `timeout`, a file or a case at a time - and fix what is wrong,",
    `in the test or in the code, against the specification. If the tests are only slow, make them faster: every run has`,
    `the same ${limit} seconds, and a skipped or deleted test does not count as a fix.`,
  ].join("\n");
}

/** What a failed script run means, for the agent that has to fix it. */
export function scriptFailure(run: ScriptRun, what: string): string {
  if (run.timedOut === true) return timedOutFailure(run, what);
  const cause =
    run.exitCode === 69
      ? "It exited 69: the toolchain it needs is not installed on this machine, where the testing scripts run. That cannot be " +
        "fixed from your sandbox - install_system_packages installs into your VM, not here. Say in your report exactly what is " +
        "missing, so the person can install it."
      : `Fix the cause and run the tests again. Do not remove or weaken a test to get a pass.`;
  return [
    `The harness ran the project's ${what} script, \`${run.command}\`, and it failed (exit ${run.exitCode}). That run is what`,
    "decides whether this is done - the script is at the top of your prompt, so you can see what it does.",
    "",
    run.output.trimEnd(),
    "",
    cause,
  ].join("\n");
}
