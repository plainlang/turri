import { fixMethod } from "./prompt.ts";
import { randomUUID } from "node:crypto";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { CONFIG_FILE, CONFIG_KEYS, projectConfigFile, readProjectConfig, stackConfigFileIn, stackOf } from "../config.ts";
import { reportActivity, reportLogNote, reportNote } from "./activity.ts";
import { ensureInModulesScratch, modulesScratchDir } from "./paths.ts";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { keepTestOutput, listFiles, shownTestOutput, type TestRun } from "./testing.ts";
import { digestFiles } from "./codebase.ts";
import { NOTES_FILE } from "./notes.ts";
import { COMMAND_TIMEOUT_MS, runCommand } from "./shell.ts";

/**
 * The project's testing scripts, and the harness's runs of them.
 *
 * An agent runs whatever it likes while it works. Whether the work is done is decided by the
 * project's own scripts - the ones the `implement-unit-testing-script` and
 * `implement-conformance-testing-script` skills write into `test_scripts/` and link from the spec -
 * run by the harness, never by the agent. The same script, the same way, every time: done is a
 * decision the project made, not one an agent makes about its own work.
 *
 * The scripts live beside the specs, outside `plain_modules`, so no agent can reach them. The harness's runs and the
 * agents' run_unit_tests and run_conformance_tests are the only ways they are ever run. They are the person's: they run
 * on this machine as the person would run them - unfenced, in the person's own environment (turri's model provider
 * keys left out) - through the host runner (shell.ts), which gives them a time limit and a stop. What they run on is the
 * project's choice (`testing-scripts-run-on:` in its config):
 *
 * - `in-place`, the default: the project's own script at its own path, from the project, on the real build and tests
 *   folders - so a script that finds things from its own path (a host codebase it merges the code into) finds them.
 * - `copy`: a fresh copy of the code, staged in the project's scratch with the script copied beside it - build output
 *   stays out of the code, two modules testing at once never share a folder, and nothing a test writes reaches the
 *   code.
 *
 * A copy is named for its module and the run: the scripts work in `/tmp/<lang>_<basename of the build>`, and every
 * module's build is called `code`.
 */

export type ScriptKind = "unit" | "conformance";

export interface TestScripts {
  /** `run_unittests_<lang>.sh <build>` */
  unit?: string;
  /** `run_conformance_tests_<lang>.sh <build> <conformance tests>` - the whole suite, at once. */
  conformance?: string;
  /**
   * `prepare_environment_<lang>.sh <build>` - optional: run on the build before every run of the
   * conformance testing script, which runs only once it passes. turri never writes one.
   */
  prepare?: string;
  /** Why a script was not found where one was looked for: a name in config.turri.yaml, two in a folder. */
  notes?: Partial<Record<ScriptKind | "prepare", string>>;
  /** Conformance was turned off: the conformance testing script is not run, found or not. */
  conformanceOff?: boolean;
  /** What the config has them run on: the code in place (the default, unset), or a fresh copy of the code. */
  runOn?: "copy" | "in-place";
}

/**
 * The scripts, with the conformance testing script set aside because conformance was turned
 * off: no conformance tests are written or run - not even those already in the codebase - and
 * no agent is shown it.
 */
