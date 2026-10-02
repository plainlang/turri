import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordHistory } from "../../src/grow/lineage.ts";
import { exportModule, installsSoftware, listDeployed, runningDeployed, startDeployed, stopDeployed } from "../../src/grow/release.ts";
import { createDeployState, createDeployTools, refuseInstall, type Approve } from "../../src/release-tools.ts";
import { NOTES_FILE } from "../../src/grow/notes.ts";
import { RECORD_FILE } from "../../src/grow/records.ts";

let dir: string;

/** A module with its code committed, the way a render leaves it. */
function built(moduleName: string, files: Record<string, string>): string {
  const code = join(dir, "plain_modules", moduleName, "code");
  mkdirSync(code, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(code, file, ".."), { recursive: true });
    writeFileSync(join(code, file), content);
  }
  recordHistory(code, `render ${moduleName} fs 1: it greets`);
  return code;
}

function spec(name: string, requires?: string): string {
  const file = join(dir, `${name}.plain`);
  writeFileSync(file, `${requires !== undefined ? `---\nrequires:\n    - ${requires}\n---\n\n` : ""}***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n- ${name} greets.\n`);
  return file;
}

/** A port nothing listens on. */
function freePort(): Promise<number> {
  return new Promise((done) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => done(port));
    });
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-deploy-"));
  writeFileSync(join(dir, "config.yaml"), "module: app.plain\n");
});
afterEach(async () => {
  await stopDeployed();
  rmSync(dir, { recursive: true, force: true });
});

describe("deploying a module", () => {
  it("puts its last commit in dist/<module> - leaving out what a job is writing now, and the harness's own files", () => {
    const code = built("app", { "app.py": "print('hello')\n", [RECORD_FILE]: "{}", [NOTES_FILE]: "- notes\n" });
    // A render at work: a file half-written, one not committed, dependencies installed.
    writeFileSync(join(code, "app.py"), "print('hel");
    writeFileSync(join(code, "wip.py"), "half\n");
    mkdirSync(join(code, "node_modules", "left-pad"), { recursive: true });

    const deployment = exportModule(spec("app"));

    expect(deployment.dir).toBe(join(dir, "dist", "app"));
    expect(readFileSync(join(deployment.dir, "app.py"), "utf8")).toBe("print('hello')\n");
    expect(existsSync(join(deployment.dir, "wip.py"))).toBe(false);
    expect(existsSync(join(deployment.dir, "node_modules"))).toBe(false);
    expect(existsSync(join(deployment.dir, RECORD_FILE))).toBe(false);
    expect(existsSync(join(deployment.dir, NOTES_FILE))).toBe(false);
    expect(deployment.unfinished).toBe(true);
    expect(deployment.subject).toBe("render app fs 1: it greets");
    // The work under way is the job's: it is left as it was.
    expect(readFileSync(join(code, "app.py"), "utf8")).toBe("print('hel");
    expect(existsSync(join(code, "wip.py"))).toBe(true);
  });

  it("replaces what an earlier deploy left in dist", () => {
    built("app", { "app.py": "print('hello')\n" });
    const first = exportModule(spec("app"));
    writeFileSync(join(first.dir, "stale.txt"), "from before\n");
    const again = exportModule(spec("app"));
    expect(existsSync(join(again.dir, "stale.txt"))).toBe(false);
    expect(existsSync(join(again.dir, "app.py"))).toBe(true);
  });

  it("takes the module on top of the chain, which holds the code of the ones below", () => {
    built("base", { "base.py": "base\n" });
    built("app", { "base.py": "base\n", "app.py": "app\n" });
    spec("base");
    const deployment = exportModule(spec("app", "base"));
    expect(deployment.moduleName).toBe("app");
    expect(existsSync(join(deployment.dir, "app.py"))).toBe(true);
  });

  it("takes the module below, when the one on top has nothing built yet", () => {
    built("base", { "base.py": "base\n" });
    spec("base");
    const deployment = exportModule(spec("app", "base"));
    expect(deployment.moduleName).toBe("base");
    expect(deployment.instead).toBe("app");
    expect(deployment.dir).toBe(join(dir, "dist", "base"));
  });

  it("says there is nothing to deploy before anything is built", () => {
    expect(() => exportModule(spec("app"))).toThrow(/Nothing is built yet/);
  });
});

