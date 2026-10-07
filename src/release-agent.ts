import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createDeployTools, DEPLOY_TOOLS, type DeployState } from "./release-tools.ts";
import { hostDirOf, shortPath } from "./grow/release.ts";
import { projectDirOf } from "./grow/paths.ts";
import { ask, BEGIN, createExecutor } from "./pi.ts";

/**
 * The agent that releases a module on its own - `turri release`'s, and a pulse's last stage under
 * `release-after-pulse: true`. It finds the project's release guidance as the chat does - what it was told, the
 * project's AGENTS.md, its skills - passes it to `release`, and does what it says, asking no one.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = ToolDefinition<any, any, any>;

/** The person's own shell, in the deployed folder: it installs and runs what the release needs. */
function hostBash(dir: string): AnyTool {
  const bash: AnyTool = createBashToolDefinition(dir);
  return {
    ...bash,
    description: `${bash.description}\n\nIt runs on the person's own machine, in ${shortPath(dir)}. Never start a server here: activate does.`,
  };
}

/** A file tool that writes, refused inside plain_modules: the built code is the spec's to change, never a release's. */
function outsideBuiltCode(tool: AnyTool, dir: string): AnyTool {
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const path = resolve(dir, String((params as { path?: unknown }).path ?? ""));
      if (relative(dir, path).split(sep).includes("plain_modules")) {
        throw new Error(`Not written: ${shortPath(path)} is built code. A release never changes it - a fix belongs in the spec.`);
      }
      return tool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

function shown(file: string, max = 40_000): string {
  const text = readFileSync(file, "utf8");
  const body = text.length > max ? `${text.slice(0, max)}\n… [the rest of ${shortPath(file)} is not shown]` : text;
  return `<file path="${shortPath(file)}">\n${body.trimEnd()}\n</file>`;
}

/**
 * What the project says of itself, for the agent to find release guidance in: its AGENTS.md and its skills
 * (`.agents/skills`, `.pi/skills`, `.claude/skills`), where turri runs and in the host codebase - once each, whole.
 */
export function projectNotes(dirs: string[]): string[] {
  const roots = [...new Set(dirs.map((dir) => resolve(dir)))];
  const files = new Set<string>();
  for (const root of roots) {
    const agents = join(root, "AGENTS.md");
    if (existsSync(agents)) files.add(agents);
    for (const skills of [".agents/skills", ".pi/skills", ".claude/skills"].map((folder) => join(root, folder))) {
      if (!existsSync(skills)) continue;
      for (const name of readdirSync(skills)) {
        const skill = join(skills, name, "SKILL.md");
        if (existsSync(skill)) files.add(skill);
      }
    }
  }
  return [...files].map((file) => shown(file));
}

export interface ReleaseAgentInput {
  plainFile: string;
  /** Where turri runs. */
  cwd: string;
  /** The agent's model: the harness model. */
  model?: string;
  /** What release has shipped and been told this conversation - shared with the chat's release. */
  state: DeployState;
  inModule?: string;
  /** What the person said of how to release it. */
  guidance?: string;
  /** Released as a pulse's last stage: what the pulse landed. The agent releases only when the guidance says to. */
  afterPulse?: { moduleName: string; subject: string };
  onDelta?: (delta: string) => void;
}

/** Run the release agent to its end; its last reply. */
export async function runReleaseAgent(input: ReleaseAgentInput): Promise<string> {
  const { plainFile } = input;
  const tools = createDeployTools({ cwd: input.cwd, state: input.state, defaultPlainFile: () => plainFile });
  // It releases from the host codebase, which holds dist too.
  const dir = hostDirOf(plainFile, input.cwd);
  const notes = projectNotes([input.cwd, dir, projectDirOf(plainFile)]);
  const said = input.guidance ?? input.state.guidance.get(input.afterPulse?.moduleName ?? "");
  const fileTools: AnyTool[] = [
    createReadToolDefinition(dir),
    createLsToolDefinition(dir),
    createGrepToolDefinition(dir),
    createFindToolDefinition(dir),
    // A guided release may say to change the host - a registration, an import.
    outsideBuiltCode(createEditToolDefinition(dir), dir),
    outsideBuiltCode(createWriteToolDefinition(dir), dir),
  ];
  const executor = await createExecutor({
    // Its sessions are kept in the project, not in the folder it deploys.
    cwd: projectDirOf(plainFile),
    customTools: [...fileTools, hostBash(dir), ...tools],
    tools: [...fileTools.map((tool) => tool.name), "bash", ...DEPLOY_TOOLS],
    ...(input.model !== undefined ? { model: input.model } : {}),
    role: "release",
    system: [
      "You get software that was just built running on the person's own machine, so they can try it. You ask no one: do it.",
      `Your file tools and your shell start in ${dir}. Your shell is the person's own - not a sandbox.`,
    ].join("\n"),
    task: [
      input.afterPulse !== undefined
        ? `A pulse of module ${input.afterPulse.moduleName} just landed: ${input.afterPulse.subject}. You release it now, before the module's next pulse starts - if the project's release guidance says to release after a build or a pulse.`
        : `Release ${shortPath(plainFile)} for the person to try, with the release tool, then do what it says.`,
      "",
      "First ask yourself: is there guidance for how this project releases it - what the person said below, the project's",
      "notes and skills below, or anything else you find? If there is, call release with it as guidance, in full: the code is",
      "put in dist/<module>, and the guidance takes it on from there. If there is none, call release without guidance: the",
      "code is put in dist/<module> and started from there, as best it can be.",
      ...(input.afterPulse !== undefined
        ? [
            "",
            "Released after a pulse: when nothing in the guidance says to release after a build, call nothing and say so in a line.",
            "When release says it is already released, leave it at that.",
          ]
        : []),
      ...(input.inModule !== undefined ? ["", `Release the codebase of module ${input.inModule}: pass in_module.`] : []),
      ...(said !== undefined ? ["", "What the person said of how to release it:", said] : []),
      ...(notes.length > 0 ? ["", "The project's notes and skills:", ...notes] : []),
      "",
      "End with what you did, in a line or two: where it runs, or why nothing was released.",
    ].join("\n"),
  });
  try {
    return await ask(executor, BEGIN, input.onDelta);
  } finally {
    executor.dispose();
  }
}