export function withoutConformance(scripts: TestScripts): TestScripts {
  const { conformance: _ignored, prepare: _alsoIgnored, ...rest } = scripts;
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

/** The name the prepare script has: `prepare_environment_<lang>.sh`. */
const PREPARE_NAME = /^prepare_environment[^/]*\.sh$/i;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The key in the project's config.turri.yaml that names each script. */
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
function onlyScriptIn(dir: string, kind: ScriptKind | "prepare"): { path?: string; several?: string[] } {
  if (!existsSync(dir)) return {};
  const candidates = readdirSync(dir)
    .filter((name) => (kind === "prepare" ? PREPARE_NAME.test(name) : scriptKind(name) === kind) && isFile(join(dir, name)))
    .sort();
  if (candidates.length === 1) return { path: join(dir, candidates[0]!) };
  return candidates.length > 1 ? { several: candidates } : {};
}

/**
 * The project's testing scripts, looked for in this order:
 *
 * 1. `config.turri.yaml` at the project root, with the chosen stack's `config.turri.<stack>.yaml` over it -
 *    `unittests-script:` and `conformance-tests-script:`, paths from the root;
 * 2. the project root itself - the one `run_unittests*.sh` / `run_conformance_tests*.sh` there;
 * 3. `test_scripts/` - the one of each there.
 *
 * The prepare script - `prepare-environment-script:`, else the one `prepare_environment*.sh` - is looked for the same
 * way, and is optional: without one, the conformance testing script runs alone.
 *
 * A folder holding two of a kind does not say which is meant: it is skipped, and noted, so the
 * error that stops the build can say to name one in config.turri.yaml.
 */
export function findTestScripts(root: string, plainFile?: string, buildDir?: string): TestScripts {
  const found: TestScripts = {};
  const notes: Partial<Record<ScriptKind | "prepare", string>> = {};
  // The stack chosen, its file over the project's, when the project has one for it: its scripts.
  const stack = stackOf(root);
  const config = readProjectConfig(root, stack);
  const file = stack !== undefined ? `${stackConfigFileIn(root, stack)} (over ${projectConfigFile(root)})` : projectConfigFile(root);
  // Where a script is named: the stack's file, once one is chosen.
  const nameIn = stack !== undefined ? stackConfigFileIn(root, stack) : `${CONFIG_FILE} - or, for a project of several stacks, the stack's config.turri.<stack>.yaml`;
  if (config.testingScriptsRunOn !== undefined) found.runOn = config.testingScriptsRunOn;
  for (const kind of Object.keys(SCRIPT_KEYS) as ScriptKind[]) {
    const named = kind === "unit" ? config.unittestsScript : config.conformanceTestsScript;
    if (named !== undefined) {
      const path = resolve(root, named.trim());
      // Agents write in plain_modules: a script there could be changed by the work it judges.
      if (path.split(sep).includes("plain_modules")) {
        notes[kind] = `${file} names ${named.trim()} as the ${SCRIPT_KEYS[kind]}, inside plain_modules - where agents write, so it is not used.`;
      } else if (isFile(path)) {
        found[kind] = path;
        continue;
      } else {
        notes[kind] = `${file} names ${named.trim()} as the ${SCRIPT_KEYS[kind]}, and there is no such file.`;
      }
    }
    for (const dir of [root, join(root, SCRIPTS_DIR)]) {
      const { path, several } = onlyScriptIn(dir, kind);
      if (path !== undefined) {
        found[kind] = path;
        break;
      }
      if (several !== undefined && notes[kind] === undefined) {
        notes[kind] = `${dir === root ? "The project root" : `${SCRIPTS_DIR}/`} holds ${several.join(", ")} - name the one to use in ${nameIn}.`;
      }
    }
  }
  // Optional: found the same way, and nothing is missing without it.
  const prepareNamed = config.prepareEnvironmentScript;
  const preparePath = prepareNamed !== undefined ? resolve(root, prepareNamed.trim()) : undefined;
  if (preparePath !== undefined && preparePath.split(sep).includes("plain_modules")) {
    notes.prepare = `${file} names ${prepareNamed!.trim()} as the ${CONFIG_KEYS.prepareEnvironmentScript}, inside plain_modules - where agents write, so it is not used.`;
  } else if (preparePath !== undefined && isFile(preparePath)) {
    found.prepare = preparePath;
  } else {
    if (preparePath !== undefined) notes.prepare = `${file} names ${prepareNamed!.trim()} as the ${CONFIG_KEYS.prepareEnvironmentScript}, and there is no such file.`;
    for (const dir of [root, join(root, SCRIPTS_DIR)]) {
      const { path, several } = onlyScriptIn(dir, "prepare");
      if (path !== undefined) {
        found.prepare = path;
        break;
      }
      if (several !== undefined && notes.prepare === undefined) {
        notes.prepare = `${dir === root ? "The project root" : `${SCRIPTS_DIR}/`} holds ${several.join(", ")} - name the one to use in ${nameIn}, as ${CONFIG_KEYS.prepareEnvironmentScript}:.`;
      }
    }
  }
  if (Object.keys(notes).length > 0) found.notes = notes;
  return found;
}

/**
 * The exit code a testing script ends with when the tests passed and only its static checks - the formatter in check
 * mode, the linter, the type checker - did not. Every other failure is the script's own exit code. The harness tells the
 * two apart: a unit run says it was the static checks, and a conformance run sends its tests' findings straight to the
 * conformance agent, with no judge asked whether the code or the tests are wrong.
 */
export const STATIC_CHECKS_FAILED = 80;

/** Whether a failed run of a testing script failed on its static checks alone: the tests passed. */
export function staticChecksOnly(run: { exitCode: number; timedOut?: boolean }): boolean {
  return run.exitCode === STATIC_CHECKS_FAILED && run.timedOut !== true;
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
        `- It is looked for in \`${CONFIG_FILE}\` at the project root (\`${SCRIPT_KEYS[kind]}: <path>\`) - or the module's own`,
        `  \`config.turri.<stack>.yaml\` beside it, the stack chosen with /stack or --stack, for a project of several stacks - then in the root,`,
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
  const script = (kind: string, path: string) => `<script kind="${kind}" path="${named(path)}">\n${readFileSync(path, "utf8").trimEnd()}\n</script>`;
  // The prepare script runs before the conformance testing script: shown with it, before it.
  const prepare = used.includes("conformance") ? scripts.prepare : undefined;
  const rendered = used.flatMap((kind) => [
    ...(kind === "conformance" && prepare !== undefined ? [script("prepare environment", prepare)] : []),
    script(kind === "unit" ? "unit tests" : "conformance tests", scripts[kind]!),
  ]);

  const tools = used.map((kind) => (kind === "unit" ? "run_unit_tests" : "run_conformance_tests")).join(" and ");
  const inPlace = (scripts.runOn ?? readProjectConfig(root).testingScriptsRunOn) !== "copy";
  return [
    "<testing scripts>",
    rendered.join("\n\n"),
    "</testing scripts>",
    "",
    `The harness decides whether your work is done by running ${used.length === 1 ? "this script" : "these scripts"} itself, ` +
      (inPlace
        ? "on this machine, in place, against the host codebase it merges your code into: "
        : "on this machine, on a fresh copy of your work: ") +
      used
        .map((kind) =>
          kind === "unit"
            ? "the unit testing script as `<script> <build folder>`"
            : `${prepare !== undefined ? "the prepare script as `<script> <build folder>` and, once it passes, " : ""}the conformance testing script as \`<script> <build folder> <whole conformance suite folder>\``,
        )
        .join(", ") +
      ". Make the tests pass the way the script runs them.",
    `A testing script may run static checks before its tests - the formatter in check mode, the linter, the type checker, ` +
      `on what it tests: the code for the unit testing script, the tests for the conformance one. They count as the tests ` +
      `do, and exit ${STATIC_CHECKS_FAILED} means the tests passed and only the checks did not. Formatting is yours: run the ` +
      "formatter the script checks with on the files you change, in your shell, before the final run.",
    `${used.length === 1 ? "It is" : "They are"} shown so you know what runs your tests - not to be run by you. ${used.length === 1 ? "It is" : "They are"} not in your ` +
      `workspace, and the path above is the project's, not one you can reach. Never copy, recreate or adapt ${used.length === 1 ? "it" : "them"} in the ` +
      `codebase, and never write a test runner of your own: call ${tools}, which run ${used.length === 1 ? "it" : "them"} exactly as the harness does - ` +
      "that run is the one that counts. Run a single test or file with bash while you work, as you like.",
    "They run in the person's own environment, with this machine's toolchains - the ones your shell has too. A toolchain " +
      "or system library the script needs and this machine lacks is not yours to install: say what is missing, and the " +
      "person installs it. What the code needs to be built and run belongs in the code (its dependency manifest), so " +
      `${inPlace ? "it builds where the script puts it" : "a fresh copy of it builds"}.`,
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
  /** How long it ran, from start to end - or to the limit that stopped it. */
  elapsedMs?: number;
  /** Where the whole output is, when it was too long to be shown whole. */
  log?: string;
  /** What an agent that read the whole of it said failed and why - for the judge and whoever fixes it. */
}

/**
 * Where one script run is staged - in the project's scratch, and new for every run: the scripts
 * work in /tmp/<lang>_<basename of the build>, so the build is named for the module and this run
 * too, and no two runs - two modules testing at once - share that folder.
 */
function stagingFor(buildDir: string): { root: string; build: string; tests: string } {
  const key = randomUUID().slice(0, 12);
  const root = join(modulesScratchDir(buildDir), "scripts", key);
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
 * own paths start - and whether they run on the code in place (the default), rather than on a fresh copy
 * (`testing-scripts-run-on: copy`).
 */
function projectOfBuild(buildDir: string): { root: string; inPlace: boolean } {
  const parts = resolve(buildDir).split(sep);
  const index = parts.lastIndexOf("plain_modules");
  const root = index > 0 ? parts.slice(0, index).join(sep) : dirname(resolve(buildDir));
  // The stack chosen decides, when it says.
  return { root, inPlace: readProjectConfig(root, stackOf(root)).testingScriptsRunOn !== "copy" };
}

/** The model providers' keys, kept out of what runs on this machine: the tests are agents' code. */
const PROVIDER_KEY = /^(ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE|GOOGLE_GENERATIVE_AI|MISTRAL|GROQ|XAI|OPENROUTER|DEEPSEEK|CEREBRAS|TOGETHER|FIREWORKS)_API_KEY$|^AWS_BEARER_TOKEN_BEDROCK$/;

/** The environment a testing script runs in: the person's own, but for turri's model providers' keys. */
function scriptEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !PROVIDER_KEY.test(key)));
}

