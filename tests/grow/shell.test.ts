import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { killAllGroups, runCommand, sweepOrphanedGroups, withPulse } from "../../src/grow/shell.ts";

/**
 * The one way a command runs on this machine: its own process group, a time limit, a stop, and everything a pulse
 * started killed when the pulse ends and when turri exits.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-shell-"));
});
afterEach(() => {
  killAllGroups();
  rmSync(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((done) => setTimeout(done, 50));
  }
  return check();
}

const pidIn = (file: string) => Number(readFileSync(file, "utf8").trim());

describe.skipIf(process.platform === "win32")("runCommand", () => {
  it("runs a command from its folder, in the environment it is given, and returns its output and exit code", async () => {
    const run = await runCommand('pwd; echo "$GREETING"; echo oops >&2; exit 3', { cwd: dir, env: { PATH: process.env.PATH!, GREETING: "hello" } });
    expect(run.exitCode).toBe(3);
    expect(run.output.split("\n")[0]).toBe(realpathSync(dir));
    expect(run.output).toContain("hello\n");
    expect(run.output).toContain("oops\n");
    expect(run.timedOut).toBeUndefined();
  });

  it("streams the output as it comes", async () => {
    const chunks: string[] = [];
    await runCommand("echo one; echo two", { cwd: dir, onData: (data) => chunks.push(data.toString("utf8")) });
    expect(chunks.join("")).toBe("one\ntwo\n");
  });

  it("stops a command at its time limit, with everything it started, and says so", async () => {
    const started = Date.now();
    const run = await runCommand(`sleep 30 & echo $! > child.pid; sleep 30`, { cwd: dir, timeoutMs: 500 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(run).toMatchObject({ exitCode: 124, timedOut: true });
    expect(run.output).toMatch(/\[stopped after 1s, the time limit/);
    expect(await until(() => !alive(pidIn(join(dir, "child.pid"))), 2000)).toBe(true);
  });

  it("says what it was told to when the time limit stops it", async () => {
    const run = await runCommand("sleep 30", { cwd: dir, timeoutMs: 300, timeoutNote: () => "\n[counted as failed]" });
    expect(run.output).toBe("\n[counted as failed]");
  });

  it("ends at once when it is stopped, everything it started with it", async () => {
    const stop = new AbortController();
    const run = runCommand("sleep 30 & echo $! > child.pid; sleep 30", { cwd: dir, signal: stop.signal });
    await until(() => existsSync(join(dir, "child.pid")), 2000);
    stop.abort();
    await expect(run).rejects.toThrow("aborted");
    expect(await until(() => !alive(pidIn(join(dir, "child.pid"))), 2000)).toBe(true);
  });

  it("is not started at all when it was stopped before", async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(runCommand("touch ran", { cwd: dir, signal: stop.signal })).rejects.toThrow("aborted");
    expect(existsSync(join(dir, "ran"))).toBe(false);
  });

  it("returns once the command ends, though a server it put in the background still holds its output", async () => {
    const started = Date.now();
    const run = await runCommand("sleep 30 & echo $! > server.pid; echo started", { cwd: dir, timeoutMs: 10_000 });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(run).toMatchObject({ exitCode: 0, output: "started\n" });
  });

  it("runs the command as `wrap` turns it - the way an OS sandbox goes around it", async () => {
    const run = await runCommand("echo \"$WRAPPED\"", { cwd: dir, wrap: (argv) => ["env", "WRAPPED=yes", ...argv] });
    expect(run.output).toBe("yes\n");
  });
});

describe.skipIf(process.platform === "win32")("a pulse", () => {
  it("lets a server started in the background outlive its command, and kills it when the pulse ends", async () => {
    let server = 0;
    await withPulse(async () => {
      await runCommand("sleep 30 > /dev/null 2>&1 & echo $! > server.pid", { cwd: dir });
      server = pidIn(join(dir, "server.pid"));
      expect(alive(server)).toBe(true);
    });
    expect(await until(() => !alive(server), 2000)).toBe(true);
  });

  it("kills only its own: a pulse running beside it keeps its server", async () => {
    let mine = 0;
    let theirs = 0;
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    const other = withPulse(async () => {
      await runCommand("sleep 30 > /dev/null 2>&1 & echo $! > theirs.pid", { cwd: dir });
      theirs = pidIn(join(dir, "theirs.pid"));
      await held;
    });
    await withPulse(async () => {
      await runCommand("sleep 30 > /dev/null 2>&1 & echo $! > mine.pid", { cwd: dir });
      mine = pidIn(join(dir, "mine.pid"));
    });
    expect(await until(() => !alive(mine), 2000)).toBe(true);
    expect(alive(theirs)).toBe(true);
    release();
    await other;
    expect(await until(() => !alive(theirs), 2000)).toBe(true);
  });

  it("kills what it started however the pulse ends, a throw included", async () => {
    let server = 0;
    await expect(
      withPulse(async () => {
        await runCommand("sleep 30 > /dev/null 2>&1 & echo $! > server.pid", { cwd: dir });
        server = pidIn(join(dir, "server.pid"));
        throw new Error("the pulse failed");
      }),
    ).rejects.toThrow("the pulse failed");
    expect(await until(() => !alive(server), 2000)).toBe(true);
  });
});

/** A turri, cut down: a node process that runs one command leaving a server in the background, then ends as told. */
function aTurri(end: "exit" | "SIGTERM" | "SIGKILL"): Promise<number> {
  const shell = resolve("src/grow/shell.ts");
  const script = [
    `const { runCommand } = await import(${JSON.stringify(shell)});`,
    `await runCommand("sleep 60 > /dev/null 2>&1 & echo $! > server.pid", { cwd: ${JSON.stringify(dir)} });`,
    end === "exit" ? "process.exit(0);" : "console.log('ready'); setInterval(() => {}, 1000);",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((done, fail) => {
    child.stdout.on("data", () => {
      if (end !== "exit") child.kill(end);
    });
    child.on("exit", () => done(pidIn(join(dir, "server.pid"))));
    child.on("error", fail);
  });
}

describe.skipIf(process.platform === "win32")("when turri ends", () => {
  it("kills every group it started as it exits", async () => {
    const server = await aTurri("exit");
    expect(await until(() => !alive(server), 2000)).toBe(true);
  });

  it("kills them when it is ended by a signal", async () => {
    const server = await aTurri("SIGTERM");
    expect(await until(() => !alive(server), 2000)).toBe(true);
  });

  it("has them killed by its watcher when it is killed outright, with no chance to do it itself", async () => {
    const server = await aTurri("SIGKILL");
    expect(await until(() => !alive(server), 6000)).toBe(true);
  });

  it("sweeps at start the groups a turri left behind that nothing killed", async () => {
    // A group recorded by a turri that is gone, its watcher gone with it: still running.
    const left = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    left.unref();
    const records = join(dir, "groups");
    mkdirSync(records);
    const gone = 2_000_000_000;
    writeFileSync(join(records, `${gone}`), `${left.pid}\n`);
    expect(sweepOrphanedGroups(records)).toBe(1);
    expect(await until(() => !alive(left.pid!), 2000)).toBe(true);
    expect(existsSync(join(records, `${gone}`))).toBe(false);
    // A live turri's groups are its own.
    writeFileSync(join(records, `${process.pid}`), `${left.pid}\n`);
    expect(sweepOrphanedGroups(records)).toBe(0);
  });
});
