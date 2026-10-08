import { describe, expect, it } from "vitest";
import { JOB_FINISHED_REACTION, TURRI_IDENTITY } from "../src/extension.ts";

describe("what the chat is told it is", () => {
  it("knows a job is a pulse, and the job queue regen - whatever a project's files still call them", () => {
    expect(TURRI_IDENTITY).toContain("A pulse is one unit of work growing the code");
    expect(TURRI_IDENTITY).toContain("the job_id a tool takes is a pulse's id");
    expect(TURRI_IDENTITY).toContain("parallel-jobs and");
    expect(TURRI_IDENTITY).toContain("\"Job\" in what you read is a pulse; say pulse.");
    expect(TURRI_IDENTITY).toContain("It was the regeneration, the job queue, or the job panel.");
    expect(TURRI_IDENTITY).toContain("Say regen,");
    expect(TURRI_IDENTITY).toContain("mutate, in a skill's activity, is write_spec_diff");
  });
});

describe("what the chat is told to do when a pulse stops on its environment", () => {
  it("heals it before growing it again - the sandbox's by config, a missing tool found or installed with the person's yes - and never makes up a credential", () => {
    expect(JOB_FINISHED_REACTION).toContain("stops the same way again until that is fixed: never regrow it before");
    expect(JOB_FINISHED_REACTION).toContain("Add the folder its report names to\n  `toolchains:` in config.yaml");
    expect(JOB_FINISHED_REACTION).toContain("whether it is installed somewhere off the PATH");
    expect(JOB_FINISHED_REACTION).toContain("ask the person with ask_user");
    expect(JOB_FINISHED_REACTION).toContain("check that the command is found now");
    expect(JOB_FINISHED_REACTION).toContain("needs turri restarted");
    expect(JOB_FINISHED_REACTION).toContain("never make one up");
  });
});
