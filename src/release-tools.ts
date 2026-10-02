import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  deployLogDir,
  deployTarget,
  describeDeployment,
  exportModule,
  hostDirOf,
  installsSoftware,
  runHostCommand,
  shortPath,
  startDeployed,
  stopDeployed,
  type Deployment,
} from "./grow/release.ts";
import { projectDirOf } from "./grow/paths.ts";

/**
 * The tools that put a module out for the person to try, and start it: the conversation's, and the
 * one-off agent's of `turri release`. The harness does the parts that must hold - exporting the
 * last commit, asking before anything is installed, owning what it starts - and the agent the rest:
 * reading the code to see how it runs, what it needs, and what to tell the person.
 */

export interface DeployState {
  /** The last deploy: where setup runs and what is started runs from. */
  current?: Deployment;
  /** Commands that keep running the person agreed to start, word for word - ones that fetch as they start. */
  approvedStarts: Set<string>;
  /** Commands the person allowed for the rest of the session, with the folder each runs in. */
  allowedThisSession: Set<string>;
}

export function createDeployState(): DeployState {
  return { approvedStarts: new Set(), allowedThisSession: new Set() };
}

/**
 * How the person answered: allowed once, for the rest of the session, always - in this project, remembered - or not.
 * Undefined when there is no one to ask. A bare yes or no is once or not.
 */
export type Approval = "once" | "session" | "always" | "no";

/** Put a question to the person. `ctx` is the tool call's. */
export type Approve = (title: string, body: string, ctx: unknown) => Promise<Approval | boolean | undefined>;

/** The answers, as the person is offered them. */
export const APPROVALS: Array<{ answer: Approval; label: string }> = [
  { answer: "once", label: "Allow once" },
  { answer: "session", label: "Allow for this session" },
  { answer: "always", label: "Allow always" },
  { answer: "no", label: "Don't allow" },
];

/** What allowing remembers: a command, word for word, and the folder it runs in. */
function allowedKey(dir: string, command: string): string {
  return `${dir}\n${command.trim()}`;
}

/** Where a project keeps the commands its person allowed always - delete it to take them back. */
function allowedFile(plainFile: string): string {
  return join(projectDirOf(plainFile), ".turri", "allowed-commands.json");
}

function allowedAlways(plainFile: string): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(allowedFile(plainFile), "utf8")) as { allowed?: Array<{ dir: string; command: string }> };
    return new Set((parsed.allowed ?? []).map((entry) => allowedKey(entry.dir, entry.command)));
  } catch {
    return new Set();
  }
}

