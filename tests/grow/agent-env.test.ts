import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentEnvironment } from "../../src/grow/agent-env.ts";
import { runCommand } from "../../src/grow/shell.ts";

/**
 * The environment every agent command gets: what the host may pass (an allow-list), its toolchains, turri's own -
 * a fake HOME kept for the module, a TMPDIR, the package caches, git stopped at the module - and the credentials the
 * project names in `agent-env:`.
 */

let project: string;
let home: string;
let module: string;
beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), "turri-agent-env-")));
  home = join(project, "the-persons-home");
  module = join(project, "plain_modules", "app");
  mkdirSync(join(module, "code"), { recursive: true });
  mkdirSync(home);
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

const host = {
  PATH: "/usr/bin:/bin",
  LANG: "en_GB.UTF-8",
  LC_ALL: "en_GB.UTF-8",
  TERM: "xterm-256color",
  TZ: "Europe/Ljubljana",
  USER: "zan",
  HOME: "/Users/zan",
  JAVA_HOME: "/opt/jdk-21",
  ANTHROPIC_API_KEY: "sk-ant-secret",
  OPENAI_API_KEY: "sk-secret",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  GITHUB_TOKEN: "ghp_secret",
  SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
  D365_TENANT_ID: "tenant-1",
};

describe("the environment of an agent's command", () => {
  it("passes on only what the host may - the path, the locale, the terminal, the user - and no key or token", () => {
    const { env } = agentEnvironment(module, { hostEnv: host, home });
    expect(env).toMatchObject({ PATH: "/usr/bin:/bin", LANG: "en_GB.UTF-8", LC_ALL: "en_GB.UTF-8", TERM: "xterm-256color", TZ: "Europe/Ljubljana", USER: "zan" });
    for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "D365_TENANT_ID"]) {
      expect(env[name]).toBeUndefined();
    }
  });

  it("keeps the host's toolchains in reach, a locator in the real home defaulted when the host sets none", () => {
    mkdirSync(join(home, ".nvm"));
    mkdirSync(join(home, ".rustup"));
    const { env } = agentEnvironment(module, { hostEnv: host, home });
    expect(env.JAVA_HOME).toBe("/opt/jdk-21");
    expect(env.NVM_DIR).toBe(join(home, ".nvm"));
    expect(env.RUSTUP_HOME).toBe(join(home, ".rustup"));
    // Not there, not set: nothing points at a folder that does not exist.
    expect(env.PYENV_ROOT).toBeUndefined();
    // The host's own setting wins over the default.
    expect(agentEnvironment(module, { hostEnv: { ...host, NVM_DIR: "/opt/nvm" }, home }).env.NVM_DIR).toBe("/opt/nvm");
  });

  it("gives the module a home of its own, kept between pulses, with a git identity, and a TMPDIR", () => {
    const { env } = agentEnvironment(module, { hostEnv: host, home });
    expect(env.HOME).toBe(join(project, "plain_modules", ".turri", "home", "app"));
    expect(readFileSync(join(env.HOME!, ".gitconfig"), "utf8")).toContain("name = turri");
    writeFileSync(join(env.HOME!, ".npmrc"), "fund=false\n");
    const again = agentEnvironment(module, { hostEnv: host, home }).env;
    expect(readFileSync(join(again.HOME!, ".npmrc"), "utf8")).toBe("fund=false\n");
    expect(env.TMPDIR).toBe(join(project, "plain_modules", ".turri", "tmp", "app"));
    expect(existsSync(env.TMPDIR!)).toBe(true);
  });

  it("keeps the package caches in the project, so a dependency downloads once", () => {
    const { env } = agentEnvironment(module, { hostEnv: host, home });
    const cache = join(project, "plain_modules", ".turri", "cache");
    expect(env).toMatchObject({ npm_config_cache: join(cache, "npm"), PIP_CACHE_DIR: join(cache, "pip"), GOMODCACHE: join(cache, "go-mod") });
    expect(env.MAVEN_OPTS).toBe(`-Dmaven.repo.local=${join(cache, "m2")} -Djava.io.tmpdir=${env.TMPDIR}`);
    // Java's temporary files go to the module's TMPDIR, not the system's.
    expect(env.GRADLE_OPTS).toBe(`-Djava.io.tmpdir=${env.TMPDIR}`);
  });

  it.skipIf(process.platform === "win32")("stops git at the module, so a project that is itself a repository is not found from the code", async () => {
    execSync("git init -q", { cwd: project });
    const { env } = agentEnvironment(module, { hostEnv: { ...host, PATH: process.env.PATH! }, home });
    expect(env.GIT_CEILING_DIRECTORIES).toBe(module);
    const run = await runCommand("git rev-parse --show-toplevel", { cwd: join(module, "code"), env });
    expect(run.exitCode).not.toBe(0);
    expect(run.output).toMatch(/not a git repository/);
  });
});

