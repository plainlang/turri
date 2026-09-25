import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { subAgentResources } from "../src/pi.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plainwright-context-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("an agent plainwright starts", () => {
  it("is given no AGENTS.md or CLAUDE.md - not the project's, not one above it - only what plainwright gives it", async () => {
    writeFileSync(join(root, "AGENTS.md"), "The project's own instructions: the CRM talks to HubSpot through...\n");
    writeFileSync(join(root, "CLAUDE.md"), "More of them.\n");
    const code = join(root, "plain", "plain_modules", "hubspot", "code");
    mkdirSync(code, { recursive: true });

    const loader = await subAgentResources(code, true);
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
    // The ***plain rules are still what it is given.
    expect(loader.getAppendSystemPrompt().join("\n")).toContain("<plain-rules");
  });
});
