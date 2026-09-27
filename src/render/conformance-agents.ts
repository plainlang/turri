import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ask, createExecutor } from "../pi.ts";
import { confinedTools } from "./confine.ts";
import { reportActivity } from "./activity.ts";
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
 * What an explorer hands the author of the conformance tests - who never sees the code, and is given
 * only this: how the software is built and run, how each functionality is reached from outside,
 * what it needs around it, and a plan for the tests.
 */
export interface Exploration {
  buildAndRun: string;
  /**
   * How the conformance tests, run by the project's conformance testing script, reach it: what the
   * script builds or installs and where, the coordinates, paths or classes the tests depend on or
   * start, and whether they start it themselves.
   */
  testsReachIt: string;
  interfaces: Array<{ module: string; frid: string; how: string }>;
  environment: string;
  plan: Array<{ module: string; frid: string; tests: string }>;
  other?: string;
}

/** An exploration as the test author, and the judge, read it. */
export function explorationText(exploration: Exploration, replies: string[] = []): string {
  const sections = [
    `## How to build and run it\n\n${exploration.buildAndRun.trim()}`,
    `## How the conformance tests reach it, run by the testing script\n\n${exploration.testsReachIt.trim()}`,
    `## How each functionality is reached\n\n${exploration.interfaces.map((item) => `### ${item.module} ${item.frid}\n\n${item.how.trim()}`).join("\n\n")}`,
    `## What it needs around it\n\n${exploration.environment.trim()}`,
    `## Plan for the conformance tests\n\n${exploration.plan.map((item) => `### ${item.module} ${item.frid}\n\n${item.tests.trim()}`).join("\n\n")}`,
    ...(exploration.other?.trim() ? [`## Anything else\n\n${exploration.other.trim()}`] : []),
    // An account it could not complete is passed on with what it wrote, so nothing it found is lost.
    ...(replies.length > 0 ? [`## What the explorer wrote as it worked\n\n${replies.map((reply) => reply.trim()).join("\n\n")}`] : []),
  ];
  return sections.join("\n\n");
}

/**
 * What an exploration lacks for the conformance tests to be written from it alone, or nothing when
 * it is whole: how to build and run it, and - for every functionality the tests are for - how it
 * is reached and what to test.
 */
/** How long an exploration may be: the interface, not the code. Longer is sent back to be cut down. */
export const MAX_EXPLORATION_CHARS = 12_000;

/** How many times the explorer may hand an exploration over: each ends its turn, and is checked. */
export const EXPLORATION_SUBMISSIONS = 3;

