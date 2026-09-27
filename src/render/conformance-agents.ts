import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ask, createExecutor } from "../pi.ts";
import { confinedTools } from "./confine.ts";
import type { ScriptRun } from "./test-scripts.ts";
import { createWebTools, WEB_TOOLS } from "./web.ts";
import { INTEGRITY_RULES, specPrimer } from "./prompt.ts";

/**
 * The agents a conformance run needs beside the one that writes the tests.
 *
 * The conformance tests are rendered apart from the code, in their own folder and VM, by an agent
 * that never sees the code. So before it starts, an explorer reads the code and writes down how
 * the built software is invoked from outside - what the test author works from. When the harness's
 * run of the suite fails, a judge reads both, against the spec, and says which is wrong: the code
 * goes to a coding agent, which works in the code folder and its VM, the tests go back to their
 * author.
 */

/** What the explorer, the judge and the coding agent are told the spec says. */
export interface SpecContext {
  moduleName: string;
  /** The spec, as its agents are shown it: the definitions, the reqs, the functional specs. */
  text: string;
}

/**
 * How the built software is invoked from outside, as an agent that explored the code writes it:
 * what the conformance tests' author - who never sees the code - works from.
 */
export async function exploreInvocation(options: {
  buildDir: string;
  spec: SpecContext;
  label: string;
  model?: string;
  onDelta?: (delta: string) => void;
}): Promise<string> {
  let invocation: string | undefined;
  const submit = defineTool({
    name: "submit_invocation",
    label: "Submit how to invoke it",
    description: "Hand back how the built software is invoked from outside. Call this exactly once, when you are done.",
    parameters: Type.Object({
      invocation: Type.String({ description: "How to invoke it, for someone who will never see the code" }),
    }),
    async execute(_id, params) {
      invocation = (params as { invocation: string }).invocation;
      return { content: [{ type: "text" as const, text: "Recorded." }], details: {}, terminate: true };
    },
  }) as ToolDefinition;
  // It reads the code - and runs it, to see - but changes nothing.
  const fence = confinedTools({ workdir: options.buildDir, read: [options.buildDir], write: [] });
  const session = await createExecutor({
    cwd: options.buildDir,
    customTools: [submit, ...fence.tools],
    tools: [...fence.names, "submit_invocation"],
    model: options.model,
    label: `${options.label} explorer`,
  });
  try {
    await ask(session, explorePrompt(options.buildDir, options.spec), options.onDelta);
    if (invocation === undefined) {
      await ask(session, "You have not called submit_invocation. Call it now with how the software is invoked.", options.onDelta);
    }
  } finally {
    session.dispose();
  }
  return invocation ?? "The explorer could not say how the software is invoked. Work it out from the files in the build and the test reqs.";
}

export function explorePrompt(buildDir: string, spec: SpecContext): string {
  return [
    specPrimer({ testReqs: true }),
    `You are exploring the built code of the \`${spec.moduleName}\` specification, in ${buildDir}.`,
    "",
    "Someone else will write its conformance tests: black-box tests that invoke the built software from the",
    "outside and check it does what the specification says. They will never see the code. Tell them how to",
    "invoke it - everything they need to reach it, and nothing about how it works inside:",
    "",
    "- what to install or build before it runs, and the command that starts or runs it;",
    "- its entry points: the executable and its arguments, the module and function to import, or the server,",
    "  where it listens and how to tell it is up;",
    "- how each thing the specification describes is reached: the command, the route and method, the call;",
    "- what it needs around it: environment variables, configuration, files, a database, and how to give it",
    "  a fresh one for each test;",
    "- where the files it reads and writes are, and anything else a test needs to set it up or clean up after it.",
    "",
    "Describe how to call it, not what it answers: what it returns in each case is for the tests to check",
    "against the specification, never to copy from the code. Read the code, and run it in your shell to be",
    "sure. Change nothing. When you are done, call submit_invocation once with the whole account.",
    "",
    "<specification>",
    spec.text.trim(),
    "</specification>",
  ].join("\n");
}

