import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { configModuleOfBuild, readProjectConfig } from "../config.ts";
import { registerSecrets } from "./masking.ts";
import { projectRootOf, modulesScratchDir } from "./paths.ts";

/**
 * The environment every agent command gets, on this machine.
 *
 * Not the host's: the shell turri was started in holds the providers' API keys, cloud credentials, tokens and an SSH
 * agent, and an agent's command - or the code it runs - could read any of them. So only an allow-list passes: the path,
 * the locale, the terminal, the user, and the variables that locate the host's toolchains. Then turri's own: a HOME of
 * the module's own, kept between pulses, so a tool's settings and an agent's dotfiles never land in the person's; a
 * TMPDIR; the package caches in the project, so a dependency downloads once; and git stopped at the module, so a
 * project that is itself a repository is not found from the code. Last, what the project passes on purpose -
 * `agent-env:` in its config - which never replaces turri's own.
 */

/** Passed from the host as they are. */
const ALLOWED = ["PATH", "LANG", "TERM", "TZ", "USER", "LOGNAME", "COLORTERM"];
const ALLOWED_PREFIXES = ["LC_"];

/**
 * The variables that locate a toolchain, each with where it is in the person's home when the host sets none - a fake
 * HOME would otherwise hide it. Without a default, only the host's.
 */
const TOOLCHAIN_LOCATORS: Record<string, string | undefined> = {
  JAVA_HOME: undefined,
  GOROOT: undefined,
  GOPATH: undefined,
  DOTNET_ROOT: undefined,
  ANDROID_HOME: undefined,
  ANDROID_SDK_ROOT: undefined,
  FLUTTER_ROOT: undefined,
  M2_HOME: undefined,
  MAVEN_HOME: undefined,
  GRADLE_HOME: undefined,
  RUSTUP_HOME: ".rustup",
  NVM_DIR: ".nvm",
  PYENV_ROOT: ".pyenv",
  SDKMAN_DIR: ".sdkman",
  VOLTA_HOME: ".volta",
  ASDF_DATA_DIR: ".asdf",
  BUN_INSTALL: ".bun",
  PNPM_HOME: undefined,
};

/** The variables that locate a toolchain - their folders are what the OS sandbox lets a command read of the person's. */
export const TOOLCHAIN_VARIABLES: string[] = Object.keys(TOOLCHAIN_LOCATORS);

/** Where package managers keep their caches: in the project's scratch area, so a dependency downloads once. */
export function packageCacheDir(dir: string): string {
  return join(modulesScratchDir(dir), "cache");
}

/** Every package manager's cache, pointed into `cache`. */
export function cacheEnv(cache: string): Record<string, string> {
  return {
    XDG_CACHE_HOME: cache,
    MAVEN_OPTS: `-Dmaven.repo.local=${join(cache, "m2")}`,
    GRADLE_USER_HOME: join(cache, "gradle"),
    CARGO_HOME: join(cache, "cargo"),
    npm_config_cache: join(cache, "npm"),
    YARN_CACHE_FOLDER: join(cache, "yarn"),
    PIP_CACHE_DIR: join(cache, "pip"),
    UV_CACHE_DIR: join(cache, "uv"),
    GOCACHE: join(cache, "go-build"),
    GOMODCACHE: join(cache, "go-mod"),
  };
}

/** The git identity an agent's commits in a scratch repository get - never the person's. */
const GITCONFIG = "[user]\n\tname = turri\n\temail = turri@localhost\n[init]\n\tdefaultBranch = main\n";

/** A credential `agent-env:` names that is not there. */
export interface MissingCredential {
  /** The file or the variable. */
  name: string;
  why: string;
}

export interface AgentEnvironment {
  /** The whole environment of an agent's command. */
  env: Record<string, string>;
  /** The names of what `agent-env:` passed, sorted - for the prompt, never the values. */
  passed: string[];
  /** The values `agent-env:` passed, by name - what is masked wherever turri shows or writes output. */
  values: Record<string, string>;
  /** What `agent-env:` names that is not there. */
  missing: MissingCredential[];
}

/**
 * The environment of a command an agent runs in `moduleDir` - `plain_modules/<module>`. `hostEnv`: the environment
 * turri was started in; `home`: the person's home folder.
 */
