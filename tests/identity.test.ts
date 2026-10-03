import { describe, expect, it } from "vitest";
import { TURRI_IDENTITY } from "../src/extension.ts";

describe("what the chat is told it is", () => {
  it("knows a job is a pulse, and the job queue the regeneration - whatever a project's files still call them", () => {
    expect(TURRI_IDENTITY).toContain("A pulse is one unit of work growing the code");
    expect(TURRI_IDENTITY).toContain("the job_id a tool takes is a pulse's id");
    expect(TURRI_IDENTITY).toContain("parallel-jobs and");
    expect(TURRI_IDENTITY).toContain("\"Job\" in what you read is a pulse; say pulse.");
    expect(TURRI_IDENTITY).toContain("It was the job queue, or the job panel.");
    expect(TURRI_IDENTITY).toContain("mutate, in a skill's activity, is write_spec_diff");
  });
});
