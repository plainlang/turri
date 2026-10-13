import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMAND_OUTCOME, echoCommand, moduleNamedFirst, shownAfterCommand } from "../src/extension.ts";

function fakes(options: { appendFails?: boolean } = {}) {
  const notified: Array<{ text: string; level: string }> = [];
  const entries: Array<{ type: string; data: unknown }> = [];
  const sent: Array<{ message: { customType: string; content: string; display: boolean }; options: unknown }> = [];
  const pi = {
    appendEntry: (type: string, data: unknown) => {
      if (options.appendFails === true) throw new Error("no session");
      entries.push({ type, data });
    },
    sendMessage: async (message: never, sendOptions?: unknown) => void sent.push({ message, options: sendOptions }),
  } as unknown as ExtensionAPI;
  const ctx = { hasUI: true, ui: { notify: (text: string, level: string) => void notified.push({ text, level }) } } as unknown as ExtensionContext;
  return { pi, ctx, notified, entries, sent };
}

describe("what a slash command showed the person", () => {
  it("is kept in the chat and put in the conversation unseen, so the agent knows what they mean when they say fix it", () => {
    const { pi, ctx, notified, entries, sent } = fakes();
    shownAfterCommand(pi, ctx, "/regenerate d365_version_api", "d365_version_api.plain does not parse, so nothing can be regenerated from it yet: Plain syntax error", "error");
    expect(entries).toEqual([
      { type: COMMAND_OUTCOME, data: { command: "/regenerate d365_version_api", text: "d365_version_api.plain does not parse, so nothing can be regenerated from it yet: Plain syntax error", level: "error" } },
    ]);
    expect(notified).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message.customType).toBe(COMMAND_OUTCOME);
    expect(sent[0]!.message.display).toBe(false);
    expect(sent[0]!.message.content).toBe("The person ran /regenerate d365_version_api, and was shown:\nd365_version_api.plain does not parse, so nothing can be regenerated from it yet: Plain syntax error");
    expect(sent[0]!.options).toBeUndefined();
  });

  it("is shown for a moment when it cannot be kept, and still reaches the conversation", () => {
    const { pi, ctx, notified, sent } = fakes({ appendFails: true });
    shownAfterCommand(pi, ctx, "/halt activated api", "Halted api.", "info");
    expect(notified).toEqual([{ text: "Halted api.", level: "info" }]);
    expect(sent.map((entry) => entry.message.content)).toEqual(["The person ran /halt activated api, and was shown:\nHalted api."]);
  });
});

describe("a command the person typed", () => {
  it("is in the chat before the command goes on, given a frame to be drawn - and what it says after comes under it, the command not said again", async () => {
    const { pi, ctx, entries, sent } = fakes();
    const started = Date.now();
    await echoCommand(pi, "/regenerate d365_restore_api.plain");
    expect(Date.now() - started).toBeGreaterThanOrEqual(16);
    expect(entries).toEqual([{ type: COMMAND_OUTCOME, data: { command: "/regenerate d365_restore_api.plain" } }]);
    // The echo is for the person: the conversation hears what the command said, with the command.
    expect(sent).toEqual([]);
    shownAfterCommand(pi, ctx, "/regenerate d365_restore_api.plain", "Planning d365_restore_api's pulses…", "info", true);
    expect(entries[1]).toEqual({ type: COMMAND_OUTCOME, data: { command: "/regenerate d365_restore_api.plain", text: "Planning d365_restore_api's pulses…", level: "info", echoed: true } });
    expect(sent.map((entry) => entry.message.content)).toEqual(["The person ran /regenerate d365_restore_api.plain, and was shown:\nPlanning d365_restore_api's pulses…"]);
  });
});

describe("the module a /regenerate names", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "turri-module-named-")));
    writeFileSync(join(root, "d365_function_executor.plain"), "");
    writeFileSync(join(root, "app.plain"), "");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("is found when typed with spaces for its underscores, the words after it being the guidance", () => {
    expect(moduleNamedFirst(root, ["d365_function", "executor", "and", "add", "conformance"])).toEqual({
      named: join(root, "d365_function_executor.plain"),
      rest: ["and", "add", "conformance"],
    });
  });

  it("is found by its name or its file, as before", () => {
    expect(moduleNamedFirst(root, ["app", "models", "first"])).toEqual({ named: join(root, "app.plain"), rest: ["models", "first"] });
    expect(moduleNamedFirst(root, ["app.plain", "3"])).toEqual({ named: join(root, "app.plain"), rest: ["3"] });
  });

  it("is none when no first words name one, every word left for what follows", () => {
    expect(moduleNamedFirst(root, ["models", "first"])).toEqual({ rest: ["models", "first"] });
    expect(moduleNamedFirst(root, [])).toEqual({ rest: [] });
  });
});