export function explorationProblems(exploration: Exploration | undefined, scope: ConflictScope, moduleName: string): string[] {
  if (exploration === undefined) return ["You have not called submit_exploration."];
  const problems: string[] = [];
  const size = explorationText(exploration).length;
  if (size > MAX_EXPLORATION_CHARS) {
    problems.push(
      `It is ${size} characters - keep it under ${MAX_EXPLORATION_CHARS}. Hand over the interface, not the code: the routes, ` +
        "commands, fields and their types, and the setup - no code listings, no files pasted whole.",
    );
  }
  const unknown = [...exploration.interfaces, ...exploration.plan].filter(
    (item) => item.frid !== "" && !scope.functionalities.some((ref) => ref.module === item.module && ref.frid === item.frid),
  );
  if (unknown.length > 0 && scope.tested === undefined) {
    const names = [...new Set(unknown.map((item) => `${item.module} ${item.frid}`))];
    problems.push(
      `${names.join(", ")} ${names.length === 1 ? "is not a functionality" : "are not functionalities"}: give module and id as ` +
        `the specification numbers them - ${scope.functionalities.filter((ref) => ref.module === moduleName).map(refLabel).join(", ") || "none yet"}.`,
    );
  }
  const short = (text: string | undefined) => (text ?? "").trim().length < 40;
  if (short(exploration.buildAndRun)) problems.push("build_and_run says too little: what to install and build, the exact command that starts or runs it, where it listens and how to tell it is up.");
  if (short(exploration.testsReachIt)) {
    problems.push(
      "tests_reach_it says too little: read the conformance testing script - what it builds or installs, and where - and say exactly " +
        "how the tests it runs reach the software: the coordinates, paths or classes they depend on or start (a Maven groupId, " +
        "artifactId and version, a main class, a jar path, an import), and whether they start it themselves and how.",
    );
  }
  if (short(exploration.environment)) problems.push("environment says too little: every variable, configuration file, service, database and fixture it needs, and how each test gets a fresh one - or say plainly it needs none.");
  const reached = exploration.interfaces.filter((item) => !short(item.how));
  const planned = exploration.plan.filter((item) => !short(item.tests));
  if (scope.tested !== undefined) {
    // A functionality's run: the one under test, reached and planned for.
    const tested = scope.tested;
    const has = (list: Array<{ module: string; frid: string }>) => list.some((item) => item.module === tested.module && item.frid === tested.frid);
    if (!has(reached)) problems.push(`interfaces does not say how ${refLabel(tested)} is reached: the command and its arguments, or the route, method, headers and the request and response fields.`);
    if (!has(planned)) problems.push(`plan has no tests for ${refLabel(tested)}: the cases to write, how each is set up and invoked, and what it checks as the specification says.`);
  } else {
    // A spec change's: what it touches is for the explorer to say, but some of this module has to be reached and planned.
    if (!reached.some((item) => item.module === moduleName)) problems.push(`interfaces says nothing of how \`${moduleName}\`'s functionalities the change touches are reached - one entry each.`);
    if (!planned.some((item) => item.module === moduleName)) problems.push(`plan has no tests for \`${moduleName}\`: the cases the change adds, changes or removes, for each functionality it touches.`);
  }
  return problems;
}

/**
 * How the built software is invoked from outside, and a plan for its conformance tests, as an agent
 * that explored the code writes it - everything the tests' author, who never sees the code, works
 * from. Checked before it is used: it has to cover every functionality the tests are for, and is sent
 * back until it does. What the explorer wrote in its replies goes with an account it never completed.
 */