export function agentEnvironment(moduleDir: string, options: { hostEnv?: NodeJS.ProcessEnv; home?: string } = {}): AgentEnvironment {
  const hostEnv = options.hostEnv ?? process.env;
  const home = options.home ?? homedir();
  const module = resolve(moduleDir);
  const name = basename(module);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(hostEnv)) {
    if (value === undefined) continue;
    if (ALLOWED.includes(key) || ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix))) env[key] = value;
  }
  for (const [key, inHome] of Object.entries(TOOLCHAIN_LOCATORS)) {
    const given = hostEnv[key];
    if (given !== undefined && given !== "") env[key] = given;
    else if (inHome !== undefined && existsSync(join(home, inHome))) env[key] = join(home, inHome);
  }

  const { values, missing } = passedCredentials(module, hostEnv);
  // From now on their values are masked in everything an agent is shown and turri writes.
  registerSecrets(values);
  Object.assign(env, values);
  Object.assign(env, turrisOwn(module, name));
  return { env, passed: Object.keys(values).sort(), values, missing };
}

/** HOME, TMPDIR, the caches and git's ceiling: what no setting of the project's replaces. */
function turrisOwn(module: string, name: string): Record<string, string> {
  const scratch = modulesScratchDir(module);
  const fakeHome = join(scratch, "home", name);
  mkdirSync(fakeHome, { recursive: true });
  const gitconfig = join(fakeHome, ".gitconfig");
  if (!existsSync(gitconfig)) writeFileSync(gitconfig, GITCONFIG);
  const tmp = join(scratch, "tmp", name);
  mkdirSync(tmp, { recursive: true });
  // Java takes its temporary folder and its home from the system, not from TMPDIR and HOME - on macOS a per-user folder
  // and the person's home, both outside the sandbox. Every JVM reads JAVA_TOOL_OPTIONS, a test JVM Surefire or Gradle
  // forks too, and an agent's own MAVEN_OPTS does not replace it: Maven without its repository setting falls back to the
  // module's home, not the person's ~/.m2. (Each JVM says on stderr that it picked them up.)
  return {
    ...cacheEnv(packageCacheDir(module)),
    JAVA_TOOL_OPTIONS: `-Djava.io.tmpdir=${tmp} -Duser.home=${fakeHome}`,
    HOME: fakeHome,
    TMPDIR: tmp,
    GIT_CEILING_DIRECTORIES: module,
    ...(process.platform === "darwin" ? { [DARWIN_TEMP_SUFFIX]: darwinTempSuffix(module, name) } : {}),
  };
}

/**
 * On macOS, what a program asks the system for as the per-user temporary folder - not TMPDIR - is that folder with this
 * suffix added: a folder of the module's own inside it. The JVM keeps its attach sockets there (`.java_pid<pid>`), which
 * Mockito's inline mocks, jcmd and jstack attach through; the sandbox reaches this folder alone, never the person's
 * JVMs' sockets beside it.
 */
export const DARWIN_TEMP_SUFFIX = "DIRHELPER_USER_DIR_SUFFIX";

/** The module's own folder in macOS's per-user temporary folder: named for it, and for where it is. */
function darwinTempSuffix(module: string, name: string): string {
  return `turri-${name.replace(/[^\w.-]/g, "_")}-${createHash("sha256").update(resolve(module)).digest("hex").slice(0, 8)}`;
}

/** What `agent-env:` - the project's, with the module's own added - passes, and what of it is not there. Reads only. */
export function passedCredentials(module: string, hostEnv: NodeJS.ProcessEnv): { values: Record<string, string>; missing: MissingCredential[] } {
  const root = projectRootOf(module);
  const setting = readProjectConfig(root, configModuleOfBuild(root, basename(module))).agentEnv;
  const values: Record<string, string> = {};
  const missing: MissingCredential[] = [];
  if (setting === undefined) return { values, missing };
  for (const file of setting.files) {
    const path = resolve(root, file);
    if (!existsSync(path)) {
      missing.push({ name: file, why: `no such file: ${path}` });
      continue;
    }
    Object.assign(values, parseDotenv(readFileSync(path, "utf8")));
  }
  for (const name of setting.vars) {
    const value = hostEnv[name];
    if (value === undefined) missing.push({ name, why: "not set in the environment turri was started in" });
    else if (value === "") missing.push({ name, why: "set, but empty, in the environment turri was started in" });
    else values[name] = value;
  }
  return { values, missing };
}

/** A dotenv file's variables: `KEY=value`, `export KEY=value`, quoted or not; comments and blank lines skipped. */
export function parseDotenv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    let value = match[2]!;
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote));
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    values[match[1]!] = value;
  }
  return values;
}