describe("agent-env: the credentials a project passes to its agents", () => {
  it("passes every variable of the dotenv files it names, and the variables it names from turri's own environment", () => {
    writeFileSync(join(project, ".env"), ["# the Dynamics app", "export D365_CLIENT_ID=client-1", "D365_CLIENT_SECRET='s3cr3t=='", 'D365_URL="https://org.crm.dynamics.com"', ""].join("\n"));
    writeFileSync(join(project, "config.yaml"), "agent-env:\n  files: [.env]\n  vars: [D365_TENANT_ID]\n");
    const result = agentEnvironment(module, { hostEnv: host, home });
    expect(result.env).toMatchObject({ D365_CLIENT_ID: "client-1", D365_CLIENT_SECRET: "s3cr3t==", D365_URL: "https://org.crm.dynamics.com", D365_TENANT_ID: "tenant-1" });
    expect(result.passed).toEqual(["D365_CLIENT_ID", "D365_CLIENT_SECRET", "D365_TENANT_ID", "D365_URL"]);
    expect(result.missing).toEqual([]);
    // turri's own are never overridden by what is passed.
    writeFileSync(join(project, ".env"), "HOME=/Users/zan\n");
    expect(agentEnvironment(module, { hostEnv: host, home }).env.HOME).toBe(join(project, "plain_modules", ".turri", "home", "app"));
  });

  it("adds a module's own to the project's", () => {
    writeFileSync(join(project, "config.yaml"), "agent-env:\n  vars: [D365_TENANT_ID]\n");
    writeFileSync(join(project, "config.app.yaml"), "agent-env:\n  vars: [GITHUB_TOKEN]\n");
    const result = agentEnvironment(module, { hostEnv: host, home });
    expect(result.passed).toEqual(["D365_TENANT_ID", "GITHUB_TOKEN"]);
    // Another module has only the project's.
    mkdirSync(join(project, "plain_modules", "web", "code"), { recursive: true });
    expect(agentEnvironment(join(project, "plain_modules", "web"), { hostEnv: host, home }).passed).toEqual(["D365_TENANT_ID"]);
  });

  it("reports a credential it names that is not there - no such file, no such variable, an empty one", () => {
    writeFileSync(join(project, "config.yaml"), "agent-env:\n  files: [.env.d365]\n  vars: [D365_TENANT_ID, D365_SECRET, EMPTY_ONE]\n");
    const result = agentEnvironment(module, { hostEnv: { ...host, EMPTY_ONE: "" }, home });
    expect(result.missing).toEqual([
      { name: ".env.d365", why: `no such file: ${join(project, ".env.d365")}` },
      { name: "D365_SECRET", why: "not set in the environment turri was started in" },
      { name: "EMPTY_ONE", why: "set, but empty, in the environment turri was started in" },
    ]);
    expect(result.passed).toEqual(["D365_TENANT_ID"]);
  });
});