function allowAlways(plainFile: string, dir: string, commands: string[]): void {
  const file = allowedFile(plainFile);
  let allowed: Array<{ dir: string; command: string }> = [];
  try {
    allowed = (JSON.parse(readFileSync(file, "utf8")) as { allowed?: typeof allowed }).allowed ?? [];
  } catch {
    /* none yet */
  }
  const have = new Set(allowed.map((entry) => allowedKey(entry.dir, entry.command)));
  for (const command of commands) if (!have.has(allowedKey(dir, command))) allowed.push({ dir, command: command.trim() });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ allowed }, null, 2)}\n`);
}

/** What the agent is to do once the code is in dist - in the deploy tool's answer, and the CLI agent's prompt. */
export function deployGuide(dir: string): string {
  const where = shortPath(dir);
  return [
    `What to do now, to have the person try it - it runs on this machine, outside the sandbox, from ${where}:`,
    `1. Find out how it runs: its README, its manifests (package.json, pyproject.toml, requirements.txt, go.mod, Cargo.toml, pom.xml, build.gradle, docker-compose.yml) and entry points, in ${where}.`,
    "2. Check the toolchains it needs are on this machine (`command -v node`, `python3 --version`, `go version`, ...). One missing: say plainly what to install, and start nothing. Never install a toolchain.",
    "3. Anything that installs or downloads - dependencies into a virtual environment or node_modules, a build that fetches packages, an image pull - only through propose_setup, which asks the person first and runs them. The shell refuses such commands. Declined: install nothing, say what it needs, and stop.",
    "4. Start anything that keeps running - a backend, a frontend's dev server - with activate, with the URL it serves at: never in the shell with & or nohup. An app with a backend and a frontend: start both, the backend first. A command that fetches as it starts (`go run`, `cargo run`, `docker compose up`) is put to the person in propose_setup's long_running first.",
    "5. Then tell the person, briefly. Something that serves: only where to open it - the frontend's URL, and the API's in one line when there is one. A CLI or a library: a few commands to paste, run from the folder, with what they print. A port that is taken: say which and by what, and do not move the app to another.",
    `Do not change the code in ${where} - it is a copy of what was built, and a fix belongs in the spec. A config file it needs made from its example (a .env from .env.example) is fine.`,
  ].join("\n");
}

/**
 * What the agent is to do on a guided release: the code is in dist, as on any release, and the guidance takes it on from
 * there. The rules of a release to dist hold here too: nothing run or installed that the person did not agree to, what
 * keeps running started with activate, and the built code never edited.
 */
export function guidedGuide(deployment: Deployment, guidance: string): string {
  const host = shortPath(deployment.hostDir ?? deployment.dir);
  const dist = shortPath(deployment.dir);
  const built = shortPath(deployment.buildDir);
  return [
    "The guidance for releasing it - follow it:",
    guidance.trim(),
    "",
    `What to do now - on this machine, outside the sandbox, from ${host}:`,
    `1. The code to release is in ${dist}: the last commit that landed whole. Take it from there, never from ${built}, where a pulse may be writing. Where the guidance's own tooling reads ${built}, point it at ${dist} if it can take another source; if it cannot, do by hand, from ${dist}, what it does.`,
    `2. Read what the guidance leaves open - the scripts, files and commands it names, in ${host} - then do what it says, in its order. Where it says to change the host - a registration, an import, a config entry - change it. Never change ${built} or ${dist}: a fix to the code belongs in the spec.`,
    "3. A command that runs a project script, installs or downloads: only through propose_setup, which asks the person first and runs it - the shell refuses such commands. One that keeps running (a start script, a dev server) goes in propose_setup's long_running, and activate starts it.",
    "4. Start what keeps running with activate, with the URL it serves at - never in the shell with & or nohup.",
    `5. Then tell the person briefly: what was done, what you changed in ${host} if anything, and where to open it or how to try it. Where the guidance does not fit what you find, say so, and do not guess past it.`,
  ].join("\n");
}

function text(value: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: value }], details };
}

function clip(output: string, max = 3000): string {
  return output.length > max ? `…${output.slice(-max)}` : output;
}

/** The folder a command runs in: dist's, or - guided - the host codebase's, or one inside either. */
function inside(current: Deployment, dir: string | undefined): string {
  const base = current.hostDir ?? current.dir;
  const target = resolve(base, dir ?? ".");
  const within = (root: string) => {
    const rel = relative(root, target);
    return !rel.startsWith("..") && !isAbsolute(rel);
  };
  if (!within(base) && !within(current.dir)) throw new Error(`${dir} is outside ${shortPath(base)}: what release starts runs from there.`);
  return target;
}

