import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentEnvironment, TOOLCHAIN_VARIABLES } from "../../src/grow/agent-env.ts";
import {
  bubblewrapArgs,
  machineFor,
  sandboxAvailable,
  sandboxWrap,
  seatbeltProfile,
  whyBubblewrapFailed,
  type SandboxFence,
} from "../../src/grow/os-sandbox.ts";
import { runCommand } from "../../src/grow/shell.ts";

/**
 * The OS sandbox under an agent's command: the profile and arguments it is built from, per role, the same on every
 * platform - and, where this machine has one, real commands run behind it.
 */

const module = "/work/shop/plain_modules/app";
const scratch = "/work/shop/plain_modules/.turri";
const shared = {
  writable: [`${scratch}/home/app`, `${scratch}/tmp/app`, `${scratch}/cache`],
  machine: ["/usr", "/bin", "/opt/jdk-21"],
  deny: [`${module}/code/.turri.json`],
};
const roles: Record<string, SandboxFence> = {
  coding: { cwd: `${module}/code`, read: [], write: [`${module}/code`], ...shared },
  conformance: { cwd: `${module}/tests`, read: [`${module}/code`], write: [`${module}/tests`], ...shared },
  explorer: { cwd: `${module}/code`, read: [`${module}/code`], write: [], ...shared },
};
const userDirs = { temp: "/private/var/folders/xy/T", cache: "/private/var/folders/xy/C" };

