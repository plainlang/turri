import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { load as loadYaml } from "js-yaml";
import { ensureInVmScratch, vmScratchDir } from "./paths.ts";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { listFiles, shownOutput, type TestRun } from "./testing.ts";
import { runInVm } from "./vm.ts";

/**
 * The project's testing scripts, and the harness's runs of them.
 *
 * An agent runs whatever it likes while it works. Whether the work is done is decided by the
 * project's own scripts - the ones the `implement-unit-testing-script` and
 * `implement-conformance-testing-script` skills write into `test_scripts/` and link from the spec -
 * run by the harness, never by the agent. The same script, the same way, every time: done is a
 * decision the project made, not one an agent makes about its own work.
 *
 * The scripts live beside the specs, outside `plain_modules`, so no agent can reach them. Each
 * run copies the script into the VM's scratch area fresh from the project, stages the code under
 * a name of its own - the scripts work in `/tmp/<lang>_<basename of the build>`, and every
 * module's build is called `code` - and runs it there.
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

/** The project's config file, and the key that names each script in it. */
export const CONFIG_FILE = "config.yaml";
const CONFIG_KEYS: Record<ScriptKind, string> = {
  unit: "unittests-script",
  conformance: "conformance-tests-script",
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

function readConfig(root: string): Record<string, unknown> {
  const path = join(root, CONFIG_FILE);
  if (!isFile(path)) return {};
  try {
    const parsed = loadYaml(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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
  const config = readConfig(root);
  for (const kind of Object.keys(CONFIG_KEYS) as ScriptKind[]) {
    const named = config[CONFIG_KEYS[kind]];
    if (typeof named === "string" && named.trim() !== "") {
      const path = resolve(root, named.trim());
      // Agents write in plain_modules: a script there could be changed by the work it judges.
      if (path.split(sep).includes("plain_modules")) {
        notes[kind] = `${CONFIG_FILE} names ${named.trim()} as the ${CONFIG_KEYS[kind]}, inside plain_modules - where agents write, so it is not used.`;
      } else if (isFile(path)) {
        found[kind] = path;
        continue;
      } else {
        notes[kind] = `${CONFIG_FILE} names ${named.trim()} as the ${CONFIG_KEYS[kind]}, and there is no such file.`;
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
  constructor(
    readonly moduleName: string,
    readonly kind: ScriptKind,
    note?: string,
  ) {
    const { skill, file, what } = SKILL[kind];
    super(
      [
        `Stopped before building ${moduleName}: it has no ${what}, so nothing can decide when its ${kind === "unit" ? "code" : "conformance tests"} pass.`,
        ...(note !== undefined ? ["", note] : []),
        "",
        "What to change in the project:",
        `- Add one with the \`${skill}\` skill: it writes \`${SCRIPTS_DIR}/${file}_<language>.sh\`.`,
        `- It is looked for in \`${CONFIG_FILE}\` at the project root (\`${CONFIG_KEYS[kind]}: <path>\`), then in the root,`,
        `  then in \`${SCRIPTS_DIR}/\` - one ${file}*.sh in either folder is used.`,
        "",
        "Then build again.",
      ].join("\n"),
    );
    this.name = "MissingTestScriptError";
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
  const rendered = used.map((kind) => {
    const path = scripts[kind]!;
    const name = path.startsWith(`${root}${sep}`) ? path.slice(root.length + 1) : basename(path);
    return `<script kind="${kind === "unit" ? "unit tests" : "conformance tests"}" path="${name}">\n${readFileSync(path, "utf8").trimEnd()}\n</script>`;
  });
  return [
    "<testing scripts>",
    rendered.join("\n\n"),
    "</testing scripts>",
    "",
    `The harness decides whether your work is done by running ${used.length === 1 ? "this script" : "these scripts"} itself, in ` +
      "the same VM your commands run in: " +
      used
        .map((kind) => (kind === "unit" ? "the unit testing script as `<script> <build folder>`" : "the conformance testing script as `<script> <build folder> <whole conformance suite folder>`"))
        .join(", ") +
      ". Make the tests pass the way the script runs them.",
    "",
    prompt,
  ].join("\n");
}

/** A path, quoted for bash. */
function quote(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

export interface ScriptRun {
  /** How the run is shown: the script's name, as the project calls it. */
  command: string;
  exitCode: number;
  output: string;
}

/** Where one build's script runs are staged, by build and tests - inside what the VM holds. */
function stagingFor(buildDir: string, testsDirs: string[]): { root: string; build: string; tests: string } {
  const key = createHash("sha1").update(JSON.stringify([resolve(buildDir), ...testsDirs.map((dir) => resolve(dir))])).digest("hex").slice(0, 12);
  const root = join(vmScratchDir(buildDir), "scripts", key);
  // The scripts work in /tmp/<lang>_<basename of the build>: named for the module and this
  // staging, so no two modules' runs share that folder.
  return { root, build: join(root, `${basename(dirname(resolve(buildDir)))}-${key}`), tests: join(root, "tests") };
}

function stageBuild(buildDir: string, target: string): void {
  // There even when the build is empty: the scripts cd into it.
  mkdirSync(target, { recursive: true });
  for (const file of listFiles(buildDir)) {
    mkdirSync(dirname(join(target, file)), { recursive: true });
    copyFileSync(join(buildDir, file), join(target, file));
  }
}

/** Every functionality's tests in one folder. A name already taken is renamed, never overwritten. */
function stageTests(testsDirs: string[], target: string): void {
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
}

function stageScript(script: string, root: string): string {
  const copy = join(root, basename(script));
  writeFileSync(copy, readFileSync(script));
  return copy;
}

/** What the project calls a script: its path from the spec's folder when it is under it. */
function shown(script: string): string {
  const parent = dirname(dirname(script));
  return script.startsWith(`${parent}/`) ? script.slice(parent.length + 1) : basename(script);
}

async function runStaged(root: string, script: string, args: string[]): Promise<ScriptRun> {
  const copy = stageScript(script, root);
  const { exitCode, output } = await runInVm(`bash ${[copy, ...args].map(quote).join(" ")}`, { cwd: root });
  return { command: shown(script), exitCode, output: shownOutput(root, basename(script), output) };
}

/** The harness's run of the unit testing script on the code as it is now. */
export async function runUnitScript(buildDir: string, script: string): Promise<ScriptRun> {
  const staging = stagingFor(buildDir, []);
  rmSync(staging.root, { recursive: true, force: true });
  ensureInVmScratch(buildDir, staging.root);
  try {
    stageBuild(buildDir, staging.build);
    return await runStaged(staging.root, script, [staging.build]);
  } finally {
    rmSync(staging.root, { recursive: true, force: true });
  }
}

/**
 * The harness's run of the conformance testing script: the code, and the codebase's whole
 * conformance suite - every functionality's tests, and those carried up from the modules below
 * - in one folder, run at once.
 */
export async function runConformanceScript(buildDir: string, testsDirs: string[], scripts: TestScripts): Promise<ScriptRun> {
  if (scripts.conformance === undefined) throw new Error("No conformance testing script to run.");
  const staging = stagingFor(buildDir, testsDirs);
  rmSync(staging.root, { recursive: true, force: true });
  ensureInVmScratch(buildDir, staging.root);
  try {
    stageBuild(buildDir, staging.build);
    stageTests(testsDirs, staging.tests);
    return await runStaged(staging.root, scripts.conformance, [staging.build, staging.tests]);
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
    description:
      `Final check before you finish: run the project's ${unit ? "unit" : "conformance"} testing script, ${script}, on ` +
      (unit ? "the code as it is now" : "the code with the whole conformance suite") +
      " - exactly as the harness runs it to decide whether this is done. It takes no command. To run one test, one " +
      "file, or the tests any other way while you work, use bash.",
    promptSnippet: `${name}: the final check - the project's ${unit ? "unit" : "conformance"} testing script, as the harness runs it`,
    parameters: Type.Object({}),
    async execute() {
      const run = await options.run();
      options.runs.push({ command: run.command, exitCode: run.exitCode });
      options.onRun?.(run.command, run.exitCode);
      return {
        content: [{ type: "text" as const, text: `${run.command} exited ${run.exitCode}\n\n${run.output}` }],
        details: { command: run.command, exitCode: run.exitCode },
      };
    },
  });
}

/** What a failed script run means, for the agent that has to fix it. */
export function scriptFailure(run: ScriptRun, what: string): string {
  const cause =
    run.exitCode === 69
      ? "It exited 69: the toolchain it needs is not installed in the VM. Install it with install_system_packages, then run the tests again."
      : run.exitCode === 124
        ? "It ran out of time: something in the tests never finishes - a server left in the foreground, a prompt waiting for input."
        : `Fix the cause and run the tests again. Do not remove or weaken a test to get a pass.`;
  return [
    `The harness ran the project's ${what} script, \`${run.command}\`, and it failed (exit ${run.exitCode}). That run is what`,
    "decides whether this is done - the script is among the linked resources, so you can see what it does.",
    "",
    run.output.trimEnd(),
    "",
    cause,
  ].join("\n");
}