export async function exploreInvocation(options: {
  buildDir: string;
  spec: SpecContext;
  /** The functionalities of the codebase, and the one under test - none for a spec change. */
  scope: ConflictScope;
  /** The project's conformance testing script: how the tests are built and run, and so how they reach the software. */
  testingScripts?: Array<{ path: string; runs: string; content: string }>;
  /**
   * Asked again: the tests written from the last account keep failing the same way, most likely for
   * something they need of the software that it left out. The failing run, as the harness saw it.
   */
  question?: { failure: string; account: string };
  label: string;
  model?: string;
  onDelta?: (delta: string) => void;
}): Promise<string> {
  let exploration: Exploration | undefined;
  let submissions = 0;
  const target = options.scope.tested;
  const ref = {
    module: Type.Optional(Type.String({ description: "The module the functionality is in" })),
    id: Type.Optional(
      Type.String({
        description:
          target !== undefined
            ? `The functionality's id as the specification numbers it, e.g. "${target.frid}" - leave both out for ${refLabel(target)}, the one under test`
            : 'The functionality\'s id as the specification numbers it, e.g. "3" - never a name of your own',
      }),
    ),
  };
  /** An entry's functionality: as given when it is one, otherwise - in a functionality's run - the one under test. */
  const owner = (item: { module?: string; id?: string }): { module: string; frid: string } => {
    const given = { module: (item.module ?? "").trim() || options.spec.moduleName, frid: (item.id ?? "").trim() };
    const known = options.scope.functionalities.some((known) => known.module === given.module && known.frid === given.frid);
    return known || target === undefined ? given : { ...target };
  };
  const submit = defineTool({
    name: "submit_exploration",
    label: "Submit the exploration",
    description:
      "Hand over everything the author of the conformance tests needs - they see nothing but this, not the code and not your " +
      "replies. Call it once you are done; call it again to replace what you handed over.",
    parameters: Type.Object({
      build_and_run: Type.String({
        description: "What to install and build, the exact command that starts or runs it, where it listens and how to tell it is up",
      }),
      tests_reach_it: Type.String({
        description:
          "How the conformance tests, run by the conformance testing script, reach it: what the script builds or installs and where, the " +
          "coordinates, paths or classes the tests depend on or start (e.g. a Maven groupId:artifactId:version and the main class), and " +
          "whether the tests start it themselves and how",
      }),
      interfaces: Type.Array(
        Type.Object({
          ...ref,
          how: Type.String({
            description:
              "How this functionality is reached from outside: the command and its arguments, or the route, method and headers, and the request and response fields and their types",
          }),
        }),
      ),
      environment: Type.String({
        description: "What it needs around it: environment variables, configuration, services, databases, files, fixtures - and how each test gets a fresh one",
      }),
      plan: Type.Array(
        Type.Object({
          ...ref,
          tests: Type.String({
            description:
              "The conformance tests to write for it, from the specification and its acceptance tests: each case, how it is set up and invoked, what it checks as the specification says, and where its files go as the test reqs say",
          }),
        }),
      ),
      other: Type.Optional(Type.String({ description: "Anything else a test author who never sees the code needs" })),
    }),
    async execute(_id, params) {
      const given = params as {
        build_and_run: string;
        tests_reach_it: string;
        interfaces: Array<{ module?: string; id?: string; how: string }>;
        environment: string;
        plan: Array<{ module?: string; id?: string; tests: string }>;
        other?: string;
      };
      submissions += 1;
      exploration = {
        buildAndRun: given.build_and_run,
        testsReachIt: given.tests_reach_it ?? "",
        interfaces: given.interfaces.map((item) => ({ ...owner(item), how: item.how })),
        environment: given.environment,
        plan: given.plan.map((item) => ({ ...owner(item), tests: item.tests })),
        other: given.other,
      };
      // Every hand-over ends the turn and is checked: the harness says what is missing, a few times at most.
      return { content: [{ type: "text" as const, text: "Recorded." }], details: {}, terminate: true };
    },
  }) as ToolDefinition;
  // It reads the code - and runs it, to see - but changes nothing.
  const fence = confinedTools({ workdir: options.buildDir, read: [options.buildDir], write: [] });
  const session = await createExecutor({
    cwd: options.buildDir,
    customTools: [submit, ...fence.tools],
    tools: [...fence.names, "submit_exploration"],
    model: options.model,
    label: `${options.label} explorer`,
    system: fence.note,
  });
  const replies: string[] = [];
  try {
    replies.push(await ask(session, explorePrompt(options.buildDir, options.spec, options.scope, options.testingScripts, options.question), options.onDelta));
    for (let again = 0; again < EXPLORATION_SUBMISSIONS; again += 1) {
      const problems = explorationProblems(exploration, options.scope, options.spec.moduleName);
      if (problems.length === 0 || submissions >= EXPLORATION_SUBMISSIONS) break;
      reportActivity(`  the exploration is not complete yet: ${problems[0]!.slice(0, 120)}`);
      replies.push(
        await ask(
          session,
          `What you handed over is not complete - the test author gets nothing else:\n- ${problems.join("\n- ")}\n\nCall submit_exploration with the whole of it: everything you found, not a summary.`,
          options.onDelta,
        ),
      );
    }
  } finally {
    session.dispose();
  }
  const complete = explorationProblems(exploration, options.scope, options.spec.moduleName).length === 0;
  const found = replies.filter((reply) => reply.trim() !== "");
  if (exploration === undefined) {
    return found.length > 0
      ? `The explorer did not hand over a complete account. What it wrote as it worked:\n\n${found.join("\n\n")}`
      : "The explorer could not say how the software is invoked. Work it out from the test reqs and the files in the build.";
  }
  return explorationText(exploration, complete ? [] : found);
}

