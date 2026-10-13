/**
 * Choosing a stack: `config.turri.<stack>.yaml` laid over `config.turri.yaml` for everything built from then on - a
 * backend's testing scripts, then a frontend's. `/stack` and the `stack` tool in the chat, `--stack <name>` on the
 * command line (cli.ts). The choice itself is kept in config.ts (`chooseStack`), for the session only.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { chooseStack, chosenStack, hasProjectConfig, stackConfigFile, stacksOf } from "./config.ts";

/** The words that choose no stack: the project's config alone. */
const NONE = ["none", "off", "base", "-"];

/** The stacks of the projects here: the folder's own, and those of the projects one folder down (specs kept in plain/). */
export function knownStacks(root: string): string[] {
  const below = (() => {
    try {
      return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "plain_modules")
        .map((entry) => join(root, entry.name))
        .filter(hasProjectConfig);
    } catch {
      return [];
    }
  })();
  return [...new Set([root, ...below].flatMap(stacksOf))].sort();
}

/** Choose `name` - or none - among the stacks here, and say what is chosen now; a stack the project has no file for is refused. */
export function switchStack(root: string, name: string | undefined): string {
  const stacks = knownStacks(root);
  const wanted = name?.trim() ?? "";
  if (wanted === "" || NONE.includes(wanted.toLowerCase())) {
    chooseStack(undefined);
    return "No stack chosen: everything is built with the project's config.turri.yaml alone, from now on.";
  }
  if (!stacks.includes(wanted)) {
    throw new Error(
      stacks.length > 0
        ? `There is no stack ${wanted} here. The stacks: ${stacks.join(", ")} - or none.`
        : `This project has no stacks: a stack is a ${stackConfigFile("<stack>")} beside config.turri.yaml.`,
    );
  }
  chooseStack(wanted);
  return `Stack ${wanted} chosen: everything is built with ${stackConfigFile(wanted)} over config.turri.yaml from now on - a pulse already running keeps the stack it started with.`;
}

/** /stack and the chat's stack tool. */
export function registerStacks(pi: ExtensionAPI, cwd: string): void {
  pi.registerCommand("stack", {
    description: "Choose the stack everything is built with - its config.turri.<stack>.yaml over config.turri.yaml: /stack [name | none]",
    getArgumentCompletions: (prefix: string) => {
      const items = [...knownStacks(cwd), "none"].filter((stack) => stack.startsWith(prefix)).map((stack) => ({ value: stack, label: stack }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      let name = args.trim();
      if (name === "") {
        const stacks = knownStacks(cwd);
        if (stacks.length === 0) return ctx.ui.notify(`This project has no stacks: a stack is a ${stackConfigFile("<stack>")} beside config.turri.yaml.`, "info");
        const now = chosenStack();
        const label = (stack: string) => `${stack}${stack === now ? "  (chosen now)" : ""}`;
        const none = `none - config.turri.yaml alone${now === undefined ? "  (chosen now)" : ""}`;
        const picked = await ctx.ui.select("Build with which stack?", [...stacks.map(label), none]);
        if (picked === undefined) return;
        name = picked === none ? "none" : (stacks.find((stack) => label(stack) === picked) ?? "");
      }
      try {
        ctx.ui.notify(switchStack(cwd, name), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerTool(
    defineTool({
      name: "stack",
      label: "Stack",
      description:
        "Choose the stack everything is built with from now on - the project's config.turri.yaml with the stack's " +
        "config.turri.<stack>.yaml over it: its testing scripts, toolchains, models - or none, the project's file alone. " +
        "For the session; a pulse already running keeps the stack it started with. Without a name, says the stacks and the one chosen.",
      promptSnippet: "choose the stack - its testing scripts and settings - that everything is built with",
      promptGuidelines: [
        "Switch the stack only when the user asks for it, or for work on a part of the project another stack builds - a backend's, a frontend's - and say which you chose.",
      ],
      parameters: Type.Object({
        name: Type.Optional(Type.String({ description: "The stack to choose, or none. Omitted: the stacks there are, and the one chosen" })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        if (params.name === undefined) {
          const stacks = knownStacks(cwd);
          const text = stacks.length > 0 ? `The stacks: ${stacks.join(", ")}. Chosen now: ${chosenStack() ?? "none"}.` : "This project has no stacks.";
          return { content: [{ type: "text" as const, text }], details: {} };
        }
        const text = switchStack(cwd, params.name);
        return { content: [{ type: "text" as const, text }], details: {} };
      },
    }),
  );
}
