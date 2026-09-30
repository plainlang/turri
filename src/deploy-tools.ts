import { isAbsolute, relative, resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  deployLogDir,
  deployTarget,
  describeDeployment,
  exportModule,
  installsSoftware,
  runHostCommand,
  shortPath,
  startDeployed,
  stopDeployed,
  type Deployment,
} from "./render/deploy.ts";
import { projectDirOf } from "./render/paths.ts";

/**
 * The tools that put a module out for the person to try, and start it: the conversation's, and the
 * one-off agent's of `plainwright deploy`. The harness does the parts that must hold - exporting the
 * last commit, asking before anything is installed, owning what it starts - and the agent the rest:
 * reading the code to see how it runs, what it needs, and what to tell the person.
 */

export interface DeployState {
  /** The last deploy: where setup runs and what is started runs from. */
  current?: Deployment;
  /** Commands that keep running the person agreed to start, word for word - ones that fetch as they start. */
  approvedStarts: Set<string>;
}

export function createDeployState(): DeployState {
  return { approvedStarts: new Set() };
}

/** Put a question to the person: yes, no, or undefined when there is no one to ask. `ctx` is the tool call's. */
export type Approve = (title: string, body: string, ctx: unknown) => Promise<boolean | undefined>;

/** What the agent is to do once the code is in dist - in the deploy tool's answer, and the CLI agent's prompt. */
export function deployGuide(dir: string): string {
  const where = shortPath(dir);
  return [
    `What to do now, to have the person try it - it runs on this machine, outside the sandbox, from ${where}:`,
    `1. Find out how it runs: its README, its manifests (package.json, pyproject.toml, requirements.txt, go.mod, Cargo.toml, pom.xml, build.gradle, docker-compose.yml) and entry points, in ${where}.`,
    "2. Check the toolchains it needs are on this machine (`command -v node`, `python3 --version`, `go version`, ...). One missing: say plainly what to install, and start nothing. Never install a toolchain.",
    "3. Anything that installs or downloads - dependencies into a virtual environment or node_modules, a build that fetches packages, an image pull - only through propose_setup, which asks the person first and runs them. The shell refuses such commands. Declined: install nothing, say what it needs, and stop.",
    "4. Start anything that keeps running - a backend, a frontend's dev server - with start_deployed, with the URL it serves at: never in the shell with & or nohup. An app with a backend and a frontend: start both, the backend first. A command that fetches as it starts (`go run`, `cargo run`, `docker compose up`) is put to the person in propose_setup's long_running first.",
    "5. Then tell the person, briefly. Something that serves: only where to open it - the frontend's URL, and the API's in one line when there is one. A CLI or a library: a few commands to paste, run from the folder, with what they print. A port that is taken: say which and by what, and do not move the app to another.",
    `Do not change the code in ${where} - it is a copy of what was built, and a fix belongs in the spec. A config file it needs made from its example (a .env from .env.example) is fine.`,
  ].join("\n");
}

function text(value: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: value }], details };
}

function clip(output: string, max = 3000): string {
  return output.length > max ? `…${output.slice(-max)}` : output;
}