export function explorePrompt(
  buildDir: string,
  spec: SpecContext,
  scope: ConflictScope,
  testingScripts?: Array<{ path: string; runs: string; content: string }>,
  question?: { failure: string; account: string },
): string {
  const target =
    scope.tested !== undefined
      ? `functionality ${refLabel(scope.tested)}`
      : `the spec change - every functionality of \`${spec.moduleName}\` it can reach`;
  return [
    specPrimer({ testReqs: true }),
    `You are exploring the built code of the \`${spec.moduleName}\` specification, in ${buildDir}, for the conformance tests of ${target}.`,
    "",
    "Someone else will write those tests: black-box tests that invoke the built software from the outside and",
    "check it does what the specification says. They will never see the code, and they will not see your",
    "replies: what you hand over with submit_exploration is all they get. So hand over everything they need of",
    `it - in full, but only what they need: the interface to ${target}, not the codebase. Be focused: find its`,
    "entry point and what it needs around it; do not survey everything else. Describe the routes, commands,",
    `fields and their types in words - no code listings, no files pasted whole, under ${MAX_EXPLORATION_CHARS} characters in all. In its parts:`,
    "",
    "- build_and_run: what to install and build, the exact command that starts or runs it, where it listens",
    "  and how to tell it is up;",
    "- tests_reach_it: how the conformance tests reach it, run as the conformance testing script below runs",
    "  them. Read the script: what it builds or installs, and where, before the tests run; then say exactly what",
    "  the tests depend on or start - a Maven groupId, artifactId and version, the main class, a jar path, an",
    "  import - and whether they start the software themselves, and how. Copy names, coordinates and versions",
    "  from the build file itself (pom.xml, package.json, pyproject.toml, go.mod...), and name the file: never",
    "  infer them from a folder or module name. A test that cannot reach the software tests nothing, so this is",
    "  the part that matters most;",
    `- interfaces: for ${target} - and any other functionality its tests need to set up state - how it is`,
    "  reached from outside: the command and its arguments, or the route, method and headers, and the fields",
    "  of its request and response and their types, as the code takes them;",
    "- environment: environment variables, configuration, services and databases it talks to, files and",
    "  fixtures - and how each test gets a fresh one;",
    `- plan: the conformance tests to write for ${target}, from the specification and its acceptance tests:`,
    "  each case, how it is set up and invoked, what it checks as the specification says, and where the files",
    "  go as the test reqs say.",
    "",
    "Describe how to call it, never what it answers: what it returns in each case is for the tests to check",
    "against the specification, not to copy from the code - so the plan's expectations come from the",
    "specification, and the code only tells you how to reach it. Read the code, and run it in your shell to be",
    "sure. Change nothing. Then call submit_exploration - once, with the whole of it: it ends your turn, and",
    `you are told if anything is missing. You can hand it over ${EXPLORATION_SUBMISSIONS} times at most.`,
    "",
    "<specification>",
    spec.text.trim(),
    "</specification>",
    ...(testingScripts !== undefined && testingScripts.length > 0
      ? [
          "",
          "This is the project's conformance testing script, which the harness runs on this machine to decide whether the",
          "tests pass - read it for what it builds or installs before the tests run, and so what the tests can depend on:",
          ...testingScripts.flatMap((script) => ["", `<script path="${script.path}" run-as="${script.runs}">`, script.content.trimEnd(), "</script>"]),
        ]
      : []),
    ...(question !== undefined
      ? [
          "",
          "You are asked again. The conformance tests were written from your last account, and they keep failing the",
          "same way - most likely for something they need of the software that the account left out: how they reach",
          "it, what to depend on or start, what it needs around it. Look at the code again for exactly that, and hand",
          "over the whole account again, with what was missing.",
          "",
          `<your last account>\n${question.account.trim()}\n</your last account>`,
          "",
          `<the failure that keeps coming back>\n${question.failure.trimEnd()}\n</the failure that keeps coming back>`,
        ]
      : []),
  ].join("\n");
}