export type Culprit = "code" | "tests" | "spec";

/** A functionality, by the module it is in and its id there: a conflict can cross modules. */
export interface FunctionalityRef {
  module: string;
  frid: string;
}

/** "billing 4": a functionality as the judge and the person read it. */
export function refLabel(ref: FunctionalityRef): string {
  return `${ref.module} ${ref.frid}`;
}

export interface Verdict {
  culprit: Culprit;
  reason: string;
  /** For a spec conflict: the two functionalities that cannot both hold - in this module, or in one it requires. */
  functionalities?: FunctionalityRef[];
}

/**
 * Which functionalities a spec conflict may name: this module's, and those of the modules it
 * requires - its codebase holds them all, and so does its conformance suite. A functionality's
 * conformance run can only raise one with the functionality it tests - a conflict between two
 * earlier ones would have come up when the later of them was tested. A spec diff's run may name any two.
 */
export interface ConflictScope {
  functionalities: FunctionalityRef[];
  /** The functionality under test, which every conflict raised must include. None for a spec diff. */
  tested?: FunctionalityRef;
}

const same = (a: FunctionalityRef, b: FunctionalityRef) => a.module === b.module && a.frid === b.frid;

/** A conflict's functionalities as the judge gave them, tidied: trimmed, and each once. */
export function conflictRefs(given: Array<{ module?: string; id?: string; frid?: string }> | undefined): FunctionalityRef[] {
  const refs: FunctionalityRef[] = [];
  for (const item of given ?? []) {
    const ref = { module: (item.module ?? "").trim(), frid: (item.frid ?? item.id ?? "").trim() };
    if (ref.module !== "" && ref.frid !== "" && !refs.some((known) => same(known, ref))) refs.push(ref);
  }
  return refs;
}

/** Why a spec conflict cannot be raised as given, or nothing when it can. */
export function specConflictProblem(functionalities: FunctionalityRef[] | undefined, scope: ConflictScope): string | undefined {
  const refs = conflictRefs(functionalities);
  if (refs.length !== 2) {
    return `A spec conflict names exactly two functionalities, each by its module and id - it named ${refs.length === 0 ? "none" : refs.map(refLabel).join(", ")}.`;
  }
  const unknown = refs.filter((ref) => !scope.functionalities.some((known) => same(known, ref)));
  if (unknown.length > 0) {
    return `There is no functionality ${unknown.map(refLabel).join(" or ")}: the functionalities are ${scope.functionalities.map(refLabel).join(", ")}.`;
  }
  if (scope.tested !== undefined && !refs.some((ref) => same(ref, scope.tested!))) {
    return (
      `Only a conflict with functionality ${refLabel(scope.tested)}, the one under test, can be raised now. One between ` +
      `${refs.map(refLabel).join(" and ")} would have come up when the later of them was tested.`
    );
  }
  return undefined;
}

/** The two functionalities of a spec conflict, in a fixed order: the same conflict, however it was named. */
export function conflictKey(functionalities: FunctionalityRef[]): string {
  return sortedRefs(functionalities).map(refLabel).join(" & ");
}

export function sortedRefs(functionalities: FunctionalityRef[]): FunctionalityRef[] {
  return conflictRefs(functionalities).sort(
    (a, b) => a.module.localeCompare(b.module) || a.frid.localeCompare(b.frid, undefined, { numeric: true }),
  );
}

/** How many times a spec conflict between the same two functionalities is raised before it counts. */
export const SPEC_CONFLICT_RAISES = 3;