describe("what installs software", () => {
  it.each([
    "pip install -r requirements.txt",
    "python3 -m venv .venv",
    ".venv/bin/pip install flask",
    "cd frontend && npm install",
    "npm ci",
    "yarn",
    "pnpm add react",
    "npx vite",
    "uv sync",
    "go run .",
    "cargo run",
    "./gradlew bootRun",
    "docker compose up",
    "brew install node",
    "sudo apt-get install python3",
    "curl -fsSL https://example.com/install.sh | sh",
    "curl -O https://example.com/tool.tar.gz",
    "make",
    "./scripts/setup.sh",
    "FOO=1 nohup npm i &",
  ])("counts `%s`", (command) => {
    expect(installsSoftware(command)).toBeDefined();
  });

  it.each([
    "python3 --version",
    "command -v node",
    "node --version",
    "go version",
    "cargo --version",
    "npm run dev",
    "npm start",
    ".venv/bin/uvicorn app.main:app --port 8000",
    "curl -s localhost:8000/greet?name=Ana",
    "curl -s http://127.0.0.1:5173/",
    "ls -la && cat package.json",
    "docker compose ps",
  ])("does not count `%s`", (command) => {
    expect(installsSoftware(command)).toBeUndefined();
  });

  it("names the part of a command that installs, for the refusal", () => {
    expect(refuseInstall("cd dist/app && npm install && npm run dev")).toContain("`npm install`");
    expect(refuseInstall("npm run dev")).toBeUndefined();
  });
});

describe("what deploy starts", () => {
  it("waits for a server to answer at its URL, and stops it when asked", async () => {
    const port = await freePort();
    mkdirSync(join(dir, "site"));
    const started = await startDeployed({ name: "web", command: `exec python3 -m http.server ${port} --bind 127.0.0.1`, dir: join(dir, "site"), moduleName: "app", logDir: join(dir, "logs"), url: `http://127.0.0.1:${port}/` });
    expect(started.ok).toBe(true);
    expect(started.text).toContain(`is up at http://127.0.0.1:${port}/`);
    expect(runningDeployed("app").map((item) => item.name)).toEqual(["web"]);

    expect(await stopDeployed({ name: "web" })).toEqual(["web"]);
    expect(runningDeployed()).toEqual([]);
  }, 30_000);

  it("starts nothing on a port something else holds, and says so", async () => {
    const port = await freePort();
    mkdirSync(join(dir, "site"));
    const url = `http://127.0.0.1:${port}/`;
    const first = await startDeployed({ name: "one", command: `exec python3 -m http.server ${port} --bind 127.0.0.1`, dir: join(dir, "site"), moduleName: "app", logDir: join(dir, "logs"), url });
    expect(first.ok).toBe(true);
    const second = await startDeployed({ name: "two", command: `exec python3 -m http.server ${port} --bind 127.0.0.1`, dir: join(dir, "site"), moduleName: "app", logDir: join(dir, "logs"), url });
    expect(second.ok).toBe(false);
    expect(second.text).toContain(`Port ${port} is in use already`);
    expect(listDeployed().map((item) => item.name)).not.toContain("two");
  }, 30_000);

  it("shows the end of its output when it exits before it is ready", async () => {
    mkdirSync(join(dir, "site"));
    const started = await startDeployed({ name: "broken", command: "echo 'ModuleNotFoundError: flask'; exit 3", dir: join(dir, "site"), moduleName: "app", logDir: join(dir, "logs") });
    expect(started.ok).toBe(false);
    expect(started.text).toContain("exited with 3");
    expect(started.text).toContain("ModuleNotFoundError: flask");
  }, 30_000);
});