/**
 * A failing run's whole output, read by an agent and summed up for whoever has to fix it - when the
 * output was too long to be shown whole. The start and the end of a long output say that it failed;
 * why is often in the middle. The summarizer reads all of it, and hands over what failed, the
 * errors, the stack traces and logs that matter, and where to look - erring on the side of too much.
 * It reads the log, and the code and the tests - read only - to find where the failure comes from.
 * Its summary goes to the conformance agent too, which never sees the code: so it points at the
 * code by file and line, and never pastes it.
 */
export async function summarizeFailure(options: {
  run: ScriptRun;
  /** The folder the whole output is in. */
  logsDir: string;
  /** The code and the tests, read only, to find where the failure comes from. */
  buildDir: string;
  conformanceDir: string;
  label: string;
  model?: string;
  onDelta?: (delta: string) => void;
}): Promise<string | undefined> {
  if (options.run.log === undefined) return undefined;
  let summary: string | undefined;
  const failure = Type.Object({
    test: Type.String({ description: "The failing test's name, as the output names it" }),
    file: Type.Optional(Type.String({ description: "The test's file, when the output says it" })),
    error: Type.String({ description: "The exact error or assertion message" }),
    stack_trace: Type.Optional(Type.String({ description: "The part of the stack trace that matters, down to where it started - never cut the lines that say where" })),
    context: Type.Optional(Type.String({ description: "Everything else needed to fix it: the root cause chain (Caused by:), log lines, requests, what came before" })),
    hint: Type.Optional(Type.String({ description: "Where to look, and what most likely caused it" })),
  });
  const submit = defineTool({
    name: "submit_summary",
    label: "Submit the summary",
    description: "Hand over the summary of the failing run. Call this once, when you are done.",
    parameters: Type.Object({
      summary: Type.String({ description: "What failed and why, in full: how many tests failed, which passed, the errors, and the most likely causes" }),
      failures: Type.Array(failure),
    }),
    async execute(_id, params) {
      const given = params as { summary: string; failures: Array<{ test: string; file?: string; error: string; stack_trace?: string; context?: string; hint?: string }> };
      summary = [
        given.summary.trim(),
        ...given.failures.map((item) =>
          [
            `### ${item.test}${item.file ? ` (${item.file})` : ""}`,
            `error: ${item.error.trim()}`,
            ...(item.stack_trace?.trim() ? [`stack trace:\n${item.stack_trace.trim()}`] : []),
            ...(item.context?.trim() ? [`context:\n${item.context.trim()}`] : []),
            ...(item.hint?.trim() ? [`where to look: ${item.hint.trim()}`] : []),
          ].join("\n"),
        ),
      ].join("\n\n");
      return { content: [{ type: "text" as const, text: "Recorded." }], details: {}, terminate: true };
    },
  }) as ToolDefinition;
  const fence = confinedTools({ workdir: options.logsDir, read: [options.logsDir, options.buildDir, options.conformanceDir], write: [], noBash: true });
  const session = await createExecutor({
    cwd: options.logsDir,
    customTools: [submit, ...fence.tools],
    tools: [...fence.names, "submit_summary"],
    model: options.model,
    label: `${options.label} failure summarizer`,
    system: fence.note,
  });
  try {
    await ask(session, summarizePrompt(options.run, options.buildDir, options.conformanceDir), options.onDelta);
    if (summary === undefined) await ask(session, "You have not called submit_summary. Call it now with the summary.", options.onDelta);
  } catch {
    // A summary is a help: without one, the output as it is shown still goes to whoever fixes it.
  } finally {
    session.dispose();
  }
  return summary;
}