/** Which is wrong when the conformance suite fails - the code, the tests, or the spec itself - read against the spec. */
export async function judgeFailure(options: {
  buildDir: string;
  conformanceDir: string;
  spec: SpecContext;
  run: ScriptRun;
  invocation: string;
  scope: ConflictScope;
  /** The working notes, whose pitfalls hold the attempts made at this failure so far. */
  notes: string;
  label: string;
  model?: string;
  onDelta?: (delta: string) => void;
}): Promise<Verdict> {
  let verdict: Verdict | undefined;
  const submit = defineTool({
    name: "submit_verdict",
    label: "Submit verdict",
    description: "Say what is wrong - the code, the tests, or the specification itself - and why. Call this exactly once.",
    parameters: Type.Object({
      culprit: Type.Union([Type.Literal("code"), Type.Literal("tests"), Type.Literal("spec")], {
        description: "What has to change to meet the specification - or spec, when the specification cannot be met at all",
      }),
      reason: Type.String({ description: "Why, against the specification: which test, which behaviour, what the spec says" }),
      functionalities: Type.Optional(
        Type.Array(
          Type.Object({
            module: Type.String({ description: "The module the functionality is in" }),
            id: Type.String({ description: "Its id in that module" }),
          }),
          { description: 'For spec: the two functionalities that cannot both hold, e.g. [{"module": "billing", "id": "4"}, {"module": "accounts", "id": "1"}]' },
        ),
      ),
    }),
    async execute(_id, params) {
      const given = params as { culprit: Culprit; reason: string; functionalities?: Array<{ module: string; id: string }> };
      verdict = { culprit: given.culprit, reason: given.reason, ...(given.functionalities ? { functionalities: conflictRefs(given.functionalities) } : {}) };
      return { content: [{ type: "text" as const, text: "Recorded." }], details: {}, terminate: true };
    },
  }) as ToolDefinition;
  // It reads both, and changes neither.
  const fence = confinedTools({ workdir: options.conformanceDir, read: [options.buildDir, options.conformanceDir], write: [], noBash: true });
  const session = await createExecutor({
    cwd: options.conformanceDir,
    customTools: [submit, ...fence.tools],
    tools: [...fence.names, "submit_verdict"],
    model: options.model,
    label: `${options.label} judge`,
  });
  try {
    await ask(session, judgePrompt(options), options.onDelta);
    for (let again = 0; again < 2; again += 1) {
      if (verdict === undefined) {
        await ask(session, "You have not called submit_verdict. Call it now: code, tests or spec, and why.", options.onDelta);
        continue;
      }
      if (verdict.culprit !== "spec") break;
      const problem = specConflictProblem(verdict.functionalities, options.scope);
      if (problem === undefined) break;
      verdict = undefined;
      await ask(session, `That spec conflict cannot be raised: ${problem} Call submit_verdict again - code, tests, or a spec conflict that can be.`, options.onDelta);
    }
  } finally {
    session.dispose();
  }
  if (verdict?.culprit === "spec" && specConflictProblem(verdict.functionalities, options.scope) !== undefined) verdict = undefined;
  // No verdict is no evidence the code is wrong: the tests are the newer work, and looked at first.
  return verdict ?? { culprit: "tests", reason: "The judge gave no verdict that could be used; check the failing tests against the specification first." };
}