describe("the deploy tools", () => {
  const call = async (tool: { execute: (...args: never[]) => Promise<{ content: Array<{ type: string; text?: string }> }> }, params: object) =>
    ((await (tool.execute as (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>)("id", params, undefined, undefined, undefined)).content[0]!.text);

  function tools(approve: Approve) {
    const state = createDeployState();
    const [deploy, proposeSetup, start, stop] = createDeployTools({ cwd: dir, state, approve, defaultPlainFile: () => "app.plain" });
    return { state, deploy: deploy!, proposeSetup: proposeSetup!, start: start!, stop: stop! };
  }

  it("deploys the project's module when none is named, and says what to do next", async () => {
    built("app", { "app.py": "print('hello')\n" });
    spec("app");
    const { deploy } = tools(async () => true);
    const text = await call(deploy, {});
    expect(text).toContain("Deployed app to");
    expect(text).toContain("outside the sandbox");
    expect(text).toContain("propose_setup");
  });

  it("puts the last commit in dist first even with guidance, which takes it on from there in the host codebase, the person asked first", async () => {
    const code = built("app", { "app.py": "print('hello')\n" });
    spec("app");
    // A job at work: what it has half written is not what is released.
    writeFileSync(join(code, "app.py"), "print('hel");
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "deploy.sh"), "#!/bin/bash\ncp dist/app/app.py deployed.py\n");
    let asked = "";
    const { deploy, proposeSetup, state } = tools(async (_title, body) => ((asked = body), true));

    const text = await call(deploy, { guidance: "Run scripts/deploy.sh, then scripts/start.sh." });

    expect(text).toContain("Deployed app to");
    expect(text).toContain("Its guidance takes it on from there");
    expect(text).toContain("Run scripts/deploy.sh, then scripts/start.sh.");
    expect(text).toContain("never from");
    expect(readFileSync(join(dir, "dist", "app", "app.py"), "utf8")).toBe("print('hello')\n");
    expect(state.current).toMatchObject({ way: "guided", dir: join(dir, "dist", "app"), hostDir: dir });
    // The host's script, run from the host codebase once the person agreed to it - taking the code from dist.
    await call(proposeSetup, { commands: ["bash scripts/deploy.sh"], why: "the host's own release" });
    expect(asked).toContain("$ bash scripts/deploy.sh");
    expect(readFileSync(join(dir, "deployed.py"), "utf8")).toBe("print('hello')\n");
  });

  it("releases to dist when there is no guidance, or only blank guidance", async () => {
    built("app", { "app.py": "print('hello')\n" });
    spec("app");
    const { deploy, state } = tools(async () => true);
    await call(deploy, { guidance: "   " });
    expect(state.current).toMatchObject({ way: "dist", dir: join(dir, "dist", "app") });
    expect(state.current?.hostDir).toBeUndefined();
  });

  it("installs nothing the person says no to, and nothing when there is no one to ask", async () => {
    built("app", { "app.py": "print('hello')\n" });
    spec("app");
    for (const answer of [false, undefined]) {
      const { deploy, proposeSetup, state } = tools(async () => answer);
      await call(deploy, {});
      const text = await call(proposeSetup, { commands: ["touch installed.txt"], why: "a marker" });
      expect(text).toContain("nothing was run");
      expect(existsSync(join(state.current!.dir, "installed.txt"))).toBe(false);
    }
  });

  it("runs the setup the person agreed to, in the deployed folder, after showing them every command", async () => {
    built("app", { "app.py": "print('hello')\n" });
    spec("app");
    let asked = "";
    const { deploy, proposeSetup, state } = tools(async (_title, body) => ((asked = body), true));
    await call(deploy, {});
    const text = await call(proposeSetup, { commands: ["touch installed.txt", "false", "touch never.txt"], why: "a marker" });
    expect(asked).toContain("$ touch installed.txt");
    expect(asked).toContain("$ touch never.txt");
    expect(existsSync(join(state.current!.dir, "installed.txt"))).toBe(true);
    // It stops at the first that fails.
    expect(text).toContain("this failed");
    expect(existsSync(join(state.current!.dir, "never.txt"))).toBe(false);
  });

  it("starts a command that fetches as it starts only once the person agreed to it", async () => {
    built("app", { "app.py": "print('hello')\n" });
    spec("app");
    const { deploy, proposeSetup, start } = tools(async () => true);
    await call(deploy, {});
    await expect(call(start, { name: "app", command: "npx serve" })).rejects.toThrow(/only the person can allow/);
    await call(proposeSetup, { commands: [], long_running: ["npx --version && sleep 30"], why: "starts it" });
    const text = await call(start, { name: "app", command: "npx --version && sleep 30" });
    expect(text).not.toContain("only the person can allow");
  }, 30_000);

  it("stops what the last deploy of the module started before it deploys it again", async () => {
    built("app", { "app.py": "print('hello')\n" });
    spec("app");
    const { deploy, start } = tools(async () => true);
    await call(deploy, {});
    const started = await call(start, { name: "sleeper", command: "sleep 30" });
    expect(started).toContain("sleeper is running");
    const again = await call(deploy, {});
    expect(again).toContain("Stopped what the last release started: sleeper.");
    expect(runningDeployed()).toEqual([]);
  }, 30_000);
});