export function createDeployTools(options: {
  cwd: string;
  state: DeployState;
  approve: Approve;
  /** The spec deploy takes when it is given none: the project's module. */
  defaultPlainFile: () => string | undefined;
}) {
  const { state } = options;
  const needsDeploy = () => {
    if (state.current === undefined) throw new Error("Nothing is released yet: call release first.");
    return state.current;
  };

  const deploy = defineTool({
    name: "release",
    label: "Release",
    description:
      "Release a module's code for the person to try - the module on top of the spec's requires chain, which holds the " +
      "code of the ones below - stopping whatever an earlier release of it started. Before you call it, ask yourself: is " +
      "there guidance for releasing this project - in what the person said, the project's AGENTS.md, a skill, or anything " +
      "else you were given? An integration a host application loads, say, released with the host's own scripts. If there " +
      "is, pass it as guidance, in full. Either way its last commit - what last landed whole - is exported to dist/<module> " +
      "first; with guidance it is taken on from there as the guidance says, in the host codebase; without, it is started " +
      "from there, as best it can be. Call it when the " +
      "person wants to try, run, see or use what was built. It says what to do next.",
    promptSnippet: "release the grown code for the person to try - as the project's release guidance says, or to dist/<module> - then activate it",
    parameters: Type.Object({
      plain_file: Type.Optional(Type.String({ description: "A .plain file of the module. Default: the project's module from config.yaml." })),
      in_module: Type.Optional(Type.String({ description: "The codebase to take, when modules built on this one branch" })),
      guidance: Type.Optional(
        Type.String({ description: "The guidance for releasing this project, whole, from wherever it is - the person, AGENTS.md, a skill: the scripts to run and in which order, where the code goes. Omit when there is none." }),
      ),
    }),
    async execute(_id, params) {
      const named = params.plain_file ?? options.defaultPlainFile();
      if (named === undefined) throw new Error("Which spec? config.yaml names no module: pass plain_file.");
      const plainFile = resolve(options.cwd, named);
      const target = deployTarget(plainFile, params.in_module);
      const guidance = params.guidance?.trim() || undefined;
      // What the last release started runs from what is about to be replaced.
      const stopped = await stopDeployed({ moduleName: target.entry.moduleName });
      // Always the last commit, clean, in dist first; guidance takes it on from there.
      const exported = exportModule(plainFile, params.in_module);
      const deployment: Deployment = guidance === undefined ? exported : { ...exported, way: "guided", hostDir: hostDirOf(plainFile, options.cwd) };
      state.current = deployment;
      state.approvedStarts.clear();
      return text(
        [
          describeDeployment(deployment),
          ...(stopped.length > 0 ? [`Stopped what the last release started: ${stopped.join(", ")}.`] : []),
          "",
          guidance === undefined ? deployGuide(deployment.dir) : guidedGuide(deployment, guidance),
        ].join("\n"),
        { module: deployment.moduleName, way: deployment.way, dir: deployment.dir, ...(deployment.hostDir !== undefined ? { host: deployment.hostDir } : {}), commit: deployment.commit },
      );
    },
  });

  const proposeSetup = defineTool({
    name: "propose_setup",
    label: "Propose setup",
    description:
      "Ask the person to allow commands on this machine that the shell will not run on its own - what installs or " +
      "downloads software (dependencies, a build that fetches packages, an image pull), and a project's own scripts - " +
      "and, when they say yes, run them in the release's folder, in order, stopping at the first that fails. List every " +
      "command it takes, as it will run; nothing runs unless they agree. `long_running` are commands to start later with " +
      "activate (`scripts/start.sh`, `go run .`, `docker compose up`).",
    promptSnippet: "ask the person before running scripts or installing anything, then run what they agreed to",
    parameters: Type.Object({
      commands: Type.Array(Type.String(), { description: "Commands to run now, one line each, as they will run from the deployed folder" }),
      long_running: Type.Optional(Type.Array(Type.String(), { description: "Commands activate will start later that fetch as they start" })),
      why: Type.String({ description: "What they do, in a sentence: 'Python packages from requirements.txt, into .venv here', or 'copy the integration into the host, then start it'" }),
      dir: Type.Optional(Type.String({ description: "A folder inside the deployed one to run them in, e.g. frontend. Default: the deployed folder." })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const current = needsDeploy();
      const dir = inside(current, params.dir);
      const starts = params.long_running ?? [];
      const body = [
        `On this machine, in ${shortPath(dir)}:`,
        ...params.commands.map((command) => `  $ ${command}`),
        ...(starts.length > 0 ? ["", "and later start:", ...starts.map((command) => `  $ ${command}`)] : []),
        "",
        params.why,
      ].join("\n");
      // Allowed before - this session, or always in this project - every one of them, word for word, here: run, unasked.
      const all = [...params.commands, ...starts];
      const always = allowedAlways(current.plainFile);
      const known = all.every((command) => state.allowedThisSession.has(allowedKey(dir, command)) || always.has(allowedKey(dir, command)));
      const asked = known ? "once" : await options.approve("turri wants to run this", body, ctx);
      const answer: Approval | undefined = asked === true ? "once" : asked === false ? "no" : asked;
      if (answer === undefined) {
        return text(`There is no one to ask here, so nothing was run. Tell the person what it needs, as commands they can run themselves in ${shortPath(dir)}, and start nothing that needs them.`, { approved: false });
      }
      if (answer === "no") {
        return text(`The person said no: nothing was run. Tell them what it needs - the commands, to run themselves in ${shortPath(dir)} - and stop.`, { approved: false });
      }
      if (answer === "session" || answer === "always") for (const command of all) state.allowedThisSession.add(allowedKey(dir, command));
      if (answer === "always") allowAlways(current.plainFile, dir, all);
      for (const command of starts) state.approvedStarts.add(command);
      const results: string[] = [];
      for (const command of params.commands) {
        onUpdate?.({ content: [{ type: "text", text: `▶ ${command}` }], details: {} });
        const run = await runHostCommand(dir, command, { signal });
        results.push(`$ ${command}\n(exit ${run.exitCode})\n${clip(run.output.trim())}`);
        if (run.exitCode !== 0) {
          return text([`The person agreed, but this failed - the ones after it were not run:`, "", ...results].join("\n"), { approved: true, failed: command });
        }
      }
      const agreed = known ? "The person allowed these before, so they ran without asking" : "The person agreed";
      return text([`${agreed}, and ${params.commands.length === 1 ? "it" : `all ${params.commands.length}`} ran:`, "", ...results].join("\n"), { approved: true, ...(known ? { allowedBefore: true } : {}) });
    },
  });

  const startTool = defineTool({
    name: "activate",
    label: "Activate",
    description:
      "Start something that keeps running - a backend, a frontend's dev server - from the deployed folder, on this " +
      "machine: in the background, its output kept, stopped on the next release, on /halt and when turri exits. " +
      "With `url`, waits until something answers there and says so, or shows the end of its output. A port something " +
      "else holds is said, and nothing is started.",
    promptSnippet: "start a server of the deployed code, and wait for it to answer",
    parameters: Type.Object({
      name: Type.String({ description: "A short name for it: backend, frontend, app" }),
      command: Type.String({ description: "The command that starts it, as run from its folder" }),
      url: Type.Optional(Type.String({ description: "Where it serves, e.g. http://localhost:5173 - it is ready once this answers" })),
      dir: Type.Optional(Type.String({ description: "A folder inside the deployed one to run it in, e.g. frontend. Default: the deployed folder." })),
    }),
    async execute(_id, params) {
      const current = needsDeploy();
      const installing = installsSoftware(params.command);
      if (installing !== undefined && !state.approvedStarts.has(params.command)) {
        throw new Error(
          `Not started: \`${installing}\` installs or fetches software on this machine, which only the person can allow. ` +
            "Put the command in propose_setup's long_running first - word for word - or start it another way that fetches nothing.",
        );
      }
      const started = await startDeployed({
        name: params.name,
        command: params.command,
        dir: inside(current, params.dir),
        moduleName: current.moduleName,
        logDir: deployLogDir(projectDirOf(current.plainFile)),
        ...(params.url !== undefined ? { url: params.url } : {}),
      });
      return text(started.text, { ok: started.ok, ...(started.process !== undefined ? { pid: started.process.pid, log: started.process.log } : {}) });
    },
  });

  const stopTool = defineTool({
    name: "halt",
    label: "Halt",
    description: "Stop what activate started: the one named, or every one.",
    promptSnippet: "stop a deployed server, or all of them",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "The name it was started under. Omit to stop everything deploy started." })),
    }),
    async execute(_id, params) {
      const stopped = await stopDeployed(params.name !== undefined ? { name: params.name } : {});
      return text(stopped.length === 0 ? (params.name !== undefined ? `Nothing named ${params.name} is running.` : "Nothing deploy started is running.") : `Stopped ${stopped.join(", ")}.`, { stopped });
    },
  });

  return [deploy, proposeSetup, startTool, stopTool];
}

export const DEPLOY_TOOLS = ["release", "propose_setup", "activate", "halt"];

/** Why a shell command is refused while something is deployed - or nothing when it may run. */
export function refuseInstall(command: string): string | undefined {
  const installing = installsSoftware(command);
  if (installing === undefined) return undefined;
  return (
    `Not run: \`${installing}\` installs or fetches software on this machine, which only the person can allow. ` +
    "Put it in propose_setup - it asks them, and runs it when they agree - or, if they said no, tell them what it needs."
  );
}
