import { describe, expect, it } from "vitest";
import { whyFailed } from "../../src/grow/diagnose-job.ts";
import type { Job } from "../../src/grow/jobs.ts";

const job = (overrides: Partial<Job>): Job =>
  ({
    id: "ab12",
    kind: "regenerate",
    summary: "app.plain Accounts",
    status: "succeeded",
    sequence: 1,
    queuedAt: 0,
    startedAt: 0,
    finishedAt: 60_000,
    waitingOn: [],
    tail: "",
    activity: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    agents: [],
    transcript: [],
    ...overrides,
  }) as Job;

describe("why a job failed", () => {
  it("is read from its transcript: what went wrong as it happened, the last failing test run, the last review, the tool calls that failed, and where the log is", () => {
    const text = whyFailed(
      job({
        report: "The spec change did not pass its unit tests.",
        logFile: "/p/plain_modules/.turri/jobs/ab12.log",
        transcript: [
          { kind: "stage", text: "app: running the unit testing script (attempt 1)" },
          { kind: "result", text: "run_unit_tests_python.sh exited 1\n\nFAILED test_app.py::test_signup - assert 400 == 201", agent: { label: "app spec change coding agent" } },
          { kind: "prompt", text: "The unit tests pass. A review of the work found where the code does not yet do what the specification says:\n1. test_app.py: bad" },
          { kind: "result", text: "write refused: .turri.json is the harness's record", error: true, agent: { label: "app spec change coding agent" } },
          { kind: "stage", text: "app: unit tests NOT passing - undoing the change" },
        ],
      }),
    );
    expect(text).toContain("The spec change did not pass its unit tests.");
    expect(text).toContain("- app: unit tests NOT passing - undoing the change");
    expect(text).not.toContain("- app: running the unit testing script");
    expect(text).toContain('<last failing test run by="app spec change coding agent">\nrun_unit_tests_python.sh exited 1');
    expect(text).toContain("assert 400 == 201");
    expect(text).toContain("<last review that sent the work back>\nThe unit tests pass. A review of the work found");
    expect(text).toContain("- app spec change coding agent: write refused");
    expect(text).toContain("The whole transcript: /p/plain_modules/.turri/jobs/ab12.log");
  });

  it("says a job that is still running has not ended", () => {
    expect(whyFailed(job({ status: "running" }))).toContain("It has not ended yet");
  });
});
