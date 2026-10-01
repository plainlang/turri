import { fixMethod } from "./prompt.ts";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { CONFIG_FILE, CONFIG_KEYS, configModuleOf, configModuleOfBuild, moduleConfigFile, readProjectConfig } from "../config.ts";
import { currentStopSignal, reportActivity } from "./activity.ts";
import { ensureInVmScratch, vmScratchDir } from "./paths.ts";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { keepFullOutput, listFiles, truncateOutput, type TestRun } from "./testing.ts";
import { COMMAND_TIMEOUT_MS, runInVm } from "./vm.ts";

/**
 * The project's testing scripts, and the harness's runs of them.
 *
 * An agent runs whatever it likes while it works. Whether the work is done is decided by the
 * project's own scripts - the ones the `implement-unit-testing-script` and
 * `implement-conformance-testing-script` skills write into `test_scripts/` and link from the spec -
 * run by the harness, never by the agent. The same script, the same way, every time: done is a
 * decision the project made, not one an agent makes about its own work.
 *
 * The scripts live beside the specs, outside `plain_modules`, so no agent can reach them. The
 * harness's runs and the agents' run_unit_tests and run_conformance_tests are the only ways they are
 * ever run, and where is the project's choice (`run-testing-scripts-in:` in its config):
 *
 * - `vm`, the default: in the module's VM - the one the agents' bash runs in, with the same
 *   toolchains - on a fresh copy of the code, the script copied in beside it. What passes in an
 *   agent's shell passes there, and nothing the agents wrote runs on this machine.
 * - `host`: on this machine, in place - the project's own script at its own path, from the project,
 *   on the real build and tests folders, in this machine's environment. For an integration embedded
 *   in a host codebase, whose scripts merge the code into it; not sandboxed, so only when asked for.
 *
 * A copy is named for its module and the run: the scripts work in `/tmp/<lang>_<basename of the
 * build>`, and every module's build is called `code`.
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
  /** Where the config has them run: in the module's VM (the default), or in place on this machine. */
  runTestingScriptsIn?: "vm" | "host";
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
export function findTestScripts(root: string, plainFile?: string, buildDir?: string): TestScripts {
  const found: TestScripts = {};
  const notes: Partial<Record<ScriptKind, string>> = {};
  // The module's own config file over the project's, when it has one - its stack's scripts: the
  // codebase's it runs in, else the spec's.
  const inModules = buildDir !== undefined && resolve(buildDir).split(sep).includes("plain_modules");
  const module =
    (inModules ? configModuleOfBuild(root, basename(dirname(resolve(buildDir!)))) : undefined) ??
    (plainFile !== undefined ? configModuleOf(root, plainFile) : undefined);
  const config = readProjectConfig(root, module);
  const file = module !== undefined ? `${moduleConfigFile(module)} (over ${CONFIG_FILE})` : CONFIG_FILE;
  // Where a module's script is named: its own file, once the project has several stacks.
  const nameIn = module !== undefined ? moduleConfigFile(module) : plainFile !== undefined ? `${CONFIG_FILE} - or, for one module of several stacks, config.${basename(plainFile, ".plain")}.yaml` : CONFIG_FILE;
  if (config.runTestingScriptsIn !== undefined) found.runTestingScriptsIn = config.runTestingScriptsIn;
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
  if (Object.keys(notes).length > 0) found.notes = notes;
  return found;
}

/**
 * The project's static checks - a type checker, a linter - when it has them: `static-checks-script:` in the config, else
 * the one `run_static_checks*.sh` at the root or in `test_scripts/`. Optional, and never a gate: the coding agent runs
 * it to check its work before the tests do. `run_static_checks_<lang>.sh <build>`, as the unit testing script is run.
 */
export function findStaticChecks(root: string, plainFile?: string, buildDir?: string): string | undefined {
  const inModules = buildDir !== undefined && resolve(buildDir).split(sep).includes("plain_modules");
  const module =
    (inModules ? configModuleOfBuild(root, basename(dirname(resolve(buildDir!)))) : undefined) ??
    (plainFile !== undefined ? configModuleOf(root, plainFile) : undefined);
  const named = readProjectConfig(root, module).staticChecksScript;
  if (named !== undefined) {
    const path = resolve(root, named.trim());
    // Agents write in plain_modules: a script there could be changed by the work it checks.
    return !path.split(sep).includes("plain_modules") && isFile(path) ? path : undefined;
  }
  for (const dir of [root, join(root, SCRIPTS_DIR)]) {
    if (!existsSync(dir)) continue;
    const candidates = readdirSync(dir).filter((name) => STATIC_CHECKS.test(name) && isFile(join(dir, name)));
    if (candidates.length === 1) return join(dir, candidates[0]!);
  }
  return undefined;
}