describe("the Seatbelt profile, per role", () => {
  it.each(Object.keys(roles))("is generated from the %s agent's fence", (role) => {
    expect(seatbeltProfile(roles[role]!, userDirs)).toMatchSnapshot();
  });

  it("lets the coding agent write its code, and a reading role write none of its roots", () => {
    expect(seatbeltProfile(roles.coding!, userDirs)).toMatch(/\(allow file-write\*\n {2}\(subpath "\/work\/shop\/plain_modules\/app\/code"\)/);
    const explorer = seatbeltProfile(roles.explorer!, userDirs);
    const writes = explorer.slice(explorer.indexOf("(allow file-write*"), explorer.indexOf(")\n", explorer.indexOf("(allow file-write*")));
    expect(writes).not.toContain(`${module}/code"`);
  });

  it("denies the code record, Unix sockets outside the folders, and signals and process information beyond the sandbox", () => {
    const profile = seatbeltProfile(roles.coding!, userDirs);
    expect(profile).toContain(`(deny file-read-data file-read-xattr file-write* (literal "${module}/code/.turri.json"))`);
    expect(profile).toContain("(deny network-outbound (remote unix-socket))");
    expect(profile).toContain("(allow signal (target same-sandbox))");
    expect(profile).toContain("(allow process-info* (target same-sandbox))");
    expect(profile).not.toMatch(/network-outbound \(remote ip/);
  });
});

describe("the bubblewrap arguments, per role", () => {
  it.each(Object.keys(roles))("are generated from the %s agent's fence", (role) => {
    expect(bubblewrapArgs(roles[role]!)).toMatchSnapshot();
  });

  it("binds a reading role's roots read only, its own PID namespace, and the host's /proc where mounting one is refused", () => {
    const args = bubblewrapArgs(roles.conformance!).join(" ");
    expect(args).toContain(`--ro-bind ${module}/code ${module}/code`);
    expect(args).toContain(`--bind ${module}/tests ${module}/tests`);
    expect(args).toContain("--unshare-pid");
    expect(args).not.toContain("--unshare-net");
    expect(args).toContain("--proc /proc");
    expect(bubblewrapArgs(roles.conformance!, { proc: "bind" }).join(" ")).toContain("--ro-bind /proc /proc");
  });
});

describe("why bubblewrap does not start", () => {
  it.each([
    ["it is not installed", "spawnSync bwrap ENOENT", /not installed/, /apt install bubblewrap/],
    ["Docker's seccomp", "bwrap: Creating new namespace failed: Operation not permitted", /user namespace/, /seccomp=unconfined/],
    ["a non-root container", "bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.", /user namespace/, /seccomp=unconfined/],
    ["AppArmor", "bwrap: Failed to make / slave: Permission denied", /AppArmor/, /apparmor=unconfined/],
    ["Ubuntu 24.04's AppArmor", "bwrap: setting up uid map: Permission denied", /AppArmor/, /apparmor_restrict_unprivileged_userns/],
    ["Docker's masked /proc", "bwrap: Can't mount proc on /proc: Operation not permitted", /masks \/proc/, /systempaths=unconfined/],
  ])("says so when %s", (_what, output, why, fix) => {
    const said = whyBubblewrapFailed(output);
    expect(said.why).toMatch(why);
    expect(said.fix).toMatch(fix);
  });
});

describe("what of the machine a command reads", () => {
  it("is the system's folders, the PATH's folders - not their parents - and the toolchains", () => {
    const machine = machineFor({ PATH: "/usr/bin:/Users/zan/.cargo/bin:relative/bin", JAVA_HOME: "/opt/jdk-21", RUSTUP_HOME: "/Users/zan/.rustup" }, TOOLCHAIN_VARIABLES, ["/srv/zig"], "linux");
    expect(machine).toEqual(expect.arrayContaining(["/usr", "/etc", "/usr/bin", "/Users/zan/.cargo/bin", "/opt/jdk-21", "/Users/zan/.rustup", "/srv/zig"]));
    expect(machine).not.toContain("/Users/zan/.cargo");
    expect(machine).not.toContain("relative/bin");
  });
});

const wall = sandboxAvailable();

describe.runIf(wall.kind !== "none")(`behind ${wall.kind === "none" ? "no wall" : wall.kind}, for real`, () => {
  let project: string;
  let code: string;
  let fence: SandboxFence;
  let env: Record<string, string>;
  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "turri-os-sandbox-")));
    const moduleDir = join(project, "plain_modules", "app");
    code = join(moduleDir, "code");
    mkdirSync(code, { recursive: true });
    mkdirSync(join(project, "plain_modules", "web", "code"), { recursive: true });
    writeFileSync(join(project, "plain_modules", "web", "code", "app.py"), "theirs\n");
    writeFileSync(join(project, "app.plain"), "the spec\n");
    writeFileSync(join(code, ".turri.json"), "{}\n");
    env = agentEnvironment(moduleDir).env;
    fence = {
      cwd: code,
      read: [],
      write: [code],
      writable: [env.HOME!, env.TMPDIR!, join(project, "plain_modules", ".turri", "cache")],
      machine: machineFor(env, TOOLCHAIN_VARIABLES),
      deny: [join(code, ".turri.json")],
    };
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  const run = (command: string, f: SandboxFence = fence) => runCommand(command, { cwd: f.cwd, env, wrap: sandboxWrap(wall, f) });

  it("writes its own folder, its home and its TMPDIR, and runs the toolchains", async () => {
    const result = await run('echo hi > ok.txt && cat ok.txt && touch ~/.npmrc "$TMPDIR/t" && python3 -c "print(6*7)" && git --version');
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/^hi\n42\ngit version/);
  });

  it("cannot read the spec, a sibling module or the code record, nor write the sibling", async () => {
    for (const command of [`cat ${project}/app.plain`, `cat ${project}/plain_modules/web/code/app.py`, "cat .turri.json", `echo mine > ${project}/plain_modules/web/code/app.py`]) {
      const result = await run(command);
      expect(result.exitCode, command).not.toBe(0);
    }
    expect(readFileSync(join(project, "plain_modules", "web", "code", "app.py"), "utf8")).toBe("theirs\n");
  });

  it("keeps a reading role's roots read only in the shell too", async () => {
    const reader = { ...fence, read: [code], write: [] };
    expect((await run("cat .turri.json; ls >/dev/null && echo listed", reader)).output).toContain("listed");
    const result = await run("echo x > new.txt", reader);
    expect(result.exitCode).not.toBe(0);
  });

  it("cannot signal a process it did not start", async () => {
    const outside = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const result = await run(`kill -0 ${outside.pid} && echo reached || echo refused`);
      expect(result.output).toContain("refused");
    } finally {
      outside.kill();
    }
  });

  it("caps the processes and the size of a file", async () => {
    const result = await run("ulimit -S -f");
    expect(result.output.trim()).toBe(String(8 * 1024 * 1024));
  });
});
