import { describe, expect, it } from "vitest";
import { nodeVersionOk } from "../src/environment.ts";
import { defaultParallelJobs } from "../src/grow/jobs.ts";
import { sandboxSummary } from "../src/grow/os-sandbox.ts";

describe("the Node turri runs on", () => {
  it("is 22.19 or newer - it runs .ts files itself, and pi needs 22.19", () => {
    expect(nodeVersionOk("22.19.0")).toBe(true);
    expect(nodeVersionOk("22.18.0")).toBe(false);
    expect(nodeVersionOk("23.1.0")).toBe(true);
    expect(nodeVersionOk("26.8.2")).toBe(true);
    expect(nodeVersionOk("22.17.1")).toBe(false);
    expect(nodeVersionOk("20.19.0")).toBe(false);
  });
});

describe("where the agents' commands run, as the banner says it", () => {
  it("names the walls that are up, and where no OS sandbox starts, why - and turri doctor", () => {
    expect(sandboxSummary({ kind: "seatbelt" })).toEqual({ level: "ok", text: "agents' commands run on this machine behind the command check, Seatbelt and the audit" });
    expect(sandboxSummary({ kind: "none", why: "bubblewrap is not installed" })).toEqual({
      level: "limited",
      text: "agents' commands run on this machine behind the command check and the audit - no OS sandbox: bubblewrap is not installed (turri doctor)",
    });
  });
});

describe("how many pulses run at once when nothing says", () => {
  it("is half this machine's cores, at least one and at most four", () => {
    expect(defaultParallelJobs(1)).toBe(1);
    expect(defaultParallelJobs(2)).toBe(1);
    expect(defaultParallelJobs(6)).toBe(3);
    expect(defaultParallelJobs(16)).toBe(4);
  });
});
