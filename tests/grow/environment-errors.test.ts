import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkAgainstScript, describeEnvironmentError, EnvironmentError, environmentErrorTool } from "../../src/grow/environment-error.ts";
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

describe("how to run it again", () => {
  it("names the spec the person ran, when the pulse knows it - not the module's own name", async () => {
    const registry = createJobRegistry({ retries: 1, diagnose: async () => undefined });
    const job = registry.start({
      kind: "regrow",
      summary: "app.plain fs 1",
      lanes: ["d365"],
      rerun: "turri regrow specs/app.plain",
      run: async () => Promise.reject(jdk("agent")),
    });
    const done = await registry.wait(job.id);
    expect(done.error).toContain('Then re-run: `turri regrow specs/app.plain`, or say "resume" in the chat.');
    expect(done.error).not.toContain("d365_version_api.plain");
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
  const mockito = { missing: "Mockito agent attachment capability", needed_by: "mvn test", shown_by: "Could not initialize plugin: interface org.mockito.plugins.MockMaker" };
  const script = "/project/test_scripts/run_unittests.sh";

  it("does not stand when the harness's own run of the testing script passes - as a sandboxed mvn test's Mockito failure did not - and the agent goes on", async () => {
    const reports: unknown[] = [];
    const runs: number[] = [];
    const check = checkAgainstScript(async () => (runs.push(1), { exitCode: 0, output: "BUILD SUCCESS" }), script);
    const tool = environmentErrorTool((report) => reports.push(report), check) as any;
    for (let n = 0; n < 2; n += 1) {
      const result = await tool.execute("id", mockito);
      expect(result.terminate).toBeUndefined();
      expect(result.content[0].text).toContain("the harness ran the project's testing script, run_unittests.sh, on this machine itself, and it passed");
    }
    expect(runs).toHaveLength(2);
    expect(reports).toEqual([]);
  });

  it("stands when the harness's own run cannot find its toolchain", async () => {
    const reports: unknown[] = [];
    const check = checkAgainstScript(async () => ({ exitCode: 127, output: "run_unittests.sh: line 3: mvn: command not found" }), script);
    const result = await (environmentErrorTool((report) => reports.push(report), check) as any).execute("id", { missing: "Maven", needed_by: "mvn test" });
    expect(result.terminate).toBe(true);
    expect(reports).toEqual([{ missing: "Maven", neededBy: "mvn test" }]);
  });

  it("shows the agent the harness's run once when it fails for another reason, and stands when the agent reports again", async () => {
    const reports: unknown[] = [];
    const check = checkAgainstScript(async () => ({ exitCode: 1, output: "Tests run: 3, Failures: 1\nexpected 200 but was 500" }), script);
    const tool = environmentErrorTool((report) => reports.push(report), check) as any;
    const first = await tool.execute("id", mockito);
    expect(first.terminate).toBeUndefined();
    expect(first.content[0].text).toMatch(/exited 1, but not for want of a toolchain[\s\S]*expected 200 but was 500/);
    expect(reports).toEqual([]);
    const again = await tool.execute("id", mockito);
    expect(again.terminate).toBe(true);
    expect(reports).toHaveLength(1);
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
    // A check only reads: no home or temporary folder is made for it.
    expect(existsSync(join(project, "plain_modules", ".turri"))).toBe(false);
  });
});

describe("the whole conformance suite, when its script cannot find its toolchain", () => {
  let project: string;
  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "turri-env-regression-")));
    mkdirSync(join(project, "plain_modules", "app", "code"), { recursive: true });
    mkdirSync(join(project, "plain_modules", "app", "tests"), { recursive: true });
    writeFileSync(join(project, "plain_modules", "app", "tests", "test_app.py"), "def test(): pass\n");
    writeFileSync(join(project, "run_conformance_tests.sh"), "#!/bin/bash\necho 'line 2: flutter: command not found'\nexit 127\n");
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  it("stops the pulse at once - no repair agent is started to work around it", async () => {
    const { ensureRegressionPasses } = await import("../../src/grow/regression.ts");
    const stopped = await ensureRegressionPasses({
      buildDir: join(project, "plain_modules", "app", "code"),
      conformanceRoot: join(project, "plain_modules"),
      moduleName: "app",
      frids: ["1"],
      tree: {} as never,
      required: [],
      scripts: { conformance: join(project, "run_conformance_tests.sh") },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(stopped).toBeInstanceOf(EnvironmentError);
    expect(describeEnvironmentError(stopped as EnvironmentError)).toContain("**app stopped: the environment lacks `flutter`.**");
  });
});