/**
 * A testing script run on this machine - `bash <script> <args>` from `cwd`, through the host runner: a process group of
 * its own, so the time limit and a stopped job end it and all it started. `named`: the path the script names itself by
 * in its output, shown as the project's script.
 */
async function runScript(cwd: string, script: string, args: string[], logDir: string, options: { limitMs?: number; named?: string } = {}): Promise<ScriptRun> {
  const timeoutMs = options.limitMs ?? scriptTimeoutMs;
  const started = Date.now();
  // Where and how it runs, for the log: how it ended is what the activity says.
  reportLogNote(`  ▶ ${shown(script)} on this machine, ${options.named !== undefined ? "on a fresh copy of the code" : `in place, from ${cwd}`} (limit ${Math.round(timeoutMs / 1000)}s)`);
  const { exitCode, output, timedOut } = await runCommand(`bash ${[options.named ?? script, ...args].map(quote).join(" ")}`, {
    cwd,
    env: scriptEnv(),
    timeoutMs,
    timeoutNote: (ms) => `\n[stopped after ${Math.round(ms / 1000)}s, the time limit for a test run: counted as failed]`,
  });
  const took = ((Date.now() - started) / 1000).toFixed(1);
  reportActivity(
    timedOut === true
      ? `  ✗ ${shown(script)} did not finish in ${Math.round(timeoutMs / 1000)}s - stopped, counted as failed`
      : `  ${exitCode === 0 ? "✓" : "✗"} ${shown(script)} exited ${exitCode} after ${took}s`,
  );
  // The copy's path, where the script names itself, reads as the project's script.
  const text = options.named !== undefined ? output.split(options.named).join(shown(script)) : output;
  const noted = withScriptLineNote(text, script);
  // Its failures, counts and end are what the agent is shown; the whole is kept, a read_output away.
  const log = keepTestOutput(logDir, basename(script), noted);
  return {
    command: shown(script),
    exitCode: timedOut === true ? 124 : exitCode,
    output: shownTestOutput(noted, log),
    timedOut: timedOut === true,
    timeoutMs,
    elapsedMs: Date.now() - started,
    ...(log !== undefined ? { log } : {}),
  };
}

