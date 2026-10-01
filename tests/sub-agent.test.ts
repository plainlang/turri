import { describe, expect, it } from "vitest";
import { createExecutor } from "../src/pi.ts";

/**
 * A sub-agent is built from exactly what it needs. With turri installed globally, pi
 * would otherwise load a second copy of it into every render agent - tools, hooks and a
 * 160,000-character rules block included - bound to a session thrown away minutes later.
 */
describe("sub-agent sessions", () => {
  it("load no extensions, and no rules unless asked", async () => {
    const session = await createExecutor({ cwd: process.cwd(), customTools: [], tools: ["read"] });
    try {
      const loader = (session as unknown as { resourceLoader: { getExtensions(): { extensions: unknown[] } } })
        .resourceLoader;
      expect(loader.getExtensions().extensions).toHaveLength(0);
      expect(session.systemPrompt).not.toContain("***plain");
    } finally {
      session.dispose();
    }
  });

  it("carry the ***plain rules when they work on specs", async () => {
    const session = await createExecutor({ cwd: process.cwd(), customTools: [], tools: ["read"], rules: true });
    try {
      expect(session.systemPrompt).toContain("***plain");
    } finally {
      session.dispose();
    }
  });
});