export function summarizePrompt(run: ScriptRun, buildDir: string, conformanceDir: string): string {
  return [
    `The project's testing script, \`${run.command}\`, failed (exit ${run.exitCode}). Its output was too long to be shown`,
    `whole; all of it is in ${run.log}. Read all of it - with grep for the errors, then read around them - and sum up`,
    "what failed and why, for the agent that has to fix it. That agent sees your summary and a cut of the output",
    "whose start and end only say that it failed, so everything it needs to fix it has to be in your summary:",
    "",
    "- how many tests failed and which passed, or that none ran - and why not, when the build or the start failed;",
    "- for each failure: the test, its file, the exact error, the part of the stack trace that says where it",
    "  started, and every line of context it takes to fix it - the whole 'Caused by:' chain, the log lines around",
    "  it, the requests and responses;",
    "- the most likely cause, and where to look.",
    "",
    "When a massive dump - JSON, HTML, base64 - is in the way, keep the part that matters and say what the rest",
    "was. Otherwise prefer completeness to brevity: if unsure whether a line matters, include it.",
    "",
    `To find where a failure comes from, read the code (${buildDir}) and the tests (${conformanceDir}) as well - read`,
    "only. Say where it is by file, line and name: the class that has no bean, the test that asserts it. Never paste",
    "the code's implementation into the summary: it also goes to the author of the tests, who must not see the code -",
    "the test's own lines you may quote. Then call submit_summary once.",
  ].join("\n");
}

/** What the review found wrong with the tests: which file and test, whether something is missing or bad, and exactly what. */
export interface ReviewProblem {
  file: string;
  test?: string;
  kind: "missing" | "bad";
  what: string;
}

/**
 * The review gate, after the conformance suite and the unit tests pass: do the tests this run added
 * or changed test the software black box, and do the acceptance tests do what the spec says - every
 * step, every expectation. Passing tests prove nothing when they assert nothing, mock the software
 * they test, or skip what the spec asks for. It reads the tests and the code and changes neither.
 * No verdict is no pass: a gate that cannot say yes stays shut.
 */
export async function reviewTests(options: {
  buildDir: string;
  conformanceDir: string;
  spec: SpecContext;
  /** The test files this run added or changed, relative to the tests folder. */
  changed: string[];
  /** The functionality under test - or, for a spec change, those it touches - with their acceptance tests. */
  functionalities: Array<{ frid: string; acceptanceTests: string[] }>;
  forChange?: boolean;
  invocation: string;
  label: string;
  model?: string;
  onDelta?: (delta: string) => void;
}): Promise<{ pass: boolean; problems: ReviewProblem[] }> {
  let verdict: { pass: boolean; problems: ReviewProblem[] } | undefined;
  const submit = defineTool({
    name: "submit_review",
    label: "Submit the review",
    description: "Say whether the tests pass the review, and if not, every problem with them. Call this once, when you are done.",
    parameters: Type.Object({
      pass: Type.Boolean({ description: "True only when nothing is missing and nothing is bad" }),
      problems: Type.Array(
        Type.Object({
          file: Type.String({ description: "The test file, relative to the tests folder" }),
          test: Type.Optional(Type.String({ description: "The test in it, when it is one test" })),
          kind: Type.Union([Type.Literal("missing"), Type.Literal("bad")]),
          what: Type.String({ description: "Exactly what is missing or bad, and what the specification says instead" }),
        }),
      ),
    }),
    async execute(_id, params) {
      const given = params as { pass: boolean; problems: ReviewProblem[] };
      // A pass with problems, or a fail with none, is not a verdict.
      if (given.pass === given.problems.length > 0) {
        return {
          content: [{ type: "text" as const, text: given.pass ? "A pass lists no problems - either drop them or fail it." : "A fail has to say what is wrong: list every problem." }],
          details: {},
        };
      }
      verdict = given;
      return { content: [{ type: "text" as const, text: "Recorded." }], details: {}, terminate: true };
    },
  }) as ToolDefinition;
  const fence = confinedTools({ workdir: options.conformanceDir, read: [options.conformanceDir, options.buildDir], write: [], noBash: true });
  const session = await createExecutor({
    cwd: options.conformanceDir,
    customTools: [submit, ...fence.tools],
    tools: [...fence.names, "submit_review"],
    model: options.model,
    label: `${options.label} test reviewer`,
    system: fence.note,
  });
  try {
    await ask(session, reviewPrompt(options), options.onDelta);
    if (verdict === undefined) await ask(session, "You have not called submit_review. Call it now: pass, or every problem.", options.onDelta);
  } finally {
    session.dispose();
  }
  return (
    verdict ?? {
      pass: false,
      problems: [{ file: "(all)", kind: "bad", what: "The review gave no verdict. Check every test you added or changed against the rules above yourself." }],
    }
  );
}

