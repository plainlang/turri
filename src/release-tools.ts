import { isAbsolute, relative, resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  deployLogDir,
  deployTarget,
  describeDeployment,
  exportModule,
  hostDirOf,
  shortPath,
  startDeployed,
  stopDeployed,
  type Deployment,
} from "./grow/release.ts";
import { projectDirOf } from "./grow/paths.ts";
import type { JobRegistry } from "./grow/jobs.ts";
import { haltTool } from "./loop-tools.ts";

/**
 * The tools that put a module out for the person to try, and start it: the conversation's, and the
 * one-off agent's of `turri release`. The harness does the parts that must hold - exporting the
 * last commit, owning what it starts - and the agent the rest: reading the code to see how it runs,
 * installing what it needs, starting it, and telling the person where to find it. Nothing is put to
 * the person: a release does everything itself.
 */

export interface DeployState {
  /** The last deploy: where what is started runs from. */
  current?: Deployment;
}

export function createDeployState(): DeployState {
  return {};
}

/** What the agent is to do once the code is in dist - in the deploy tool's answer, and the CLI agent's prompt. */
export function deployGuide(dir: string): string {
  const where = shortPath(dir);
  return [
    `What to do now, to have the person try it - it runs on this machine, outside the sandbox, from ${where}:`,
    `1. Find out how it runs: its README, its manifests (package.json, pyproject.toml, requirements.txt, go.mod, Cargo.toml, pom.xml, build.gradle, docker-compose.yml) and entry points, in ${where}.`,
    "2. Check the toolchains it needs are on this machine (`command -v node`, `python3 --version`, `go version`, ...). One missing: install it with this machine's package manager (brew on macOS, apt or dnf on Linux), then go on.",
    "3. Install what it needs yourself, in your shell - dependencies into a virtual environment or node_modules, a build that fetches packages, an image pull. Do not ask the person: do it, and fix what fails.",
    "4. Start anything that keeps running - a backend, a frontend's dev server - with activate, with the URL it serves at: never in the shell with & or nohup. An app with a backend and a frontend: start both, the backend first.",
    "5. Then tell the person, briefly. Something that serves: only where to open it - the frontend's URL, and the API's in one line when there is one. A CLI or a library: a few commands to paste, run from the folder, with what they print. A port that is taken: say which and by what, and do not move the app to another.",
    `Do not change the code in ${where} - it is a copy of what was built, and a fix belongs in the spec. A config file it needs made from its example (a .env from .env.example) is fine.`,
  ].join("\n");
}

/**
 * What the agent is to do on a guided release: the code is in dist, as on any release, and the guidance takes it on from
 * there. The rules of a release to dist hold here too: what keeps running started with activate, and the built code never
 * edited - and nothing put to the person.
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
    "3. Run the project's scripts and install what it needs yourself, in your shell. Do not ask the person: do it, and fix what fails.",
    "4. Start what keeps running - a start script, a dev server - with activate, with the URL it serves at - never in the shell with & or nohup.",
    `5. Then tell the person briefly: what was done, what you changed in ${host} if anything, and where to open it or how to try it. Where the guidance does not fit what you find, say so, and do not guess past it.`,
  ].join("\n");
}

function text(value: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: value }], details };
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
  /** The spec deploy takes when it is given none: the project's module. */
  defaultPlainFile: () => string | undefined;
  /** The pulses halt stops as well - the conversation's. */
  jobs?: JobRegistry;
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

  // The one halt: with the pulses in the conversation, and without them for the release agent.
  const stopTool = haltTool(options.jobs !== undefined ? { jobs: options.jobs } : {});

  return [deploy, startTool, stopTool];
}

export const DEPLOY_TOOLS = ["release", "activate", "halt"];
