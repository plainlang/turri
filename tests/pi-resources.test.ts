import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { subAgentResources } from "../src/pi.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "plainwright-resources-")));
  // A skill of the project's, where pi looks for one.
  mkdirSync(join(dir, ".pi", "skills", "deploy-it"), { recursive: true });
  writeFileSync(join(dir, ".pi", "skills", "deploy-it", "SKILL.md"), "---\nname: deploy-it\ndescription: Deploy the app to production.\n---\n\nDeploy it.\n");
  writeFileSync(join(dir, "AGENTS.md"), "This project deploys on Fridays.\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("what an agent plainwright starts is given of pi's resources", () => {
  it("is none of pi's skills and none of the project's context files - which pi would give the conversation", async () => {
    const pi = new DefaultResourceLoader({ cwd: dir, agentDir: getAgentDir(), noExtensions: true });
    await pi.reload();
    expect(pi.getSkills().skills.map((skill) => skill.name)).toContain("deploy-it");

    const agent = await subAgentResources(dir, false);
    expect(agent.getSkills().skills).toEqual([]);
    expect(JSON.stringify(agent.getAgentsFiles?.() ?? [])).not.toContain("deploys on Fridays");
  });
});