export function judgePrompt(options: {
  buildDir: string;
  conformanceDir: string;
  spec: SpecContext;
  run: ScriptRun;
  invocation: string;
  scope: ConflictScope;
  notes: string;
}): string {
  const tested = options.scope.tested;
  return [
    specPrimer({ testReqs: true }),
    `The conformance tests of the \`${options.spec.moduleName}\` specification failed. Decide what is wrong: the code, the tests, or the specification itself.`,
    "",
    `The code is in ${options.buildDir}; the conformance tests are in ${options.conformanceDir}. Read both.`,
    "",
    "The specification is the judge, never either of them:",
    "- tests: a test asserts something the specification does not say, misreads it, or reaches the software the",
    "  wrong way - a wrong command, route or setup (see <how to invoke it>).",
    "- code: the code does not do what the specification says, and the test checks exactly that.",
    "- spec: two functionalities of the specification cannot both hold - whatever the code does, one of them fails.",
    "  Only when the code and the tests both follow the specification, and the specification itself cannot be met.",
    "  They can be in different modules: this one's, and those of the modules it requires - each is listed with its",
    "  module. Name the two in `functionalities`, each by its module and id" +
      (tested !== undefined
        ? `. One of them must be ${refLabel(tested)}, the one under test: a conflict between two earlier ones would`
        : "."),
    ...(tested !== undefined ? ["  have come up when the later of them was tested."] : []),
    `  A spec conflict counts only once it has been raised ${SPEC_CONFLICT_RAISES} times, for the same two functionalities;`,
    "  until then it is recorded, and the tests are checked against the specification again.",
    "",
    "When the code and the tests could both be what is wrong, choose tests. When both are wrong, say which to fix",
    "first: the one that makes the failure you see. Then call submit_verdict once, with which and why - name the",
    "failing test, what it expected, what the specification says, and what the code does.",
    "",
    ...(options.notes !== ""
      ? [
          options.notes,
          "",
          "Earlier attempts at this failure are in the pitfalls, each stamped `conformance attempt <n>`: what was judged",
          "wrong, and what was done about it - which did not make the suite pass. Do not send it the way a failed",
          "attempt did unless you have a new reason; look at the other side.",
          "",
        ]
      : []),
    "<specification>",
    options.spec.text.trim(),
    "</specification>",
    "",
    `<how to invoke it>\n${options.invocation.trim()}\n</how to invoke it>`,
    "",
    `<failing run exit="${options.run.exitCode}" command="${options.run.command}">`,
    options.run.output.trimEnd(),
    "</failing run>",
  ].join("\n");
}

/**
 * The coding agent a conformance run sends the code to, when the judge says the code is wrong: it
 * works in the code folder and its VM, sees nothing of the tests, and keeps the unit tests passing.
 * Made the first time it is needed, and kept for the rest of the run.
 */
export async function createCodeFixer(options: {
  buildDir: string;
  label: string;
  model?: string;
  /** Its own tools beyond the file tools: running the unit tests, its notes. */
  tools: ToolDefinition[];
  toolNames: string[];
}): Promise<AgentSession> {
  const fence = confinedTools({ workdir: options.buildDir, read: [options.buildDir], write: [options.buildDir] });
  return createExecutor({
    cwd: options.buildDir,
    customTools: [...options.tools, ...createWebTools(), ...fence.tools],
    tools: [...fence.names, ...options.toolNames, ...WEB_TOOLS],
    model: options.model,
    label: `${options.label} coding agent`,
  });
}

export function codeFixPrompt(options: { buildDir: string; spec: SpecContext; run: ScriptRun; reason: string; first: boolean }): string {
  return [
    ...(options.first
      ? [
          specPrimer({ testReqs: false }),
          `You are the coding agent of the \`${options.spec.moduleName}\` specification. Its code is in ${options.buildDir}.`,
          "",
          "<specification>",
          options.spec.text.trim(),
          "</specification>",
          "",
        ]
      : []),
    `Its conformance tests failed, and the code is what is wrong (exit ${options.run.exitCode}):`,
    "",
    `<why the code>\n${options.reason.trim()}\n</why the code>`,
    "",
    `<failing run command="${options.run.command}">`,
    options.run.output.trimEnd(),
    "</failing run>",
    "",
    "Fix the code so it does what the specification says. The tests are not yours: you cannot see or change",
    "them, and they are not the judge - the specification is. Keep the unit tests passing: call",
    "run_unit_tests before you finish.",
    ...INTEGRITY_RULES,
  ].join("\n");
}

export function testsFixPrompt(options: { run: ScriptRun; reason: string }): string {
  return [
    `The harness ran the conformance testing script, \`${options.run.command}\`, on the whole suite, and it failed (exit ${options.run.exitCode}).`,
    "It was checked against the specification, and a test is what is wrong:",
    "",
    `<why the tests>\n${options.reason.trim()}\n</why the tests>`,
    "",
    "<failing run>",
    options.run.output.trimEnd(),
    "</failing run>",
    "",
    "Correct the test to what the specification says. Never change a test so it agrees with code that",
    "contradicts the specification, and never delete, skip or weaken a test to get a pass.",
    ...INTEGRITY_RULES,
  ].join("\n");
}
