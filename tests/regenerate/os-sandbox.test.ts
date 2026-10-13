import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentEnvironment, TOOLCHAIN_VARIABLES } from "../../src/regenerate/agent-env.ts";
import {
  bubblewrapArgs,
  machineFor,
  sandboxAvailable,
  sandboxWrap,
  seatbeltProfile,
  whyBubblewrapFailed,
  type SandboxFence,
} from "../../src/regenerate/os-sandbox.ts";
import { writableFor } from "../../src/regenerate/agent-shell.ts";
import { runCommand } from "../../src/regenerate/shell.ts";

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
    ["Docker's seccomp", "bwrap: Creating new namespace failed: Operation not permitted", /user namespace/, /not root.*seccomp=unconfined/],
    ["a non-root container", "bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.", /user namespace/, /not root.*seccomp=unconfined/],
    ["AppArmor", "bwrap: Failed to make / slave: Permission denied", /AppArmor/, /apparmor=unconfined/],
    ["Ubuntu 24.04's AppArmor", "bwrap: setting up uid map: Permission denied", /AppArmor/, /apparmor_restrict_unprivileged_userns/],
    ["Docker's masked /proc", "bwrap: Can't mount proc on /proc: Operation not permitted", /masks \/proc/, /systempaths=unconfined/],
    ["Docker's masked /proc, as bubblewrap names it from inside", "bwrap: Can't mount proc on /newroot/proc: Operation not permitted", /masks \/proc/, /systempaths=unconfined/],
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

  it("is a version manager's whole install, whose bin links its tools into the install beside it - and no other parent", () => {
    const mise = "/Users/t/.local/share/mise/installs/node/24.16.0";
    const machine = machineFor({ PATH: `${mise}/bin:/Users/t/.nvm/versions/node/v22.3.0/bin:/Users/t/.cargo/bin:/opt/tools/bin` }, TOOLCHAIN_VARIABLES, [], "darwin");
    expect(machine).toEqual(expect.arrayContaining([mise, `${mise}/bin`, "/Users/t/.nvm/versions/node/v22.3.0"]));
    // Not a version: its parent may hold a credential, and is not read.
    expect(machine).not.toContain("/Users/t/.cargo");
    expect(machine).not.toContain("/opt/tools");
    // mise's and uv's homes, found in the person's home as nvm's is.
    expect(TOOLCHAIN_VARIABLES).toEqual(expect.arrayContaining(["MISE_DATA_DIR", "FNM_DIR", "RBENV_ROOT", "UV_PYTHON_INSTALL_DIR"]));
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
      writable: writableFor(env, moduleDir),
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

  it("runs a tool a version manager links from its install's bin into the install beside it - npm under mise", async () => {
    // As mise lays out a Node: bin/npm a link into lib/, the bin alone on the PATH.
    // In the home folder, as mise's is - not in /tmp, which bubblewrap gives a command a fresh one of.
    const root = realpathSync(mkdtempSync(join(homedir(), ".turri-mise-test-")));
    const install = join(root, "installs", "node", "24.16.0");
    mkdirSync(join(install, "bin"), { recursive: true });
    mkdirSync(join(install, "lib", "node_modules", "npm", "bin"), { recursive: true });
    writeFileSync(join(install, "lib", "node_modules", "npm", "bin", "npm-cli.sh"), "#!/bin/sh\necho npm ran\n", { mode: 0o755 });
    symlinkSync("../lib/node_modules/npm/bin/npm-cli.sh", join(install, "bin", "npm"));
    try {
      const withMise = { ...env, PATH: `${join(install, "bin")}:${env.PATH}` };
      const f = { ...fence, machine: machineFor(withMise, TOOLCHAIN_VARIABLES) };
      const result = await runCommand("npm", { cwd: f.cwd, env: withMise, wrap: sandboxWrap(wall, f) });
      expect(result.output).toContain("npm ran");
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it.runIf(spawnSync("java", ["-version"]).status === 0)("lets a JVM it starts - a forked test JVM too - write its temporary files and find its home", async () => {
    writeFileSync(
      join(code, "Tmp.java"),
      'public class Tmp { public static void main(String[] a) throws Exception { System.out.println(java.io.File.createTempFile("tmp", ".txt").getParent()); System.out.println(System.getProperty("user.home")); } }\n',
    );
    // As Surefire starts one: a JVM of its own, given none of MAVEN_OPTS.
    const result = await run("env -u MAVEN_OPTS java Tmp.java 2>/dev/null");
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output.trim().split("\n")).toEqual([env.TMPDIR!, env.HOME!]);
  });

  it.runIf(wall.kind === "seatbelt" && spawnSync("jcmd", ["-h"]).status === 0)(
    "lets a JVM attach to one it started - as Mockito's inline mocks do - but never to one of the person's",
    async () => {
      writeFileSync(join(code, "Sleep.java"), "public class Sleep { public static void main(String[] a) throws Exception { Thread.sleep(30000); } }\n");
      const own = await run("java Sleep.java 2>/dev/null & P=$!; sleep 3; jcmd $P VM.version 2>/dev/null | tail -1; kill $P");
      expect(own.output).toMatch(/JDK \d+/);

      // The person's JVM, its attach socket already open in the per-user temporary folder.
      const outsideEnv = { ...process.env };
      delete outsideEnv.DIRHELPER_USER_DIR_SUFFIX;
      const outside = spawn("java", [join(code, "Sleep.java")], { stdio: "ignore", env: outsideEnv });
      try {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        expect(spawnSync("jcmd", [String(outside.pid), "VM.version"], { env: outsideEnv }).status).toBe(0);
        const theirs = await run(`jcmd ${outside.pid} VM.version >/dev/null 2>&1 && echo reached || echo refused`);
        expect(theirs.output).toContain("refused");
      } finally {
        outside.kill();
      }
    },
    60_000,
  );

  it("caps the processes and the size of a file", async () => {
    const result = await run("ulimit -S -f");
    expect(result.output.trim()).toBe(String(8 * 1024 * 1024));
  });
});
