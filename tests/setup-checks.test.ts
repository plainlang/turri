import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkGit, checkProject, checkSandbox, checkShell } from "../src/setup.ts";
import { scriptAgainstMachine, stackOf } from "../src/stack.ts";

/** What doctor and setup check, now that agents' commands run on this machine. */

describe("bash", () => {
  it("is what every command runs with: missing, it says how to get one - Git Bash on Windows", () => {
    expect(checkShell(true).level).toBe("ok");
    expect(checkShell(false, "win32")).toMatchObject({ level: "missing", fix: expect.stringContaining("Git for Windows") });
    expect(checkShell(false, "linux")).toMatchObject({ level: "missing", fix: expect.stringContaining("package manager") });
  });
});

describe("git", () => {
  it("is what each module's history is kept in: missing, it stops the run", () => {
    expect(checkGit(true).level).toBe("ok");
    expect(checkGit(false)).toMatchObject({ level: "missing", fix: expect.stringContaining("package manager") });
  });
});

describe("the OS sandbox", () => {
  it("says which wall is up", () => {
    expect(checkSandbox({ kind: "seatbelt" })).toMatchObject({ level: "ok", detail: expect.stringContaining("Seatbelt") });
    expect(checkSandbox({ kind: "bubblewrap", proc: "bind" })).toMatchObject({ level: "ok", detail: expect.stringContaining("the host's /proc bound") });
  });

  it("says why none starts, and how to give it one - and that the check and the audit hold alone", () => {
    const none = checkSandbox({ kind: "none", why: "this machine does not let an unprivileged process create a user namespace", fix: "in Docker, run the container with `--security-opt seccomp=unconfined`" }, "linux");
    expect(none).toMatchObject({ level: "limited", fix: expect.stringContaining("seccomp=unconfined") });
    expect(none.detail).toContain("the command check and the audit hold alone");
    expect(checkSandbox({ kind: "none", why: "Windows has no OS sandbox turri drives" }, "win32").level).toBe("info");
  });
});

describe("a project, against this machine", () => {
  let project: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "turri-doctor-"));
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  it("says which toolchains its modules' implementation reqs name and this machine lacks", () => {
    writeFileSync(join(project, "api.plain"), "***implementation reqs***\n\n- :Implementation: is written in Python with FastAPI.\n\n***functional specs***\n\n- Serve.\n");
    writeFileSync(join(project, "game.plain"), "***implementation reqs***\n\n- :Implementation: is written in Zig.\n\n***functional specs***\n\n- Draw.\n");
    const checks = checkProject(project, { has: (command) => command === "python3" });
    expect(checks).toEqual([
      { level: "ok", name: "api", detail: "has Python" },
      { level: "missing", name: "game", detail: "its implementation reqs need Zig (zig), which this machine lacks", fix: expect.stringContaining("install Zig on this machine") },
    ]);
  });

  it("says what in its testing scripts this machine does not have", () => {
    mkdirSync(join(project, "test_scripts"));
    writeFileSync(join(project, "test_scripts", "run_unittests_java.sh"), "#!/bin/bash\nexport JAVA_HOME=$(/usr/libexec/java_home -v 21)\nmvn -q test\n");
    const checks = checkProject(project, { has: () => false, exists: () => false });
    expect(checks).toEqual([
      {
        level: "limited",
        name: join("test_scripts", "run_unittests_java.sh"),
        detail: "does not fit this machine - it is yours to fix:",
        more: ["names `/usr/libexec/java_home`, which this machine does not have", "runs `mvn`, which is not on this machine's PATH"],
      },
    ]);
  });
});

describe("what a testing script needs of this machine", () => {
  it("is what it names by its whole path and the toolchains it runs - not its comments, its variables or the folders it is handed", () => {
    const script = [
      "#!/bin/bash",
      "# runs pytest in a venv",
      'cd "$1" && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt',
      "PYTHONPATH=src timeout 300 pytest -q | tee /tmp/out.log",
      "ls /usr/share/doc > /dev/null",
    ].join("\n");
    expect(scriptAgainstMachine(script, { has: (command) => command !== "pytest", exists: (path) => path !== "/usr/share/doc" })).toEqual([
      "runs `pytest`, which is not on this machine's PATH",
      "names `/usr/share/doc`, which this machine does not have",
    ]);
    expect(scriptAgainstMachine(script, { has: () => true, exists: () => true })).toEqual([]);
  });
});

describe("what a project's implementation reqs need", () => {
  it("is the toolchains they name, read by keyword, each with the commands that show it is there", () => {
    expect(stackOf("- :Implementation: uses Python 3.12 with FastAPI.\n- The frontend is React, built with Vite.").map((need) => need.toolchain)).toEqual(["Python", "Node"]);
    expect(stackOf("- :Implementation: is written in Rust with Axum.")[0]).toEqual({ toolchain: "Rust", commands: ["cargo"], words: ["rust", "axum"] });
  });
});

describe("the toolchains a stack can be chosen from", () => {
  it("says which of the standard library's languages this machine can build, which it lacks, and to offer only the first", async () => {
    const { toolchainsBlock, languagesOnMachine } = await import("../src/stack.ts");
    // A laptop with uv and Node, no Go, no Rust, no JDK.
    const has = (command: string) => ["uv", "node", "npm"].includes(command);
    expect(languagesOnMachine(has).ready.map((entry) => entry.language)).toEqual(["Python", "TypeScript"]);
    const block = toolchainsBlock(has);
    expect(block).toContain("It can build and test now: Python (uv), TypeScript (node, npm).");
    expect(block).toContain("It lacks, to build: Go (go), Rust (cargo), Java (java) - not installed.");
    expect(block).toContain("offer only those in a language it can build now, and choose only among them");
    // Node without npm builds no TypeScript stack.
    expect(languagesOnMachine((command) => command === "node").ready).toEqual([]);
  });
});