/** What bash says when a line of the script itself cannot run: a command or file that is not there, or not runnable. */
const OWN_LINE_FAILURE = /: (No such file or directory|command not found|Permission denied)$/;

/** The script lines already told to the person, by script, line and error - once each, in this process. */
const toldScriptLines = new Set<string>();

/**
 * A run's output, with a note at its top when a line of the script itself fails where it runs - a macOS-only
 * `/usr/libexec/java_home` in a Linux sandbox. The agent is told it is the person's script, not its code, so it does not
 * go looking for what the line names; the person is told once, in the job's log.
 */
function withScriptLineNote(output: string, script: string): string {
  const name = basename(script);
  const prefix = new RegExp(`^(?:.*[/\\\\])?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: line (\\d+): (.+)$`);
  const failures = output
    .split("\n")
    .map((line) => prefix.exec(line))
    .filter((found): found is RegExpExecArray => found !== null && OWN_LINE_FAILURE.test(found[2]!));
  if (failures.length === 0) return output;
  const notes = failures.map(([, line, error]) => {
    const key = `${script}\n${line}\n${error}`;
    if (!toldScriptLines.has(key)) {
      toldScriptLines.add(key);
      reportNote(`  ⚠ line ${line} of ${name} fails where it runs - \`${error}\`: the script is yours to fix; the agents are told it is not theirs`);
    }
    return (
      `[turri: line ${line} of the project's testing script, ${name}, fails where it runs - \`${error}\`. That is the person's ` +
      "script, not your code: they have been told. Do not go looking for what it names; judge the run by what the tests " +
      "themselves report.]"
    );
  });
  return `${[...new Set(notes)].join("\n")}\n\n${output}`;
}

