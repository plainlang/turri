import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { projectImplementationReqs, stackOf } from "../stack.ts";
import { MODULES_DIR, projectRootOf } from "./paths.ts";
import { RECORD_FILE } from "./records.ts";
import { listFiles } from "./testing.ts";

/**
 * What an agent is told up front about its folder and this machine, beside its walls - what agents otherwise go looking
 * for, a command at a time: whether there is anything above their folder, its git history, the toolchains' versions,
 * where the build's dependencies come from. On the hycu runs a wandering model spent a third of its calls on these.
 */

/** The commands that say a toolchain's version, by the toolchain's name as `stackOf` gives it. */
const VERSION_COMMANDS: Record<string, string[]> = {
  Python: ["python3"],
  Node: ["node", "npm"],
  Java: ["java", "mvn", "gradle"],
  Go: ["go"],
  Rust: ["cargo"],
  "C/C++": ["cc"],
  Zig: ["zig"],
  Odin: ["odin"],
  Ruby: ["ruby"],
  PHP: ["php"],
  Elixir: ["elixir"],
};

/** How each command is asked its version. */
const VERSION_ARGS: Record<string, string[]> = { java: ["-version"], go: ["version"], zig: ["version"], odin: ["version"], ruby: ["-v"], php: ["-v"], mvn: ["-v"] };

const probed = new Map<string, string | undefined>();

/** The first line a command gives for its version on this machine - asked once - or nothing when it is not here. */
function probeVersion(command: string): string | undefined {
  if (probed.has(command)) return probed.get(command);
  const run = spawnSync(command, VERSION_ARGS[command] ?? ["--version"], { encoding: "utf8", timeout: 10_000, env: { ...process.env, JAVA_TOOL_OPTIONS: "" } });
  const first =
    run.status === 0 || (run.status !== null && (run.stdout || run.stderr))
      ? `${run.stdout ?? ""}\n${run.stderr ?? ""}`
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line !== "" && !line.startsWith("Picked up"))
      : undefined;
  const version = run.error === undefined ? first : undefined;
  probed.set(command, version);
  return version;
}

/** What the build tools of a toolchain fetch from, and where it is kept - said without a path. */
const DEPENDENCIES: Record<string, string> = {
  Java:
    "Maven's local repository is set for you, a cache shared by the project's modules: you need not look for it - and if " +
    "you set `MAVEN_OPTS`, keep `-Dmaven.repo.local` from it. Gradle's home is set the same way. `JAVA_TOOL_OPTIONS` gives " +
    'every JVM its temporary folder and home: leave it set; each JVM printing "Picked up JAVA_TOOL_OPTIONS" is expected.',
  Node: "npm's cache is set for you, shared by the project's modules; packages install into the project's `node_modules`.",
  Python: "pip's and uv's caches are set for you; packages install into the project's own virtual environment.",
  Go: "Go's module cache and build cache are set for you, shared by the project's modules.",
  Rust: "Cargo's home is set for you, shared by the project's modules.",
};

export interface WorkspaceInput {
  /** The agent's folder. */
  dir: string;
  /** Whether the agent has my_diff, which shows its work. */
  hasMyDiff: boolean;
  /** The module's implementation reqs, which name its stack; read from its spec when not given. */
  implementationReqs?: string[];
  /** For tests: a command's version, in place of asking this machine. */
  probe?: (command: string) => string | undefined;
}

/** The implementation reqs of the module a folder is part of - `plain_modules/<module>/...` - from its spec, imports in. */
function reqsOfModule(dir: string): string[] {
  const parts = resolve(dir).split(sep);
  const index = parts.lastIndexOf(MODULES_DIR);
  if (index < 0 || parts.length <= index + 1) return [];
  const module = parts[index + 1]!;
  return projectImplementationReqs(projectRootOf(dir)).find((entry) => entry.module === module)?.reqs ?? [];
}

/** The block, for the agent's system prompt beside its walls. */
export function workspaceBlock(input: WorkspaceInput): string {
  const probe = input.probe ?? probeVersion;
  const files = listFiles(input.dir);
  const folder =
    files.length === 0
      ? `- Your folder, \`${input.dir}\`, is empty: nothing is built yet, and there is nothing above it to find.`
      : existsSync(join(input.dir, RECORD_FILE))
        ? `- Your folder, \`${input.dir}\`, holds the code built so far, and its unit tests passed when it was committed: you need not run them before you change anything.`
        : `- Your folder, \`${input.dir}\`, holds what was written so far, ${files.length} file${files.length === 1 ? "" : "s"}.`;
  const lines = [
    "<your folder and this machine>",
    folder,
    input.hasMyDiff
      ? "- It is not a git repository, and none above it is yours: `my_diff` shows what you have changed in this pulse."
      : "- It is not a git repository, and none above it is yours.",
  ];
  const needs = stackOf((input.implementationReqs ?? reqsOfModule(input.dir)).join("\n"));
  for (const need of needs) {
    const commands = VERSION_COMMANDS[need.toolchain] ?? need.commands;
    // A bare number says nothing on its own: `npm 11.19.1`, not `11.19.1`.
    const versions = commands
      .map((command) => {
        const version = probe(command);
        return version === undefined ? undefined : /^v?\d/.test(version) ? `${command} ${version}` : version;
      })
      .filter((version): version is string => version !== undefined);
    lines.push(
      versions.length > 0
        ? `- ${need.toolchain}: ${versions.join("; ")}.`
        : `- ${need.toolchain}: not on this machine - report it with report_environment_error if the work needs it.`,
    );
    const dependencies = DEPENDENCIES[need.toolchain];
    if (dependencies !== undefined && versions.length > 0) lines.push(`  ${dependencies}`);
  }
  lines.push("- The network is open: the build tools fetch what the manifest declares.", "</your folder and this machine>");
  return lines.join("\n");
}
