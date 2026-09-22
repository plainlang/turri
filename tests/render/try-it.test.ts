import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tryDirFor } from "../../src/render/paths.ts";
import { checkTryIt, failedStepsPrompt, prepareTryDir, type TryIt } from "../../src/render/try-it.ts";

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
  const run = (_cwd: string, command: string) => {
    ran.push(command);
    return { exitCode: results[command] ?? 0, output: `ran ${command}` };
  };
  return { ran, run };
}

describe("checking the try-it steps", () => {
  it("runs setup and the commands that finish, never servers or manual steps", () => {
    const { ran, run } = fake({});
    const result = checkTryIt("/build", tryIt, run);
    expect(ran).toEqual(["make deps", "./app hello"]);
    expect(result.ok).toBe(true);
    expect(result.tryIt.steps[0]!.exitCode).toBe(0);
    expect(result.tryIt.steps[1]!.exitCode).toBeUndefined();
  });

  it("records a failing step", () => {
    const { run } = fake({ "./app hello": 2 });
    const result = checkTryIt("/build", tryIt, run);
    expect(result.ok).toBe(false);
    expect(result.tryIt.steps[0]!.exitCode).toBe(2);
    expect(failedStepsPrompt(result.tryIt, result.outputs)).toContain("$ ./app hello\nran ./app hello");
  });

  it("stops at a failing setup command", () => {
    const { ran, run } = fake({ "make deps": 1 });
    const result = checkTryIt("/build", tryIt, run);
    expect(ran).toEqual(["make deps"]);
    expect(result.ok).toBe(false);
    expect(result.tryIt.failedSetup).toEqual(["make deps"]);
  });
});

describe("where the person tries it", () => {
  it("is a copy per functionality, beside plain_modules", () => {
    expect(tryDirFor("/proj/plain_modules/app/code", "app", "3")).toBe("/proj/.plainwright/try/app/fs-3");
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
    expect(readFileSync(join(root, ".plainwright", ".gitignore"), "utf8")).toBe("*\n");
    rmSync(root, { recursive: true, force: true });
  });
});