const STATIC_CHECKS = /^run_static_?checks[^/]*\.sh$/i;

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
        `  \`config.<module>.yaml\` beside it, for a project whose modules are on different stacks - then in the root,`,
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
  const onHost = (scripts.runTestingScriptsIn ?? readProjectConfig(root).runTestingScriptsIn) === "host";
  return [
    "<testing scripts>",
    rendered.join("\n\n"),
    "</testing scripts>",
    "",
    `The harness decides whether your work is done by running ${used.length === 1 ? "this script" : "these scripts"} itself, ` +
      (onHost
        ? "in place on the host machine, against the host codebase it merges your code into: "
        : "in your VM - the one your bash runs in - on a fresh copy of your work: ") +
      used
        .map((kind) => (kind === "unit" ? "the unit testing script as `<script> <build folder>`" : "the conformance testing script as `<script> <build folder> <whole conformance suite folder>`"))
        .join(", ") +
      ". Make the tests pass the way the script runs them.",
    `${used.length === 1 ? "It is" : "They are"} shown so you know what runs your tests - not to be run by you. ${used.length === 1 ? "It is" : "They are"} not in your ` +
      `workspace, and the path above is the project's, not one you can reach. Never copy, recreate or adapt ${used.length === 1 ? "it" : "them"} in the ` +
      `codebase, and never write a test runner of your own: call ${tools}, which run ${used.length === 1 ? "it" : "them"} exactly as the harness does - ` +
      "that run is the one that counts. Run a single test or file with bash while you work, as you like.",
    ...(onHost
      ? [
          "Your bash runs in a Linux VM; these scripts run on the host, in its environment - its toolchains, its operating " +
            "system. Something that works in your shell can still fail there, and only the host's run counts. What the code " +
            "needs to be built and run belongs in the code (its dependency manifest), never only in your VM.",
        ]
      : [
          "A toolchain or system library the script needs and the VM lacks, install with install_system_packages: the runs " +
            "that decide use the same VM. What the code needs to be built and run belongs in the code (its dependency " +
            "manifest), so a fresh copy of it builds.",
        ]),
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
  /** Where it ran: in the module's VM, or on this machine. */
  where?: "vm" | "host";
  /** What an agent that read the whole of it said failed and why - for the judge and whoever fixes it. */
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
 * own paths start - and whether its config.yaml has them run on this machine, in place
 * (`run-testing-scripts-in: host`), rather than in the module's VM on a fresh copy.
 */
function projectOfBuild(buildDir: string): { root: string; inPlace: boolean } {
  const parts = resolve(buildDir).split(sep);
  const index = parts.lastIndexOf("plain_modules");
  const root = index > 0 ? parts.slice(0, index).join(sep) : dirname(resolve(buildDir));
  // The module's own config file decides, when it has one: plain_modules/<module>/code.
  const module = configModuleOfBuild(root, basename(dirname(resolve(buildDir))));
  return { root, inPlace: readProjectConfig(root, module).runTestingScriptsIn === "host" };
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
  return { command: shown(script), exitCode: timedOut ? 124 : exitCode, output: truncateOutput(output, log), timedOut, timeoutMs, where: "host", ...(log !== undefined ? { log } : {}) };
}

/** A path, quoted for bash. */
function quote(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/**
 * A testing script run in a module's VM: the project's script copied fresh into the staging folder,
 * beside the code copied there, and `bash <copy> <args>` run from it. `vmOf`: the module folder
 * whose VM runs it - the build's for the unit tests, the tests' for the conformance suite.
 */
async function runInModuleVm(stagingRoot: string, script: string, args: string[], vmOf: string, logDir: string, limitMs?: number): Promise<ScriptRun> {
  const copy = join(stagingRoot, basename(script));
  writeFileSync(copy, readFileSync(script));
  const timeoutMs = limitMs ?? scriptTimeoutMs;
  const started = Date.now();
  reportActivity(`  ▶ ${shown(script)} in the module's VM (limit ${Math.round(timeoutMs / 1000)}s)`);
  const { exitCode, output, timedOut } = await runInVm(`bash ${[copy, ...args].map(quote).join(" ")}`, {
    cwd: stagingRoot,
    for: vmOf,
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
  const shownText = output.split(copy).join(shown(script));
  const log = keepFullOutput(logDir, basename(script), shownText);
  return { command: shown(script), exitCode: timedOut === true ? 124 : exitCode, output: truncateOutput(shownText, log), timedOut: timedOut === true, timeoutMs, where: "vm", ...(log !== undefined ? { log } : {}) };
}

/**
 * The harness's run of the unit testing script on the code as it is now - and run_unit_tests'.
 *
 * In the module's VM on a fresh copy of the code, or - `run-testing-scripts-in: host` - on this machine, in
 * place (see the top of this file). This and runConformanceScript are the only ways the testing
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
 * A script that takes the code folder - the unit testing script, the static checks - run where the testing scripts
 * run. `change`: what to do to the fresh copy before it runs - only in the VM, where there is a copy; never in place.
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
    if (change !== undefined) throw new Error("This runs only where the testing scripts run in the VM: here they run in place, on the code itself.");
    return runOnHost(project.root, script, [resolve(buildDir)], buildDir);
  }
  const staging = stagingFor(buildDir);
  rmSync(staging.root, { recursive: true, force: true });
  ensureInVmScratch(buildDir, staging.root);
  try {
    reportActivity(`  copying ${stageBuild(buildDir, staging.build)} files of the code for the ${what}`);
    change?.(staging.build);
    const started = Date.now();
    const run = await runInModuleVm(staging.root, script, [staging.build], buildDir, buildDir, limitMs);
    if (change === undefined && run.exitCode === 0) lastPassing.set(`${resolve(buildDir)}\n${script}`, Date.now() - started);
    return run;
  } finally {
    rmSync(staging.root, { recursive: true, force: true });
  }
}

/**
 * The harness's run of the conformance testing script - and run_conformance_tests': the code, and
 * the codebase's whole conformance suite - every functionality's tests, and those carried up from
 * the modules below - in one folder, run at once. Where runUnitScript runs: in the VM - the module's
 * tests VM, a copy of the code staged beside the tests - or on this machine in place.
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
      return await runInModuleVm(staging.root, scripts.conformance, [staging.build, staging.tests], testsDirs[0] ?? buildDir, buildDir);
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

/**
 * What a failed run says is not installed where it ran - the command, when its output names it - or undefined when
 * the run failed for another reason. Exit 69 is the testing scripts' own way to say a toolchain is missing; exit 127,
 * or a shell or `timeout` that could not find the command, says it as well.
 */
export function missingToolchain(run: Pick<ScriptRun, "exitCode" | "output">): { command?: string } | undefined {
  const named =
    /failed to run command [‘'`"]?([\w.+-]+)[’'`"]?: No such file or directory/.exec(run.output) ??
    /(?:^|\n)(?:[^\n:]*: )?(?:line \d+: )?([\w.+-]+): command not found/.exec(run.output);
  if (named !== null) return { command: named[1] };
  if (run.exitCode === 69 || run.exitCode === 127) return {};
  return undefined;
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

/**
 * Whether only the person can make the script run: on this machine, nothing an agent does installs anything; in the
 * VM, a command this machine has is most likely one the project means to run here - `run-testing-scripts-in: host` -
 * or one only the person knows how to set up, as an SDK. Either way the job stops and asks them.
 */
export function needsThePerson(missing: { command?: string }, where: "vm" | "host" | undefined): boolean {
  return where === "host" || (missing.command !== undefined && onThisMachine(missing.command) !== undefined);
}

/** What a failed script run means, for the agent that has to fix it. */
export function scriptFailure(run: ScriptRun, what: string): string {
  if (run.timedOut === true) return timedOutFailure(run, what);
  const missing = missingToolchain(run);
  const needs = missing?.command !== undefined ? `\`${missing.command}\`` : "the toolchain it needs";
  const cause =
    missing !== undefined && run.where === "vm" && needsThePerson(missing, run.where)
      ? `It could not run: ${needs} is not installed in the VM, where the testing scripts run - it is on the person's machine. ` +
        "That is theirs to set up, not yours: do not work around it, and do not change the code for it. End your turn, saying " +
        "the tests cannot run until it is."
      : missing !== undefined && run.where === "vm"
      ? `It could not run: ${needs} is not installed in the VM, where the testing scripts run. Install it with ` +
        "install_system_packages - the runs that decide use the same VM - and run the tests again. The code is not what is wrong."
      : missing !== undefined
      ? `It could not run: ${needs} is not installed on this machine, where the testing scripts run. That cannot be ` +
        "fixed from your sandbox - install_system_packages installs into your VM, not here. Say in your report exactly what is " +
        "missing, so the person can install it."
      : [
          ...fixMethod({
            what: what === "unit testing" ? "unit tests" : "conformance tests",
            fixes: what === "unit testing" ? "code" : "tests",
            runTool: what === "unit testing" ? "run_unit_tests" : "run_conformance_tests",
          }),
        ].join("\n");
  return [
    `The harness ran the project's ${what} script, \`${run.command}\`, and it failed (exit ${run.exitCode}).`,
    "",
    run.output.trimEnd(),
    "",
    cause,
  ].join("\n");
}