/** A path, quoted for bash. */
function quote(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/** A testing script run on a fresh copy of the code: the project's script copied fresh into the staging folder, beside it. */
async function runOnCopy(stagingRoot: string, script: string, args: string[], logDir: string, limitMs?: number): Promise<ScriptRun> {
  const copy = join(stagingRoot, basename(script));
  writeFileSync(copy, readFileSync(script));
  return runScript(stagingRoot, script, args, logDir, { named: copy, ...(limitMs !== undefined ? { limitMs } : {}) });
}

/**
 * The harness's run of the unit testing script on the code as it is now - and run_unit_tests'.
 *
 * On this machine, on the code in place, or - `testing-scripts-run-on: copy` - on a fresh copy of the code
 * (see the top of this file). This and runConformanceScript are the only ways the testing
 * scripts are ever run.
 */
export async function runUnitScript(buildDir: string, script: string): Promise<ScriptRun> {
  return runOnCode(buildDir, script, "unit testing script");
}

/** How long the last passing run of a script on a codebase took, by codebase and script. */
const lastPassing = new Map<string, number>();

/** How long the last passing run of `script` on the code in `buildDir` took, in this process - undefined before one has. */
export function lastPassingMs(buildDir: string, script: string): number | undefined {
  return lastPassing.get(`${resolve(buildDir)}\n${script}`);
}

/**
 * A script that takes the code folder - the unit testing script - run where the testing scripts
 * run. `change`: what to do to the fresh copy before it runs - only where there is a copy; never in place.
 */
export async function runOnCode(
  buildDir: string,
  script: string,
  what: string,
  change?: (copy: string) => void,
  /** A time limit of its own, in place of a test run's. */
  limitMs?: number,
): Promise<ScriptRun> {
  const project = projectOfBuild(buildDir);
  if (project.inPlace) {
    if (change !== undefined) throw new Error("This runs only where the testing scripts run on a copy: here they run in place, on the code itself.");
    return runScript(project.root, script, [resolve(buildDir)], buildDir);
  }
  const staging = stagingFor(buildDir);
  rmSync(staging.root, { recursive: true, force: true });
  ensureInModulesScratch(buildDir, staging.root);
  try {
    reportActivity(`  copying ${stageBuild(buildDir, staging.build)} files of the code for the ${what}`);
    change?.(staging.build);
    const started = Date.now();
    const run = await runOnCopy(staging.root, script, [staging.build], buildDir, limitMs);
    if (change === undefined && run.exitCode === 0) lastPassing.set(`${resolve(buildDir)}\n${script}`, Date.now() - started);
    return run;
  } finally {
    rmSync(staging.root, { recursive: true, force: true });
  }
}

/**
 * The harness's run of the conformance testing script - and run_conformance_tests': the code, and
 * the codebase's whole conformance suite - every functionality's tests, and those carried up from
 * the modules below - in one folder, run at once. As runUnitScript runs: on a copy of the code staged beside the tests,
 * or in place.
 */
export async function runConformanceScript(buildDir: string, testsDirs: string[], scripts: TestScripts): Promise<ScriptRun> {
  if (scripts.conformance === undefined) throw new Error("No conformance testing script to run.");
  const project = projectOfBuild(buildDir);
  const staging = stagingFor(buildDir);
  rmSync(staging.root, { recursive: true, force: true });
  ensureInModulesScratch(buildDir, staging.root);
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
      const prepared = scripts.prepare !== undefined ? await runOnCopy(staging.root, scripts.prepare, [staging.build], buildDir) : undefined;
      if (prepared !== undefined && prepared.exitCode !== 0) return preparationFailed(prepared, scripts.conformance);
      return withPrepared(await runOnCopy(staging.root, scripts.conformance, [staging.build, staging.tests], buildDir), prepared);
    }
    // The environment first, on the same build the conformance tests get: the conformance testing script runs only once it passes.
    const prepared = scripts.prepare !== undefined ? await runScript(project.root, scripts.prepare, [build], buildDir) : undefined;
    if (prepared !== undefined && prepared.exitCode !== 0) return preparationFailed(prepared, scripts.conformance);
    return withPrepared(await runScript(project.root, scripts.conformance, [build, tests], buildDir), prepared);
  } finally {
    rmSync(staging.root, { recursive: true, force: true });
  }
}