export function reviewPrompt(options: {
  buildDir: string;
  conformanceDir: string;
  spec: SpecContext;
  changed: string[];
  functionalities: Array<{ frid: string; acceptanceTests: string[] }>;
  forChange?: boolean;
  invocation: string;
}): string {
  const withAcceptance = options.functionalities.filter((item) => item.acceptanceTests.length > 0);
  const whose = options.forChange
    ? `the functionalities the change touches (${options.functionalities.map((item) => item.frid).join(", ") || "none"})`
    : `functionality ${options.functionalities[0]?.frid ?? ""}`;
  return [
    specPrimer({ testReqs: true }),
    `The conformance tests of the \`${options.spec.moduleName}\` specification pass - and the unit tests with them. Before that counts,`,
    "review the tests this run added or changed. Passing tests prove nothing when they assert nothing, mock the software",
    "they test, or leave out what the specification asks for.",
    "",
    `The tests are in ${options.conformanceDir}; the code is in ${options.buildDir}. Read both; change neither.`,
    "",
    "<tests added or changed>",
    options.changed.join("\n"),
    "</tests added or changed>",
    "",
    "Check every one of them:",
    "- Black box: it reaches the software only the way the test reqs have it - its API, its command, its public",
    "  classes where the test reqs say so - and never mocks, stubs or replaces any part of the software under test:",
    "  no mocked beans, services or clients of its own. A real external service the test reqs say not to mock is",
    "  not mocked either.",
    "- It tests something: every test asserts what the specification says, and fails when that does not hold. No",
    "  placeholder, no `assertTrue(true)`, no empty or skipped test, no failure caught and swallowed, no assertion",
    "  so loose any answer passes.",
    ...(withAcceptance.length > 0
      ? [
          `- The acceptance tests of ${whose}, each implemented as a test of its own, doing every step it lists, in`,
          "  order, with what it names, and asserting every expectation it states. A step left out, replaced by a",
          "  stand-in, or said to be impossible to run is missing, not done:",
          "",
          ...withAcceptance.flatMap((item) =>
            item.acceptanceTests.map((test, index) => `<acceptance test ${index + 1} of functionality ${item.frid}>\n${test.trim()}\n</acceptance test>`),
          ),
          "",
        ]
      : []),
    `- The conformance tests cover what the specification says ${options.forChange ? "the change does" : `functionality ${options.functionalities[0]?.frid ?? ""} does`} - its behaviour, its`,
    "  edge cases, its errors - each checked against the specification, not against what the code happens to do.",
    "",
    "Then call submit_review once: pass when nothing is missing and nothing is bad; otherwise every problem - the",
    "file, the test, missing or bad, and exactly what, with what the specification says instead. Be specific: the",
    "agent that fixes them gets your list and nothing else.",
    "",
    "<specification>",
    options.spec.text.trim(),
    "</specification>",
    "",
    `<how to invoke it>\n${options.invocation.trim()}\n</how to invoke it>`,
  ].join("\n");
}

