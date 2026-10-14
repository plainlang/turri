import { describe, expect, it } from "vitest";
import { supersededByTurri } from "../src/chat-skills.ts";

const turriRuns = new Set(["brood", "break-down-func-spec", "release-notes"]);

describe("the pi skills the conversation is not offered", () => {
  it("leaves out another tool's ***plain reference, which turri's rules already are", () => {
    const skill = {
      name: "load-plain-reference",
      description: "Loads the full ***plain language reference into context. Use whenever authoring, editing, reviewing, or debugging .plain files.",
    };
    expect(supersededByTurri(skill, turriRuns)).toBe(true);
  });

  it("leaves out a skill turri runs itself, by its name, whatever it says it is about", () => {
    expect(supersededByTurri({ name: "break-down-func-spec", description: "Break a spec that is too complex into smaller ones." }, turriRuns)).toBe(true);
    expect(supersededByTurri({ name: "release-notes", description: "Write the release notes." }, turriRuns)).toBe(true);
  });

  it("leaves out another tool's skills for ***plain specs and their testing scripts", () => {
    expect(supersededByTurri({ name: "forge-plain", description: "Turn an idea into a ***plain project." }, turriRuns)).toBe(true);
    expect(supersededByTurri({ name: "implement-testing-scripts", description: "Create testing scripts (run_unittests, run_conformance_tests) for a language." }, turriRuns)).toBe(true);
    expect(supersededByTurri({ name: "add-feature", description: "Add a feature as functional specs to a module." }, turriRuns)).toBe(true);
  });

  it("offers a skill about anything else, as pi offers it", () => {
    expect(supersededByTurri({ name: "commit-message", description: "Write a Conventional Commits message for the staged changes." }, turriRuns)).toBe(false);
    expect(supersededByTurri({ name: "explain-plaintext", description: "Explain a plain text file in simple words." }, turriRuns)).toBe(false);
  });
});