/** A prepare script that failed: the run, said to be the preparation's - the conformance tests were not run. */
function preparationFailed(prepared: ScriptRun, conformance: string): ScriptRun {
  return {
    ...prepared,
    output: `${prepared.command} - the project's prepare script, run on the build before ${shown(conformance)} - exited ${prepared.exitCode}, so the conformance tests were not run.\n\n${prepared.output}`,
  };
}

/** A conformance run, with a line at its top saying the prepare script ran first and passed. */
function withPrepared(run: ScriptRun, prepared: ScriptRun | undefined): ScriptRun {
  return prepared === undefined ? run : { ...run, output: `${prepared.command} prepared the build first, and passed.\n\n${run.output}` };
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
  /** Watches the agent's runs for a loop: told once, then its turn is ended. */
  watch?: LoopWatch;
}) {
  const unit = options.kind === "unit";
  const name = unit ? "run_unit_tests" : "run_conformance_tests";
  const script = options.script !== undefined ? basename(options.script) : "the project's script";
  return defineTool({
    name,
    label: unit ? "Run unit tests" : "Run conformance tests",
    description: unit
      ? `Final check before you finish: run the project's unit testing script, ${script}, ` +
        "on the code as it is now - exactly as the harness runs it to decide whether this is done. It takes no command. To " +
        "run one test, one file, or the tests any other way while you work, use bash."
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
      const loop = options.watch?.see(run);
      return {
        content: [{ type: "text" as const, text: loop === undefined ? text : `${text}\n\n${loopNotice(loop)}` }],
        details: { command: run.command, exitCode: run.exitCode, ...(loop !== undefined ? { loop } : {}) },
        // Going round in circles a second time: its turn ends here, and the harness takes it from there.
        ...(loop === "stop" ? { terminate: true } : {}),
      };
    },
  });
}

/** How many of the agent's own runs failing the same way, one after another, are a loop. */
export const LOOP_RUNS = 6;

/**
 * The agent's own test runs, watched for a loop: an agent stuck on a failure tends to try the same few changes in turn -
 * three signatures of a stand-in function, say - running the tests after each, dozens of times in one turn, and never
 * reads what would tell it the cause. Two things say it is circling: the code folder back exactly as it was at an
 * earlier failing run (its notes aside), or LOOP_RUNS failing runs in a row the same way. The first time, it is told
 * so with the run; the second, its turn is ended, and `stuck` says so until the harness has dealt with it. A passing
 * run clears it all.
 */
