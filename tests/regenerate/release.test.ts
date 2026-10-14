import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordHistory } from "../../src/regenerate/lineage.ts";
import { exportModule, listDeployed, runningDeployed, startDeployed, stopDeployed } from "../../src/regenerate/release.ts";
import { createDeployState, createDeployTools } from "../../src/release-tools.ts";
import { projectNotes } from "../../src/release-agent.ts";
import { NOTES_FILE } from "../../src/regenerate/notes.ts";
import { RECORD_FILE } from "../../src/regenerate/records.ts";

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
  it("exports into a folder of its own when given one - turri regenerate --build-dir - its code and that of every module below", () => {
    built("base", { "base.py": "BASE = 1\n" });
    built("app", { "base.py": "BASE = 1\n", "app.py": "import base\n", [RECORD_FILE]: "{}" });
    const into = join(dir, "out", "build");
    mkdirSync(into, { recursive: true });
    writeFileSync(join(into, "stale.py"), "old\n");
    mkdirSync(join(into, "stale", "deep"), { recursive: true });
    // The folder itself stays - it may be a mount point, which cannot be removed: only what is in it is replaced.
    const before = statSync(into).ino;
    spec("base");
    const deployment = exportModule(spec("app", "base"), undefined, into);
    expect(deployment.dir).toBe(into);
    expect(readFileSync(join(into, "app.py"), "utf8")).toBe("import base\n");
    expect(existsSync(join(into, "base.py"))).toBe(true);
    expect(existsSync(join(into, "stale.py"))).toBe(false);
    expect(existsSync(join(into, "stale"))).toBe(false);
    expect(statSync(into).ino).toBe(before);
    expect(existsSync(join(into, RECORD_FILE))).toBe(false);
    expect(existsSync(join(dir, "dist"))).toBe(false);
  });

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

  function tools() {
    const state = createDeployState();
    const [deploy, start, stop] = createDeployTools({ cwd: dir, state, defaultPlainFile: () => "app.plain" });
    return { state, deploy: deploy!, start: start!, stop: stop! };
  }

  it("deploys the project's module when none is named, and says what to do next", async () => {
    built("app", { "app.py": "print('hello')\n" });
    spec("app");
    const { deploy } = tools();
    const text = await call(deploy, {});
    expect(text).toContain("Deployed app to");
    expect(text).toContain("outside the sandbox");
    // It installs what it needs itself: nothing is put to the person.
    expect(text).toContain("Install what it needs yourself");
    expect(text).toContain("Do not ask the person");
    expect(text).not.toContain("propose_setup");
  });

  it("puts the last commit in dist first even with guidance, which takes it on from there in the host codebase, nothing put to the person", async () => {
    const code = built("app", { "app.py": "print('hello')\n" });
    spec("app");
    // A job at work: what it has half written is not what is released.
    writeFileSync(join(code, "app.py"), "print('hel");
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "deploy.sh"), "#!/bin/bash\ncp dist/app/app.py deployed.py\n");
    const { deploy, state } = tools();

    const text = await call(deploy, { guidance: "Run scripts/deploy.sh, then scripts/start.sh." });

    expect(text).toContain("Deployed app to");
    expect(text).toContain("Its guidance takes it on from there");
    expect(text).toContain("Run scripts/deploy.sh, then scripts/start.sh.");
    expect(text).toContain("never from");
    expect(readFileSync(join(dir, "dist", "app", "app.py"), "utf8")).toBe("print('hello')\n");
    expect(state.current).toMatchObject({ way: "guided", dir: join(dir, "dist", "app"), hostDir: dir });
    // The host's scripts are the agent's to run, in its own shell.
    expect(text).toContain("Run the project's scripts and install what it needs yourself");
    expect(text).not.toContain("propose_setup");
  });

  it("releases to dist when there is no guidance, or only blank guidance", async () => {
    built("app", { "app.py": "print('hello')\n" });
    spec("app");
    const { deploy, state } = tools();
    await call(deploy, { guidance: "   " });
    expect(state.current).toMatchObject({ way: "dist", dir: join(dir, "dist", "app") });
    expect(state.current?.hostDir).toBeUndefined();
  });

  it("starts a command that fetches as it starts without asking anyone first", async () => {
    built("app", { "app.py": "print('hello')\n" });
    spec("app");
    const { deploy, start } = tools();
    await call(deploy, {});
    const text = await call(start, { name: "app", command: "npx --version >/dev/null 2>&1; sleep 30" });
    expect(text).toContain("app is running");
  }, 30_000);

  it("does nothing for a module whose last commit it already shipped - leaving what runs running - and releases again once a pulse lands", async () => {
    const code = built("app", { "app.py": "print('hello')\n" });
    spec("app");
    const { deploy, start } = tools();
    await call(deploy, {});
    await call(start, { name: "sleeper", command: "sleep 30" });
    // Called again with nothing new: nothing exported, nothing stopped.
    const again = await call(deploy, {});
    expect(again).toContain("Already released");
    expect(again).toContain("Nothing to do");
    expect(runningDeployed().map((item) => item.name)).toEqual(["sleeper"]);
    // A pulse lands: released again, what ran stopped first.
    writeFileSync(join(code, "app.py"), "print('hello again')\n");
    recordHistory(code, "spec diff: app greets again");
    const after = await call(deploy, {});
    expect(after).toContain("Deployed app to");
    expect(after).toContain("Stopped what the last release started: sleeper.");
    expect(readFileSync(join(dir, "dist", "app", "app.py"), "utf8")).toBe("print('hello again')\n");
    // Asked to, it releases again even with nothing new.
    expect(await call(deploy, { again: true })).toContain("Deployed app to");
  }, 30_000);

  it("stops what the last deploy of the module started before it deploys it again", async () => {
    built("app", { "app.py": "print('hello')\n" });
    spec("app");
    const { deploy, start } = tools();
    await call(deploy, {});
    const started = await call(start, { name: "sleeper", command: "sleep 30" });
    expect(started).toContain("sleeper is running");
    const again = await call(deploy, { again: true });
    expect(again).toContain("Stopped what the last release started: sleeper.");
    expect(runningDeployed()).toEqual([]);
  }, 30_000);
});

describe("what the release agent finds guidance in", () => {
  it("reads the project's AGENTS.md and its skills, once each", () => {
    writeFileSync(join(dir, "AGENTS.md"), "Release with scripts/deploy.sh.\n");
    mkdirSync(join(dir, ".agents", "skills", "ship"), { recursive: true });
    writeFileSync(join(dir, ".agents", "skills", "ship", "SKILL.md"), "Then start scripts/start.sh with activate.\n");
    const notes = projectNotes([dir, dir]).join("\n");
    expect(notes).toContain("Release with scripts/deploy.sh.");
    expect(notes).toContain("Then start scripts/start.sh with activate.");
    expect(notes.match(/Release with scripts\/deploy\.sh\./g)).toHaveLength(1);
  });
});
