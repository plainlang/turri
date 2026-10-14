import { describe, expect, it } from "vitest";
import { JOB_FINISHED_REACTION } from "../src/extension.ts";
import { TURRI_IDENTITY } from "../src/identity.ts";

describe("what the chat is told it is", () => {
  it("knows a job is a pulse, and the job queue regen - whatever a project's files still call them", () => {
    expect(TURRI_IDENTITY).toContain("A pulse is one unit of work regenerating the code");
    expect(TURRI_IDENTITY).toContain("the job_id a tool takes is a pulse's id");
    expect(TURRI_IDENTITY).toContain("parallel-jobs and");
    expect(TURRI_IDENTITY).toContain("\"Job\" in what you read is a pulse; say pulse.");
    expect(TURRI_IDENTITY).toContain("It was the regeneration, the job queue, or the job panel.");
    expect(TURRI_IDENTITY).toContain("Say regen,");
    expect(TURRI_IDENTITY).toContain("mutate, in a skill's activity, is write_spec_diff");
  });

  it("is turri itself, speaking in the first person, never of turri as someone else to pass a message to", () => {
    expect(TURRI_IDENTITY).toContain("you regenerate the code from it");
    expect(TURRI_IDENTITY).toContain("Speak as turri, in the first person");
    expect(TURRI_IDENTITY).toContain("never tell the person to tell or ask turri something");
    expect(TURRI_IDENTITY).not.toContain("turri regenerates");
    expect(TURRI_IDENTITY).not.toContain("Speak of yourself as turri");
  });

  it("introduces itself as a coding agent with the power of regenerative software, that helps write ***plain and regenerates the code from it", () => {
    expect(TURRI_IDENTITY).toContain("You are turri - always lowercase - a coding agent with the power of regenerative software.");
    expect(TURRI_IDENTITY).toContain("you help them write ***plain and regenerate the code from it");
    expect(TURRI_IDENTITY).toContain("write the name escaped, \\*\\*\\*plain");
    expect(TURRI_IDENTITY).not.toContain("regenerative software harness");
  });

  it("tells its name as the likeness between the immortal jellyfish and regenerative software", () => {
    expect(TURRI_IDENTITY).toContain("Regenerative software works the same way - the ***plain is the genes");
    expect(TURRI_IDENTITY).toContain("Say it as that likeness, not as a fact about a");
  });

  it("says regenerate for what it does to the code - never grow - and reads an older text's grow as regenerate", () => {
    expect(TURRI_IDENTITY).toContain("Regenerate is the word for what you do to the code: never grow, grew or grown");
    expect(TURRI_IDENTITY.replace(/never grow, grew or grown/, "")).not.toMatch(/\bgr[eo]w/i);
  });
});

describe("what the chat is told to do when a pulse stops on its environment", () => {
  it("heals it before regenerating it again - the sandbox's by config, a missing tool found or installed with the person's yes - and never makes up a credential", () => {
    expect(JOB_FINISHED_REACTION).toContain("stops the same way again until that is fixed: never regenerate it before");
    expect(JOB_FINISHED_REACTION).toContain("Add the folder its report\n  names to `toolchains:` in config.turri.yaml");
    // A refused write is no folder to add: never toolchains:, never resumed before the fix.
    expect(JOB_FINISHED_REACTION).toContain("kept the agents from writing a file");
    expect(JOB_FINISHED_REACTION).toContain("never add it there, and never resume before the fix");
    expect(JOB_FINISHED_REACTION).toContain("whether it is installed somewhere off the PATH");
    expect(JOB_FINISHED_REACTION).toContain("ask the person with ask_user");
    expect(JOB_FINISHED_REACTION).toContain("check that the command is found now");
    expect(JOB_FINISHED_REACTION).toContain("needs turri restarted");
    expect(JOB_FINISHED_REACTION).toContain("never make one up");
  });
});
