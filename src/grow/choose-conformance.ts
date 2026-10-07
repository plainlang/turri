import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ask, BEGIN, createExecutor } from "../pi.ts";
import { reportActivity } from "./activity.ts";
import type { TouchedSpec } from "./drift.ts";

/**
 * Under `conformance-tests: chosen`, which functional specs get conformance tests is the chat model's to choose - told
 * what each code job adds or changes that none is for, it calls bind for those worth it. With no conversation - `turri
 * regrow` - this agent chooses in its place, on the same model (`harness-model`) and asked the same question: it reads
 * the module's spec and names the ones worth black-box tests, and why. Those are bound as bind binds them.
 */

export interface ConformanceChoice {
  frids: string[];
  why: string;
}

/** What the chooser is asked: the module's spec, and the functional specs to choose from. */
export function choicePrompt(plainFile: string, specs: TouchedSpec[], spec: string, budget?: number): string {
  return [
    `You choose which functional specs of the ***plain module \`${basename(plainFile)}\` get black-box conformance tests.`,
    "conformance-tests: chosen - the conformance tests are for the functional specs chosen. These are built, or are being",
    "built, and no conformance test is for them or scheduled:",
    ...specs.map((touched) => `- fs ${touched.frid}: ${touched.text}`),
    "",
    `Decide which of them black-box conformance tests are worth it for - what a user or a client of ${basename(plainFile)} relies on,`,
    "not an internal detail its unit tests already cover - and say why. The rest stay without. A functional spec with",
    "acceptance tests always has them: it is not among these. Choosing none is an answer too.",
    ...(budget !== undefined
      ? [`Choose at most ${budget} - the module's conformance budget: rank them by what a client of the module relies on most, and say why the ones you choose come before the rest.`]
      : []),
    "",
    "Call choose_conformance once, with the numbers of those you choose and why.",
    "",
    `<spec file="${basename(plainFile)}">`,
    spec.trimEnd(),
    "</spec>",
  ].join("\n");
}

/** Ask the chooser, on `model`. Nothing chosen when it does not answer, or answers with numbers not offered. */
export async function chooseConformance(options: { plainFile: string; specs: TouchedSpec[]; model?: string; budget?: number }): Promise<ConformanceChoice> {
  let answer: ConformanceChoice | undefined;
  const offered = new Set(options.specs.map((touched) => touched.frid));
  const tool = defineTool({
    name: "choose_conformance",
    label: "Choose the conformance tests",
    description: "The functional specs, by number, that get black-box conformance tests - none, some or all of those offered - and why.",
    parameters: Type.Object({
      frids: Type.Array(Type.String({ description: 'A functional spec\'s number, as offered - e.g. "2" or "3.1"' })),
      why: Type.String({ description: "Why these, and why not the rest" }),
    }),
    async execute(_id, params) {
      const { frids, why } = params as ConformanceChoice;
      const unknown = frids.filter((frid) => !offered.has(frid));
      if (options.budget !== undefined && new Set(frids).size > options.budget) {
        return { content: [{ type: "text" as const, text: `Not recorded: the module's conformance budget allows ${options.budget}, and you chose ${new Set(frids).size}. Choose the ${options.budget} that matter most, and call it again.` }], details: {} };
      }
      if (unknown.length > 0) {
        return { content: [{ type: "text" as const, text: `Not offered: fs ${unknown.join(", ")}. Choose from ${[...offered].join(", ")}, and call it again.` }], details: {} };
      }
      answer = { frids: [...new Set(frids)], why };
      return { content: [{ type: "text" as const, text: "Recorded." }], details: {}, terminate: true };
    },
  }) as ToolDefinition;
  const session = await createExecutor({
    cwd: dirname(options.plainFile),
    customTools: [tool],
    tools: [tool.name],
    model: options.model,
    label: `${basename(options.plainFile, ".plain")} conformance chooser`,
    role: "chooser",
    task: choicePrompt(options.plainFile, options.specs, readFileSync(options.plainFile, "utf8"), options.budget),
    budget: { calls: 3, finish: [tool.name] },
  });
  try {
    await ask(session, BEGIN);
    if (answer === undefined) await ask(session, "You did not call choose_conformance. Call it now.");
  } finally {
    session.dispose();
  }
  if (answer === undefined) {
    reportActivity(`  the conformance chooser gave no answer for ${basename(options.plainFile)}: none chosen`);
    return { frids: [], why: "the chooser gave no answer" };
  }
  return answer;
}