/** The folder a command runs in: the deployment's, or one inside it. */
function inside(current: Deployment, dir: string | undefined): string {
  const target = resolve(current.dir, dir ?? ".");
  const rel = relative(current.dir, target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${dir} is outside ${shortPath(current.dir)}: what deploy starts runs from there.`);
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
    if (state.current === undefined) throw new Error("Nothing is deployed yet: call deploy first.");
    return state.current;
  };

  const deploy = defineTool({
    name: "deploy",
    label: "Deploy",
    description:
      "Put a module's code out for the person to try, in dist/<module>: its last commit - what the last render, spec diff " +
      "or conformance run that finished left, never what a job is writing now - replacing what was there, and stopping " +
      "whatever an earlier deploy of it started. Always the module on top of the spec's requires chain: it holds the " +
      "code of the ones below. Call it when the person wants to try, run, see or use what was built. It says what to do next.",
    promptSnippet: "deploy: put the built code in dist/<module> for the person to try, then start it",
    parameters: Type.Object({
      plain_file: Type.Optional(Type.String({ description: "A .plain file of the module. Default: the project's module from config.yaml." })),
      in_module: Type.Optional(Type.String({ description: "The codebase to take, when modules built on this one branch" })),
    }),
    async execute(_id, params) {
      const named = params.plain_file ?? options.defaultPlainFile();
      if (named === undefined) throw new Error("Which spec? config.yaml names no module: pass plain_file.");
      const plainFile = resolve(options.cwd, named);
      const target = deployTarget(plainFile, params.in_module);
      // What the last deploy started runs from the folder about to be replaced.
      const stopped = await stopDeployed({ moduleName: target.entry.moduleName });
      const deployment = exportModule(plainFile, params.in_module);
      state.current = deployment;
      state.approvedStarts.clear();
      return text(
        [
          describeDeployment(deployment),
          ...(stopped.length > 0 ? [`Stopped what the last deploy started: ${stopped.join(", ")}.`] : []),
          "",
          deployGuide(deployment.dir),
        ].join("\n"),
        { module: deployment.moduleName, dir: deployment.dir, commit: deployment.commit },
      );
    },
  });

  const proposeSetup = defineTool({
    name: "propose_setup",
    label: "Propose setup",
    description:
      "Ask the person to allow what installs or downloads software on this machine - dependencies, a build that fetches " +
      "packages, an image pull - and, when they say yes, run it in the deployed folder, in order, stopping at the first " +
      "that fails. List every command it takes, as it will run; nothing is installed unless they agree. `long_running` " +
      "are commands to start later with start_deployed that fetch as they start (`go run .`, `docker compose up`).",
    promptSnippet: "propose_setup: ask the person before installing anything, then run the setup they agreed to",
    parameters: Type.Object({
      commands: Type.Array(Type.String(), { description: "Commands to run now, one line each, as they will run from the deployed folder" }),
      long_running: Type.Optional(Type.Array(Type.String(), { description: "Commands start_deployed will start later that fetch as they start" })),
      why: Type.String({ description: "What they install and where, in a sentence: 'Python packages from requirements.txt, into .venv here'" }),
      dir: Type.Optional(Type.String({ description: "A folder inside the deployed one to run them in, e.g. frontend. Default: the deployed folder." })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const current = needsDeploy();
      const dir = inside(current, params.dir);
      const starts = params.long_running ?? [];
      const body = [
        `plainwright would run these on this machine, in ${shortPath(dir)}:`,
        ...params.commands.map((command) => `  $ ${command}`),
        ...(starts.length > 0 ? ["", "and later start:", ...starts.map((command) => `  $ ${command}`)] : []),
        "",
        params.why,
        "",
        "Nothing is installed unless you say yes.",
      ].join("\n");
      const answer = await options.approve("Install on this machine?", body, ctx);
      if (answer === undefined) {
        return text(`There is no one to ask here, so nothing was installed. Tell the person what it needs, as commands they can run themselves in ${shortPath(dir)}, and start nothing that needs them.`, { approved: false });
      }
      if (!answer) {
        return text(`The person said no: nothing was installed. Tell them what it needs - the commands, to run themselves in ${shortPath(dir)} - and stop.`, { approved: false });
      }
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
      return text([`The person agreed, and ${params.commands.length === 1 ? "it" : `all ${params.commands.length}`} ran:`, "", ...results].join("\n"), { approved: true });
    },
  });

  const startTool = defineTool({
    name: "start_deployed",
    label: "Start deployed",
    description:
      "Start something that keeps running - a backend, a frontend's dev server - from the deployed folder, on this " +
      "machine: in the background, its output kept, stopped on the next deploy, on /stop and when plainwright exits. " +
      "With `url`, waits until something answers there and says so, or shows the end of its output. A port something " +
      "else holds is said, and nothing is started.",
    promptSnippet: "start_deployed: start a server of the deployed code, and wait for it to answer",
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
    name: "stop_deployed",
    label: "Stop deployed",
    description: "Stop what start_deployed started: the one named, or every one.",
    promptSnippet: "stop_deployed: stop a deployed server, or all of them",
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

export const DEPLOY_TOOLS = ["deploy", "propose_setup", "start_deployed", "stop_deployed"];

/** Why a shell command is refused while something is deployed - or nothing when it may run. */
export function refuseInstall(command: string): string | undefined {
  const installing = installsSoftware(command);
  if (installing === undefined) return undefined;
  return (
    `Not run: \`${installing}\` installs or fetches software on this machine, which only the person can allow. ` +
    "Put it in propose_setup - it asks them, and runs it when they agree - or, if they said no, tell them what it needs."
  );
}
