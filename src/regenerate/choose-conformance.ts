import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ask, BEGIN, createExecutor } from "../pi.ts";
import { reportActivity } from "./activity.ts";
import type { TouchedSpec } from "./drift.ts";

/**
 * Which functional specs get conformance tests, under `conformance-tests: chosen` or `module`, is this agent's to choose -
 * in the chat and on the command line alike, on the chooser's model. Under chosen it is asked as each code pulse ends,
 * of what that pulse regenerated; under module once, when the whole module is regenerated, and it plans the conformance
 * pulses too. It reads the module's spec and names the ones worth black-box tests, and why. Being asked inside the pulse,
 * the choice is made before anything can be built on the module: nothing has to be stopped for it.
 */

export interface ConformanceChoice {
  frids: string[];
  why: string;
  /** Under module: the conformance pulses, each the functional specs it tests together. */
  groups?: string[][];
}

/** What the chooser is asked: the module's spec, and the functional specs to choose from. */
export function choicePrompt(plainFile: string, specs: TouchedSpec[], spec: string, budget?: number, when: "pulse" | "module" = "pulse"): string {
  return [
    `You choose which functional specs of the ***plain module \`${basename(plainFile)}\` get black-box conformance tests.`,
    when === "module"
      ? "conformance-tests: module - the whole module is regenerated now, and these of its functional specs are built and no conformance test is for them or scheduled:"
      : "conformance-tests: chosen - a code pulse has just regenerated these, and no conformance test is for them or scheduled:",
    ...specs.map((touched) => `- fs ${touched.frid}: ${touched.text}`),
    "",
    `Decide which of them black-box conformance tests are worth it for - what a user or a client of ${basename(plainFile)} relies on,`,
    "not an internal detail its unit tests already cover - and say why. The rest stay without. A functional spec with",
    "acceptance tests always has them: it is not among these. Choosing none is an answer too.",
    ...(budget !== undefined
      ? [`Choose at most ${budget} - the module's conformance budget: rank them by what a client of the module relies on most, and say why the ones you choose come before the rest.`]
      : []),
    ...(when === "module"
      ? [
          "",
          "Plan them too: in groups, each a conformance pulse - the functional specs a client exercises together in one, those",
          "that share nothing apart. Every one you choose is in one group.",
        ]
      : []),
    "",
    `Call choose_conformance once, with the numbers of those you choose${when === "module" ? ", the groups" : ""} and why.`,
    "",
    `<spec file="${basename(plainFile)}">`,
    spec.trimEnd(),
    "</spec>",
  ].join("\n");
}

/** Ask the chooser, on `model`. Nothing chosen when it does not answer, or answers with numbers not offered. */
export async function chooseConformance(options: { plainFile: string; specs: TouchedSpec[]; model?: string; budget?: number; when?: "pulse" | "module" }): Promise<ConformanceChoice> {
  const planning = options.when === "module";
  let answer: ConformanceChoice | undefined;
  const offered = new Set(options.specs.map((touched) => touched.frid));
  const tool = defineTool({
    name: "choose_conformance",
    label: "Choose the conformance tests",
    description: "The functional specs, by number, that get black-box conformance tests - none, some or all of those offered - and why.",
    parameters: Type.Object({
      frids: Type.Array(Type.String({ description: 'A functional spec\'s number, as offered - e.g. "2" or "3.1"' })),
      why: Type.String({ description: "Why these, and why not the rest" }),
      ...(planning ? { groups: Type.Array(Type.Array(Type.String()), { description: "The conformance pulses: each the numbers of the functional specs it tests together - every one chosen in one" }) } : {}),
    }),
    async execute(_id, params) {
      const { frids, why, groups } = params as ConformanceChoice;
      if (planning && groups !== undefined) {
        const grouped = groups.flat();
        const outside = grouped.filter((frid) => !frids.includes(frid));
        const left = frids.filter((frid) => !grouped.includes(frid));
        if (outside.length > 0 || left.length > 0 || new Set(grouped).size !== grouped.length) {
          return { content: [{ type: "text" as const, text: `Not recorded: every one chosen is in exactly one group, and nothing else is${outside.length > 0 ? ` - fs ${outside.join(", ")} grouped, not chosen` : ""}${left.length > 0 ? ` - fs ${left.join(", ")} chosen, in no group` : ""}. Call it again.` }], details: {} };
        }
      }
      const unknown = frids.filter((frid) => !offered.has(frid));
      if (options.budget !== undefined && new Set(frids).size > options.budget) {
        return { content: [{ type: "text" as const, text: `Not recorded: the module's conformance budget allows ${options.budget}, and you chose ${new Set(frids).size}. Choose the ${options.budget} that matter most, and call it again.` }], details: {} };
      }
      if (unknown.length > 0) {
        return { content: [{ type: "text" as const, text: `Not offered: fs ${unknown.join(", ")}. Choose from ${[...offered].join(", ")}, and call it again.` }], details: {} };
      }
      answer = { frids: [...new Set(frids)], why, ...(planning && groups !== undefined && groups.length > 0 ? { groups: groups.filter((group) => group.length > 0) } : {}) };
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
    task: choicePrompt(options.plainFile, options.specs, readFileSync(options.plainFile, "utf8"), options.budget, options.when),
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

/**
 * The work loop's chooser, the chat's and the command line's alike: asked as a pulse ends, it asks chooseConformance on
 * the harness model. A functional spec passed over is not offered again for the same text - only once it changes.
 */
export function conformanceChooser(options: { model: () => string | undefined; dryRun?: boolean }) {
  const offered = new Set<string>();
  return async (plainFile: string, specs: TouchedSpec[], budget: number | undefined, when: "pulse" | "module"): Promise<ConformanceChoice | undefined> => {
    const fresh = specs.filter((touched) => !offered.has(`${plainFile}\n${touched.frid}\n${touched.text}`));
    if (fresh.length === 0 || options.dryRun === true) return undefined;
    for (const touched of fresh) offered.add(`${plainFile}\n${touched.frid}\n${touched.text}`);
    try {
      const model = options.model();
      return await chooseConformance({ plainFile, specs: fresh, when, ...(model !== undefined ? { model } : {}), ...(budget !== undefined ? { budget } : {}) });
    } catch (error) {
      reportActivity(`  choosing the conformance tests of ${basename(plainFile)} failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };
}
