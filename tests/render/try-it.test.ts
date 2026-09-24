import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tryDirFor } from "../../src/render/paths.ts";
import { checkTryIt, failedStepsPrompt, prepareTryDir, type TryIt, tryItProblems } from "../../src/render/try-it.ts";

const tryIt: TryIt = {
  setup: ["make deps"],
  steps: [
    { do: "./app hello", expect: "prints hello", kind: "command" },
    { do: "./app serve", expect: "serves", kind: "long_running" },
    { do: "open the page", expect: "it loads", kind: "manual" },
  ],
};

function fake(results: Record<string, number>) {
  const ran: string[] = [];
  const run = async (_cwd: string, command: string) => {
    ran.push(command);
    // A server is started in the background and answers with its pid.
    if (command.startsWith("setsid nohup")) return { exitCode: 0, output: "4242\n" };
    return { exitCode: results[command] ?? 0, output: `ran ${command}` };
  };
  return { ran, run };
}
const quick = { pause: async () => {} };

describe("checking the try-it steps", () => {
  it("runs setup and every command, starts the server and stops it, and leaves manual steps", async () => {
    const { ran, run } = fake({});
    const result = await checkTryIt("/build", tryIt, run, quick);
    expect(ran[0]).toBe("make deps");
    expect(ran[1]).toBe("./app hello");
    expect(ran[2]).toMatch(/^setsid nohup bash -c '\.\/app serve' > \/tmp\/plainwright-try-1\.log/);
    expect(ran[3]).toContain("/proc/4242/status");
    expect(ran.at(-1)).toContain("kill -- -4242");
    expect(ran.some((command) => command.includes("open the page"))).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.tryIt.steps.map((step) => step.exitCode)).toEqual([0, 0, undefined]);
  });

  it("runs the steps after a server against it, retrying while it starts", async () => {
    const serverFirst: TryIt = {
      setup: [],
      steps: [
        { do: "./app serve", expect: "serves", kind: "long_running" },
        { do: "curl -s localhost:8000", expect: "hello", kind: "command" },
      ],
    };
    let tries = 0;
    const run = async (_cwd: string, command: string) => {
      if (command.startsWith("setsid nohup")) return { exitCode: 0, output: "7\n" };
      if (command === "curl -s localhost:8000") return { exitCode: ++tries < 3 ? 7 : 0, output: "" };
      return { exitCode: 0, output: "" };
    };
    const result = await checkTryIt("/build", serverFirst, run, quick);
    expect(tries).toBe(3);
    expect(result.ok).toBe(true);
  });

  it("fails a server that does not stay up", async () => {
    const run = async (_cwd: string, command: string) => {
      if (command.startsWith("setsid nohup")) return { exitCode: 0, output: "9\n" };
      if (command.includes("/proc/9/status")) return { exitCode: 1, output: "Address already in use" };
      return { exitCode: 0, output: "" };
    };
    const result = await checkTryIt("/build", tryIt, run, quick);
    expect(result.ok).toBe(false);
    expect(result.tryIt.steps[1]!.exitCode).toBe(1);
    expect(result.outputs.get("./app serve")).toContain("Address already in use");
  });

  it("records a failing step", async () => {
    const { run } = fake({ "./app hello": 2 });
    const result = await checkTryIt("/build", tryIt, run, quick);
    expect(result.ok).toBe(false);
    expect(result.tryIt.steps[0]!.exitCode).toBe(2);
    expect(failedStepsPrompt(result.tryIt, result.outputs)).toContain("$ ./app hello\nran ./app hello");
  });

  it("stops at a failing setup command", async () => {
    const { ran, run } = fake({ "make deps": 1 });
    const result = await checkTryIt("/build", tryIt, run, quick);
    expect(ran).toEqual(["make deps"]);
    expect(result.ok).toBe(false);
    expect(result.tryIt.failedSetup).toEqual(["make deps"]);
  });
});

describe("what the agent may hand the person", () => {
  it("is a few plain, short, portable steps", () => {
    expect(tryItProblems(tryIt)).toEqual([]);
    const long: TryIt = {
      setup: ["sudo apt-get install libpq-dev", "a", "b", "c"],
      steps: Array.from({ length: 6 }, (_, i) => ({ do: `step ${i}`, expect: "ok", kind: "command" as const })),
    };
    const problems = tryItProblems(long).join("\n");
    expect(problems).toContain("4 setup commands - at most 3");
    expect(problems).toContain("6 steps - at most 5");
    expect(problems).toContain("Linux-only package manager or sudo");
    const wordy: TryIt = { setup: [], steps: [{ do: "curl x", expect: "x".repeat(200), kind: "command" }] };
    expect(tryItProblems(wordy).join("\n")).toContain('"you should see" is too long');
  });
});

describe("where the person tries it", () => {
  it("is a copy per functionality, inside plain_modules where the VM can run it", () => {
    expect(tryDirFor("/proj/plain_modules/app/code", "app", "3")).toBe("/proj/plain_modules/.plainwright/try/app/fs-3");
  });

  it("copies the code but not installed dependencies, caches or the build record", () => {
    const root = mkdtempSync(join(tmpdir(), "plainwright-try-"));
    const build = join(root, "plain_modules", "app", "code");
    for (const dir of ["src", ".venv/bin", "node_modules/x", "__pycache__"]) mkdirSync(join(build, dir), { recursive: true });
    writeFileSync(join(build, "src", "app.py"), "print('hi')\n");
    writeFileSync(join(build, ".plainwright.json"), "{}");
    const dest = tryDirFor(build, "app", "1");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "stale.txt"), "from last time");

    prepareTryDir(build, dest);

    expect(readdirSync(dest).sort()).toEqual(["src"]);
    expect(readFileSync(join(root, "plain_modules", ".plainwright", ".gitignore"), "utf8")).toBe("*\n");
    rmSync(root, { recursive: true, force: true });
  });
});