export interface LoopWatch {
  /** A run of the agent's: undefined, or "warn" the first time it is circling, "stop" the second. */
  see(run: ScriptRun): "warn" | "stop" | undefined;
  /** It was stopped for going round in circles, and the harness has not dealt with it yet. */
  readonly stuck: boolean;
  /** How many failing runs since its last passing one. */
  readonly failing: number;
  /** Dealt with: it starts counting again - the states it has failed in still remembered. */
  reset(): void;
}

export function createLoopWatch(dir: string): LoopWatch {
  /** The code folder at each failing run, as a digest of its files. */
  const failedStates = new Set<string>();
  let strikes = 0;
  let stuck = false;
  let failing = 0;
  let last: string | undefined;
  let streak = 0;
  const stateOf = () =>
    [...digestFiles(dir)]
      .filter(([file]) => file !== NOTES_FILE && !file.endsWith(`/${NOTES_FILE}`))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, digest]) => `${file} ${digest}`)
      .join("\n");
  return {
    see(run) {
      if (run.exitCode === 0 && run.timedOut !== true) {
        failedStates.clear();
        strikes = 0;
        stuck = false;
        failing = 0;
        last = undefined;
        streak = 0;
        return undefined;
      }
      failing += 1;
      const state = stateOf();
      const signature = failureSignature(run);
      streak = signature === last ? streak + 1 : 1;
      last = signature;
      const revisited = failedStates.has(state);
      failedStates.add(state);
      if (!revisited && streak < LOOP_RUNS) return undefined;
      streak = 0;
      strikes += 1;
      if (strikes === 1) return "warn";
      stuck = true;
      return "stop";
    },
    get stuck() {
      return stuck;
    },
    get failing() {
      return failing;
    },
    reset() {
      strikes = 0;
      stuck = false;
      streak = 0;
      last = undefined;
    },
  };
}

/** What the agent is told with a run when it is going round in circles. */
function loopNotice(loop: "warn" | "stop"): string {
  if (loop === "warn") {
    return [
      "You are going round in circles: the code is back exactly as it was at an earlier failing run, or the tests have",
      "failed the same way run after run. Another variation on what you have tried will not fix it. Stop editing and",
      "find the cause first: read the code under test where the failure points - how it calls what the test replaces,",
      "with which arguments - and the test, line by line, against it. Then make the one change that the cause calls for.",
    ].join("\n");
  }
  return [
    "You are still going round in circles, so your turn ends here. Change nothing more now: a debugger will look at",
    "the failure with fresh eyes, and you will be given what it finds.",
  ].join("\n");
}

/**
 * How long a run took against its time limit, in a line: for whoever judges it or works out its cause - so a run that
 * ended on its own is never taken for one the limit stopped, nor the other way.
 */
