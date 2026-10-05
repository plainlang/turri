import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeEnvironmentError, EnvironmentError, environmentErrorTool } from "../../src/grow/environment-error.ts";
import { createJobRegistry } from "../../src/grow/jobs.ts";

/**
 * When the machine lacks what the work needs, the pulse stops and is rolled back, the module's later pulses wait, and
 * the person is told what is missing, how to fix it, and how to run it again.
 */

const jdk = (source: "agent" | "harness") =>
  new EnvironmentError({ moduleName: "d365_version_api", missing: "JDK 21", neededBy: "`run_unittests.sh`", shownBy: "`/usr/libexec/java_home -v 21` found none", source });

describe("what the person is told", () => {
  it("says which module stopped, what the environment lacks, what needs it, how to fix it and how to run it again", () => {
    const error = jdk("harness");
    error.fix = "`brew install openjdk@21`";
    expect(describeEnvironmentError(error)).toBe(
      [
        "**d365_version_api stopped: the environment lacks JDK 21.**",
        "Needed by: `run_unittests.sh` (`/usr/libexec/java_home -v 21` found none).",
        "To fix: `brew install openjdk@21`",
        'Then re-run: `turri regrow d365_version_api.plain`, or say "resume" in the chat.',
      ].join("\n"),
    );
  });
});

describe("report_environment_error", () => {
  it("records what the agent says is missing, and ends its turn", async () => {
    const reports: unknown[] = [];
    const tool = environmentErrorTool((report) => reports.push(report)) as any;
    const result = await tool.execute("id", { missing: "the CUDA toolkit (nvcc)", needed_by: "torch's GPU build", shown_by: "nvcc: command not found" });
    expect(result.terminate).toBe(true);
    expect(reports).toEqual([{ missing: "the CUDA toolkit (nvcc)", neededBy: "torch's GPU build", shownBy: "nvcc: command not found" }]);
  });
});

describe("a pulse the environment stops", () => {
  it("is not run again, its agent's reason goes to the person as it is, and the module's later pulses wait - unrelated ones go on", async () => {
    let runs = 0;
    const diagnose = vi.fn(async () => "a diagnosis");
    const registry = createJobRegistry({ retries: 1, diagnose });
    const first = registry.start({ kind: "render", summary: "d365 fs 1", lanes: ["d365"], run: async () => ((runs += 1), Promise.reject(jdk("agent"))) });
    const later = registry.start({ kind: "render", summary: "d365 fs 2", lanes: ["d365"], run: async () => ({ report: "built" }) });
    const other = registry.start({ kind: "render", summary: "web fs 1", lanes: ["web"], run: async () => ({ report: "built" }) });

    const done = await registry.wait(first.id);
    expect(runs).toBe(1);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/^\*\*d365_version_api stopped: the environment lacks JDK 21\.\*\*/);
    expect(diagnose).not.toHaveBeenCalled();

    const waited = await registry.wait(later.id);
    expect(waited.status).toBe("failed");
    expect(waited.error).toMatch(/^Not run: pulse \S+ ahead of it in the queue \(d365 fs 1\) stopped, and this waits for it\.\n\n\*\*d365_version_api stopped/);
    expect((await registry.wait(other.id)).status).toBe("succeeded");
  });

  it("is worked out at once when the harness found it - not after a second failure", async () => {
    let runs = 0;
    const diagnose = vi.fn(async () => "To fix - in the environment:\n  1. brew install openjdk@21");
    const registry = createJobRegistry({ retries: 1, diagnose });
    const job = registry.start({ kind: "render", summary: "d365 fs 1", lanes: ["d365"], run: async () => ((runs += 1), Promise.reject(jdk("harness"))) });
    const done = await registry.wait(job.id);
    expect(runs).toBe(1);
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(done.error).toContain("**d365_version_api stopped: the environment lacks JDK 21.**");
    expect(done.error).toContain("brew install openjdk@21");
  });
});

describe("a credential agent-env names that is not there", () => {
  let project: string;
  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "turri-env-errors-")));
    mkdirSync(join(project, "plain_modules", "d365", "code"), { recursive: true });
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  it("stops the pulse before any agent starts", async () => {
    writeFileSync(join(project, "config.yaml"), "agent-env:\n  vars: [TURRI_TEST_NO_SUCH_SECRET]\n");
    let ran = false;
    const registry = createJobRegistry({ retries: 1, diagnose: async () => undefined });
    const job = registry.start({ kind: "render", summary: "d365 fs 1", lanes: [join(project, "plain_modules", "d365")], run: async () => ((ran = true), { report: "built" }) });
    const done = await registry.wait(job.id);
    expect(ran).toBe(false);
    expect(done.error).toContain("**d365 stopped: the environment lacks the credential `TURRI_TEST_NO_SUCH_SECRET`.**");
    expect(done.error).toContain("not set in the environment turri was started in");
  });
});