/** The review's problems, for the conformance agent to fix. */
export function reviewFeedbackPrompt(problems: ReviewProblem[]): string {
  return [
    "The conformance suite and the unit tests pass, but the tests did not pass review. Each problem, exactly:",
    "",
    ...problems.map((problem) => `- ${problem.kind === "missing" ? "MISSING" : "BAD"} · ${problem.file}${problem.test ? ` · ${problem.test}` : ""}: ${problem.what.trim()}`),
    "",
    "Fix every one: implement what is missing, and make what is bad test the software black box and as the",
    "specification says. Then run the suite. Never mock the software under test or loosen a test to pass.",
    ...INTEGRITY_RULES,
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
    system: fence.note,
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
    "  Only what the specification says counts: anything it leaves open - a name, coordinates, a version, a path,",
    "  a package, a port, a file layout - is what the code already has. The tests follow it, and it is never",
    "  code - changing the code to fit a test's guess moves what every other test points at.",
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
    ...(options.run.summary !== undefined
      ? ["", "An agent that read the whole of that output summed up what failed and why:", "", `<summary of the failure>\n${options.run.summary.trim()}\n</summary of the failure>`]
      : []),
  ].join("\n");
}

/**
 * The coding agent a conformance run sends the code to, when the judge says the code is wrong: it
 * works in the code folder and its VM, sees nothing of the tests, and keeps the unit tests passing.
 * Made the first time it is needed, and kept for the rest of the run.
 */
export async function createCodeFixer(options: {
  buildDir: string;
  /** Where the full outputs of the test runs are: it reads them, and writes nothing there. */
  logsDir?: string;
  label: string;
  model?: string;
  /** Its own tools beyond the file tools: running the unit tests, its notes. */
  tools: ToolDefinition[];
  toolNames: string[];
}): Promise<AgentSession> {
  const fence = confinedTools({
    workdir: options.buildDir,
    read: [options.buildDir, ...(options.logsDir !== undefined ? [options.logsDir] : [])],
    write: [options.buildDir],
  });
  return createExecutor({
    cwd: options.buildDir,
    customTools: [...options.tools, ...createWebTools(), ...fence.tools],
    tools: [...fence.names, ...options.toolNames, ...WEB_TOOLS],
    model: options.model,
    label: `${options.label} coding agent`,
    system: fence.note,
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
    ...(options.run.summary !== undefined
      ? ["", "An agent that read the whole of that output summed up what failed and why:", "", `<summary of the failure>\n${options.run.summary.trim()}\n</summary of the failure>`]
      : []),
    "",
    "Reproduce it first, and check your fix the same way: run_conformance_tests runs the project's conformance testing",
    "script on the code as it now is with the whole suite - you cannot see the tests, but you get their output. Make",
    "the failure show in your own unit tests too where you can - for a Spring app that will not start, a unit test that",
    "starts its application context - so run_unit_tests catches it from now on.",
    "",
    "Fix the code so it does what the specification says. The tests are not yours: you cannot see or change",
    "them, and they are not the judge - the specification is. Keep the unit tests passing: call",
    "run_unit_tests before you finish.",
    "Keep the build's identity as it is - its name, coordinates, version, package and main class - unless the",
    "specification asks for another: the tests and other builds point at them. Leave in your notes what holds about",
    "the code for the next agent, not an account of this fix: the harness records the attempts itself.",
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
    ...(options.run.summary !== undefined
      ? ["", "An agent that read the whole of that output summed up what failed and why:", "", `<summary of the failure>\n${options.run.summary.trim()}\n</summary of the failure>`]
      : []),
    "",
    "Correct the test to what the specification says. Never change a test so it agrees with code that",
    "contradicts the specification, and never delete, skip or weaken a test to get a pass.",
    ...INTEGRITY_RULES,
  ].join("\n");
}