export function runTiming(run: Pick<ScriptRun, "exitCode" | "timedOut" | "timeoutMs" | "elapsedMs">): string {
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const limit = seconds(run.timeoutMs);
  if (run.timedOut === true) {
    return `The time limit stopped this run: it had run ${seconds(run.elapsedMs ?? run.timeoutMs)} of the ${limit} a test run may take, and had not finished.`;
  }
  const took = run.elapsedMs !== undefined ? `after ${seconds(run.elapsedMs)} of the ${limit} a test run may take` : `well within the ${limit} a test run may take`;
  return `This run ended on its own - exit ${run.exitCode}, ${took}. The time limit did not stop it and played no part in how it ended.`;
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

/** A command `timeout` could not start, or a shell could not find - on a line of its own. */
const COULD_NOT_RUN = /^(?:[^:]*: )?failed to run command [‘'`"]?([\w.+-]+)[’'`"]?: No such file or directory$/;
const NOT_FOUND = /^(?:[^:]*: )?(?:line \d+: )?([\w.+-]+): command not found$/;

/**
 * What a failed run says is not installed where it ran - the command, when its output names it - or undefined when
 * the run failed for another reason. A missing command is the cause only on evidence that it ended the run: exit 69,
 * the testing scripts' own way to say a toolchain is missing, or 127, what a shell or `timeout` gives for a command it
 * could not find - else a command not found on the last line the run printed, nothing having run after it. Earlier in
 * the output it is a warning, not the failure: a shell profile's, an optional tool probed for, a fallback taken - and a
 * run that failed for its own reasons is the agent's to fix, not a stop for the person.
 */
export function missingToolchain(run: Pick<ScriptRun, "exitCode" | "output">): { command?: string } | undefined {
  if (run.exitCode === 0) return undefined;
  const lines = run.output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const named = (line: string): string | undefined => COULD_NOT_RUN.exec(line)?.[1] ?? NOT_FOUND.exec(line)?.[1];
  if (run.exitCode === 69 || run.exitCode === 127) {
    // The command is the last one named: the one the run stopped on.
    for (let at = lines.length - 1; at >= 0; at -= 1) {
      const command = named(lines[at]!);
      if (command !== undefined) return { command };
    }
    return {};
  }
  const last = lines.at(-1);
  const command = last !== undefined ? named(last) : undefined;
  return command !== undefined ? { command } : undefined;
}

/** Where `command` is on this machine's PATH, or undefined when it is not there. */
export function onThisMachine(command: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const path = join(dir, command);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

/** What a failed script run means, for the agent that has to fix it. */
export function scriptFailure(run: ScriptRun, what: string): string {
  if (run.timedOut === true) return timedOutFailure(run, what);
  const missing = missingToolchain(run);
  const needs = missing?.command !== undefined ? `\`${missing.command}\`` : "the toolchain it needs";
  const cause =
    missing !== undefined
      ? `It could not run: ${needs} is not installed on this machine, where the testing scripts run. That is the person's ` +
        "to install, not yours: do not work around it, and do not change the code or the tests for it. Call " +
        "report_environment_error with exactly what is missing."
      : [
          ...fixMethod({
            what: what === "unit testing" ? "unit tests" : "conformance tests",
            fixes: what === "unit testing" ? "code" : "tests",
            runTool: what === "unit testing" ? "run_unit_tests" : "run_conformance_tests",
          }),
        ].join("\n");
  return [
    `The harness ran the project's ${what} script, \`${run.command}\`, and it failed (exit ${run.exitCode}).`,
    ...(missing === undefined && staticChecksOnly(run)
      ? [
          `Exit ${STATIC_CHECKS_FAILED}: the tests pass, and the script's static checks - the formatter, the linter, the type checker - ` +
            "do not. Fix each finding at its cause; never silence one (a type-ignore or lint-disable comment, a rule " +
            "turned off in the checker's configuration). A formatting finding goes by running the formatter.",
        ]
      : []),
    "",
    run.output.trimEnd(),
    "",
    cause,
  ].join("\n");
}

/** How many rounds running the same failure, taken the same way, is nothing changing. */
export const STUCK_ROUNDS = 3;

/**
 * A failing run, as a fingerprint: the lines that say what went wrong, without what changes from run
 * to run - numbers, times, paths, ids. Two runs failing the same way have the same one.
 */
export function failureSignature(run: ScriptRun): string {
  if (run.timedOut === true) return "the run did not finish in the time limit";
  const lines = run.output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const telling = lines.filter((line) => /error|exception|fail|refused|timed out|cannot|unable|not found|denied/i.test(line));
  const normal = (line: string) =>
    line
      // Colour codes, and ids a service makes up for each response - a request's UUID, a correlation id in hex.
      .replace(/\x1B\[[0-9;]*m/g, "")
      .replace(/\/[^\s:'"]+/g, "<path>")
      .replace(/\b[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "<id>")
      .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{4,}\b/gi, "<id>")
      .replace(/\b[0-9a-f]{8,}\b/gi, "<id>")
      .replace(/\d+(\.\d+)?/g, "<n>")
      .replace(/\s+/g, " ");
  return [...new Set((telling.length > 0 ? telling : lines.slice(-20)).map(normal))].slice(0, 30).join("\n");
}
