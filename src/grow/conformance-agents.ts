import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ask, BEGIN, createExecutor } from "../pi.ts";
import { confinedTools } from "./confine.ts";
import { createServiceTools } from "./services.ts";
import { workspaceBlock } from "./workspace.ts";
import { reportActivity } from "./activity.ts";
import type { ScriptRun } from "./test-scripts.ts";
import { createWebTools, WEB_TOOLS } from "./web.ts";
import { diffFiles, digestFiles } from "./codebase.ts";
import { ERROR_CAUSE_RULES, fixMethod, INTEGRITY_RULES, specPrimer } from "./prompt.ts";
import { conformanceReviewCasesBlock } from "./cases.ts";
import type { JobCases } from "./drift.ts";
import { REVIEW_LESSON } from "./notes.ts";
import { CODER_COMPACTION, REVIEWER_COMPACTION } from "./compaction.ts";
import { SUBMIT_AFTER_REVIEW } from "./submit-work.ts";

/**
 * The agents a conformance run needs beside the one that writes the tests.
 *
 * The conformance tests are rendered apart from the code, in their own folder, by an agent
 * that may read the code but writes only tests. Before it starts, an explorer reads the code and
 * writes down how the built software is invoked from outside. When the harness's run of the suite
 * fails, a judge reads both, against the spec, and says which is wrong: the code goes to a coding
 * agent, which works in the code folder and may read the tests, the tests go back to
 * their author.
 */

/** What the explorer, the judge and the coding agent are told the spec says. */
export interface SpecContext {
  moduleName: string;
  /** The spec, as its agents are shown it: the definitions, the reqs, the functional specs. */
  text: string;
}

/**
 * What an explorer hands the author of the conformance tests: how the software is built and run, how each functionality is reached from outside,
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
/**
 * How many tool calls the agents with one thing to decide may make before they are told to decide:
 * the explorer its account, the reviewer its review, the judge its verdict. Past twice that, the turn
 * is stopped. A judge that reads 40 files has read enough; one that has not decided by then is going
 * round in a circle.
 */
export const EXPLORER_CALLS = 40;
export const REVIEWER_CALLS = 40;
export const JUDGE_CALLS = 30;

/** How long an exploration may be: the interface, not the code. Longer is sent back to be cut down. */
export const MAX_EXPLORATION_CHARS = 12_000;

/** How many times the explorer may hand an exploration over: each ends its turn, and is checked. */
export const EXPLORATION_SUBMISSIONS = 3;

export function explorationProblems(
  exploration: Exploration | undefined,
  scope: ConflictScope,
  moduleName: string,
  /** The functionalities whose acceptance tests the plan has to carry out, and how many each has. */
  acceptance: Array<{ module: string; frid: string; count: number }> = [],
): string[] {
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
        "how the tests it runs reach the software: the package, module, entry point, path or address they depend on or start, " +
        "with its exact name and version, and whether they start it themselves and how.",
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
  // Every acceptance test is carried out, step by step, from outside: a plan that leaves one out
  // leaves its author to write a placeholder.
  for (const item of acceptance) {
    const text = exploration.plan
      .filter((entry) => entry.module === item.module && entry.frid === item.frid)
      .map((entry) => entry.tests)
      .join("\n");
    const named = new Set([...text.matchAll(/acceptance test\s*(\d+)/gi)].map((match) => Number(match[1])));
    const missing = Array.from({ length: item.count }, (_, index) => index + 1).filter((n) => !named.has(n));
    if (missing.length > 0) {
      problems.push(
        `plan does not carry out ${missing.map((n) => `acceptance test ${n}`).join(", ")} of ${item.module} ${item.frid}: name each ` +
          '"acceptance test N" as the specification numbers them, and say how each of its steps is done from outside - through ' +
          "which endpoint, or which class and method where the test reqs let the tests call a component directly - with what, " +
          "and what it asserts. A long acceptance test is planned whole, never cut down.",
      );
    }
  }
  return problems;
}

/**
 * How the built software is invoked from outside, and a plan for its conformance tests, as an agent
 * that explored the code writes it - everything the tests' author works
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
  /** The functionalities whose acceptance tests the plan has to carry out, and how many each has. */
  acceptance?: Array<{ module: string; frid: string; count: number }>;
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
      "Hand over everything the author of the conformance tests needs - they do not see your replies, only this. Call it once you are done; call it again to replace what you handed over.",
    parameters: Type.Object({
      build_and_run: Type.String({
        description: "What to install and build, the exact command that starts or runs it, where it listens and how to tell it is up",
      }),
      tests_reach_it: Type.String({
        description:
          "How the conformance tests, run by the conformance testing script, reach it: what the script builds or installs and where, the " +
          "package, module, entry point, path or address the tests depend on or start, with its exact name and version, and " +
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
              "The conformance tests to write for it, from the specification and its acceptance tests: each case, how it is set up and invoked, what it checks as the specification says, and where its files go as the test reqs say - and every acceptance test, named \"acceptance test N\", with how each of its steps is done from outside and what it asserts",
          }),
        }),
      ),
      other: Type.Optional(Type.String({ description: "Anything else the test author needs" })),
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
  const services = createServiceTools({ dir: options.buildDir, read: [options.buildDir], write: [] });
  const session = await createExecutor({
    cwd: options.buildDir,
    customTools: [submit, ...services.tools, ...fence.tools],
    tools: [...fence.names, ...services.names, "submit_exploration"],
    model: options.model,
    label: `${options.label} explorer`,
    system: fence.note,
    task: explorePrompt(options.buildDir, options.spec, options.scope, options.testingScripts, options.question),
    budget: { calls: EXPLORER_CALLS, finish: ["submit_exploration"] },
  });
  const replies: string[] = [];
  try {
    replies.push(await ask(session, BEGIN, options.onDelta));
    for (let again = 0; again < EXPLORATION_SUBMISSIONS; again += 1) {
      const problems = explorationProblems(exploration, options.scope, options.spec.moduleName, options.acceptance);
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
    await services.stopAll();
  }
  const complete = explorationProblems(exploration, options.scope, options.spec.moduleName, options.acceptance).length === 0;
  const found = replies.filter((reply) => reply.trim() !== "");
  if (exploration === undefined) {
    return found.length > 0
      ? `The explorer did not hand over a complete account. What it wrote as it worked:\n\n${found.join("\n\n")}`
      : "The explorer could not say how the software is invoked. Work it out from the test reqs and the files in the build.";
  }
  return explorationText(exploration, complete ? [] : found);
}

/** How many questions the test author may put to the explorer in one conformance run, and how long an answer may be. */
export const EXPLORER_QUESTIONS = 3;
const ANSWER_CALLS = 20;
const MAX_ANSWER_CHARS = 4_000;

/**
 * The test author's question to the explorer, answered: a fresh explorer, in the code's folder - it reads the
 * code and runs it, and changes nothing - given what was handed over so far and the question, answering in words.
 */
export async function answerAsExplorer(options: {
  buildDir: string;
  spec: SpecContext;
  /** What the explorer handed over: the account the tests are written from. */
  account: string;
  question: string;
  label: string;
  model?: string;
  onDelta?: (delta: string) => void;
}): Promise<string> {
  let answer: string | undefined;
  const submit = defineTool({
    name: "submit_answer",
    label: "Submit the answer",
    description: "Hand the answer to the test author. Call this once.",
    parameters: Type.Object({ answer: Type.String({ description: `The answer, in words, with the exact names - under ${MAX_ANSWER_CHARS} characters` }) }),
    async execute(_id, params) {
      answer = (params as { answer: string }).answer;
      return { content: [{ type: "text" as const, text: "Recorded." }], details: {}, terminate: true };
    },
  }) as ToolDefinition;
  const fence = confinedTools({ workdir: options.buildDir, read: [options.buildDir], write: [] });
  const services = createServiceTools({ dir: options.buildDir, read: [options.buildDir], write: [] });
  const session = await createExecutor({
    cwd: options.buildDir,
    customTools: [submit, ...services.tools, ...fence.tools],
    tools: [...fence.names, ...services.names, "submit_answer"],
    model: options.model,
    label: `${options.label} explorer`,
    system: fence.note,
    task: [
      `You explored the built code of the \`${options.spec.moduleName}\` specification, in ${options.buildDir}, for the`,
      "person writing its black-box conformance tests, and handed over the account below. They are writing the tests from it",
      "now and have a question. Answer it from the code: read it, and run it to see where reading is not enough - change",
      "nothing. Answer only what is asked, in words, with the exact names - routes, fields, commands, paths, versions - as",
      `the code has them, never guessed. Under ${MAX_ANSWER_CHARS} characters. Call submit_answer once.`,
      "",
      `<your account>\n${options.account.trim()}\n</your account>`,
      "",
      `<question>\n${options.question.trim()}\n</question>`,
    ].join("\n"),
    budget: { calls: ANSWER_CALLS, finish: ["submit_answer"] },
  });
  let reply = "";
  try {
    reply = await ask(session, BEGIN, options.onDelta);
  } finally {
    session.dispose();
    await services.stopAll();
  }
  const given = (answer ?? reply).trim();
  return given === "" ? "The explorer could not answer. Work it out from the account and the code, which you can read." : given.slice(0, MAX_ANSWER_CHARS * 2);
}

/** ask_explorer, for the conformance agent: a question about the software, answered by the explorer. */
export function createAskExplorerTool(options: { ask: (question: string) => Promise<string>; questions?: number }): ToolDefinition {
  let left = options.questions ?? EXPLORER_QUESTIONS;
  return defineTool({
    name: "ask_explorer",
    label: "Ask the explorer",
    description:
      "Ask the explorer - who read and ran the code, and wrote the account of it you were given - something the account " +
      "does not say: how a functionality is reached, what a field is called, what the software needs around it. It reads " +
      `and runs the code to answer. ${options.questions ?? EXPLORER_QUESTIONS} questions a run: ask what reading the code yourself would take long to find.`,
    promptSnippet: "ask_explorer: a question about how the software is reached, answered by the explorer from the code",
    parameters: Type.Object({ question: Type.String({ description: "What you need to know, exactly" }) }),
    async execute(_id, params) {
      if (left <= 0) return { content: [{ type: "text" as const, text: "No questions left in this run: work it out from the account and the code." }], details: {} };
      left -= 1;
      const answer = await options.ask((params as { question: string }).question);
      return { content: [{ type: "text" as const, text: `${answer}\n\n(${left} question${left === 1 ? "" : "s"} left)` }], details: {} };
    },
  }) as ToolDefinition;
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
    "check it does what the specification says. They will not see your replies: what you hand over with",
    "submit_exploration is what they start from. So hand over everything they need of",
    `it - in full, but only what they need: the interface to ${target}, not the codebase. Be focused: find its`,
    "entry point and what it needs around it; do not survey everything else. Describe the routes, commands,",
    `fields and their types in words - no code listings, no files pasted whole, under ${MAX_EXPLORATION_CHARS} characters in all. In its parts:`,
    "",
    "- build_and_run: what to install and build, the exact command that starts or runs it, where it listens",
    "  and how to tell it is up - for a server, start it with start_service and reach it with curl, so what you hand",
    "  over is what you saw it do;",
    "- tests_reach_it: how the conformance tests reach it, run as the conformance testing script below runs",
    "  them. Read the script: what it builds or installs, and where, before the tests run; then say exactly what",
    "  the tests depend on or start - a package, module, entry point, path or address, with its exact name and",
    "  version - and whether they start the software themselves, and how. Copy names and versions from the",
    "  code's build file itself, and name the file: never",
    "  infer them from a folder or module name. A test that cannot reach the software tests nothing, so this is",
    "  the part that matters most;",
    `- interfaces: for ${target} - and any other functionality its tests need to set up state - how it is`,
    "  reached from outside: the command and its arguments, or the route, method and headers, and the fields",
    "  of its request and response and their types, as the code takes them;",
    "- environment: environment variables, configuration, services and databases it talks to, files and",
    "  fixtures - and how each test gets a fresh one;",
    `- plan: the conformance tests to write for ${target}, from the specification and its acceptance tests:`,
    "  each case, how it is set up and invoked, what it checks as the specification says, and where the files",
    "  go as the test reqs say. Every acceptance test, named \"acceptance test N\" as the specification numbers",
    "  them, with how each of its steps is done from outside - through which endpoint, or which class and",
    "  method where the test reqs let the tests call a component directly - and what it asserts. A long one is",
    "  planned whole, never cut down;",
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
          "This is the project's conformance testing script, which the harness runs to decide whether the",
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

/** A review's word for a problem, as one of the two: "missing" (and anything starting so), else "bad". */
export function reviewKind(word: string): "missing" | "bad" {
  return /^\s*missing/i.test(word) ? "missing" : "bad";
}

/** What the review found wrong with the tests: which file and test, whether something is missing or bad, and exactly what. */
export interface ReviewProblem {
  file: string;
  test?: string;
  kind: "missing" | "bad";
  what: string;
  /**
   * The functionality is not yet tested, black box: a test or an acceptance test missing or cut down,
   * the software mocked or reached other than from outside, a test that cannot fail or skips what it
   * checks. Never let go. Anything else is a way to make good tests better.
   */
  blocking?: boolean;
}

/**
 * The review gate, after the conformance suite and the unit tests pass: do the tests this run added
 * or changed test the software black box, and do the acceptance tests do what the spec says - every
 * step, every expectation. Passing tests prove nothing when they assert nothing, mock the software
 * they test, or skip what the spec asks for. It reads the tests and the code and changes neither.
 * No verdict is no pass: a gate that cannot say yes stays shut.
 */
export interface TestReviewer {
  /** One review: what it is shown (`testReviewRequest`), and its verdict. No verdict is no pass. */
  review(request: string): Promise<{ pass: boolean; problems: ReviewProblem[] }>;
  dispose(): void;
}

/**
 * The reviewer, one session for the whole conformance run: a review after the first starts from what it already
 * read and raised. Its task is its instructions; each review is shown the diff of the tests - the whole of what the
 * run wrote first, what changed since after - and the conformance agent's account of it.
 */
export async function createTestReviewer(options: {
  /** What the work does to each functional spec (work.ts): a mechanical job is held only to that. */
  cases?: JobCases;
  buildDir: string;
  conformanceDir: string;
  spec: SpecContext;
  /** The functionality under test - or, for a spec change, those it touches - with their acceptance tests. */
  functionalities: Array<{ frid: string; acceptanceTests: string[] }>;
  forChange?: boolean;
  invocation: string;
  label: string;
  model?: string;
  onDelta?: (delta: string) => void;
}): Promise<TestReviewer> {
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
          kind: Type.String({
            description:
              '"missing" when a test the specification calls for is not there at all; "bad" when a test is there but weak, wrong or ' +
              "not black box. Any other word is read as one of the two - one starting with \"missing\" as missing, the rest as bad",
          }),
          what: Type.String({ description: "Exactly what is missing or bad, and what the specification says instead" }),
          blocking: Type.Boolean({
            description:
              "True when the functionality is not yet tested black box because of it: a test or an acceptance test missing, cut down or " +
              "skipping what it checks, the software mocked or not reached from outside, a test that cannot fail. False for a way to make " +
              "tests that already do that better",
          }),
        }),
      ),
    }),
    async execute(_id, params) {
      // "missing_test", "weak", "not black box": the verdict is what counts, not the exact word - one bad word never throws a review away.
      const given = { ...(params as { pass: boolean; problems: Array<ReviewProblem & { kind: string }> }) };
      given.problems = given.problems.map((problem) => ({ ...problem, kind: reviewKind(problem.kind) }));
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
    task: testReviewTask(options),
    compaction: { instructions: REVIEWER_COMPACTION },
    budget: { calls: REVIEWER_CALLS, finish: ["submit_review"] },
  });
  return {
    async review(request) {
      verdict = undefined;
      await ask(session, request, options.onDelta);
      if (verdict === undefined) await ask(session, "You have not called submit_review. Call it now: pass, or every problem.", options.onDelta);
      return (
        verdict ?? {
          pass: false,
          problems: [{ file: "(all)", kind: "bad", what: "The review gave no verdict. Check every test you added or changed against the rules above yourself." }],
        }
      );
    },
    dispose: () => session.dispose(),
  };
}

function problemText(problem: ReviewProblem): string {
  return `${problem.blocking === true ? "BLOCKING · " : ""}${problem.kind === "missing" ? "MISSING" : "BAD"} · ${problem.file}${problem.test ? ` · ${problem.test}` : ""}: ${problem.what.trim()}`;
}

/** The reviewer's task, for its instructions: word for word through every review of the run. */
export function testReviewTask(options: {
  /** What the work does to each functional spec (work.ts): a mechanical job is held only to that. */
  cases?: JobCases;
  buildDir: string;
  conformanceDir: string;
  spec: SpecContext;
  functionalities: Array<{ frid: string; acceptanceTests: string[] }>;
  forChange?: boolean;
  invocation: string;
}): string {
  const withAcceptance = options.functionalities.filter((item) => item.acceptanceTests.length > 0);
  const whose = options.forChange
    ? `the functionalities of module \`${options.spec.moduleName}\` the change touches (${options.functionalities.map((item) => item.frid).join(", ") || "none"})`
    : `functionality ${options.functionalities[0]?.frid ?? ""} of module \`${options.spec.moduleName}\``;
  return [
    specPrimer({ testReqs: true }),
    `You review the conformance tests of the \`${options.spec.moduleName}\` specification a conformance run adds or changes, each time`,
    "they pass - and the unit tests with them. Passing tests prove nothing when they assert nothing, mock the software",
    "they test, or leave out what the specification asks for.",
    "",
    "You are the exacting reviewer: opinionated, thorough, and hard to satisfy. Raise every problem you find with",
    "these tests, however small - a senior engineer weighs your findings after you, and lets go what is not worth",
    "the time. Missing one is worse than raising one too many.",
    "",
    `The tests are in ${options.conformanceDir}; the code is in ${options.buildDir}. Read both; change neither.`,
    "",
    "You review the same tests more than once. The first time you are shown everything the run wrote in the tests",
    "folder; each time after, what changed since your last review, and what the conformance agent says it did about",
    "each problem you raised. The diff is the harness's, not the agent's; <the conformance agent's account> is a claim -",
    "check it against the diff and the files. A problem it says is fixed that the tests do not fix is still a problem;",
    "one it declined, weigh its reason - it may be right.",
    "",
    ...(options.cases !== undefined && options.cases.mechanical ? [...conformanceReviewCasesBlock(options.cases), "", "And, of every test the run changed:"] : ["Check every test the run added or changed:"]),
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
    `- The conformance tests cover what the specification says ${options.forChange ? "the change does" : `${whose} does`} - its behaviour, its`,
    "  edge cases, its errors - each checked against the specification, not against what the code happens to do.",
    "  Only what can be seen from outside: where the specification says one part calls or uses another, the test",
    "  checks the outcome that follows - what comes back, what is stored, what the other service received - never",
    "  that the call was made. Asking for a test of how the code works inside is not a problem to raise.",
    "",
    "The first review finds every problem, in that one review - the tests go back once with all of them. A review after",
    "it checks each problem you raised last first - fixed, or still there - and raises a new one only when it is one of",
    "the above - a test that cannot fail, mocks the software, or leaves out or misdoes what the specification or an",
    "acceptance test asks for. Not a matter of style or thoroughness the last review let pass: the review is not done",
    "again from the start.",
    "",
    "Each review ends with submit_review, once: pass when nothing is missing and nothing is bad; otherwise every problem",
    '- the file, the test, its kind - "missing" for a test that is not there, "bad" for one that is weak, wrong or not',
    "black box - and exactly what, with what the specification says instead. Be specific: the agent that fixes them gets",
    "your list and nothing else. Mark a problem blocking when because of it the functionality is not yet tested black",
    "box - a test or an acceptance test missing, cut down or skipping what it checks, the software mocked or not reached",
    "from outside, a test that cannot fail. Those are worked on first; the rest - ways to make tests that already do",
    "that better - are let go after a few reviews.",
    "",
    "<specification>",
    options.spec.text.trim(),
    "</specification>",
    "",
    `<how to invoke it>\n${options.invocation.trim()}\n</how to invoke it>`,
  ].join("\n");
}

/** What one review of the tests is shown: the whole of what the run wrote first; after that, what changed since. */
export function testReviewRequest(options: {
  /** First review: the tests the run wrote (`workDiff`). After it: the diff since the last review (`diffSinceSnapshot`). */
  diff: string;
  /** The test files this run added or changed, relative to the tests folder. */
  changed: string[];
  account: string;
  /** The problems of the last review the conformance agent was given - given, this is a review after it. */
  earlier?: ReviewProblem[];
  /** What the arbiter let go of the last review. */
  letGo?: ReviewProblem[];
}): string {
  const diff = options.diff.trim();
  const again = options.earlier !== undefined;
  return [
    again
      ? "The conformance suite and the unit tests pass again, after the conformance agent worked on the problems your last review raised. Review the tests again."
      : "The conformance suite and the unit tests pass. Review the tests the run added or changed.",
    "",
    again ? "<what changed since your last review - a diff of the tests folder>" : "<the tests this run wrote - a diff of the tests folder from where the run started>",
    diff !== "" ? diff : again ? "(nothing changed since your last review)" : "(no diff - read the files listed below)",
    again ? "</what changed since your last review>" : "</the tests this run wrote>",
    "",
    "<tests added or changed by the run>",
    options.changed.join("\n"),
    "</tests added or changed by the run>",
    "",
    "<the conformance agent's account>",
    options.account,
    "</the conformance agent's account>",
    ...(again && options.earlier!.length > 0
      ? ["", "The problems of your last review the conformance agent was given:", ...options.earlier!.map((problem, index) => `${index + 1}. ${problemText(problem)}`)]
      : []),
    ...(options.letGo !== undefined && options.letGo.length > 0
      ? ["", "The arbiter weighed your last review and let these go - they are settled, do not raise them again:", ...options.letGo.map((problem) => `- ${problemText(problem)}`)]
      : []),
    "",
    "Then call submit_review.",
  ].join("\n");
}

/** The review's problems, for the conformance agent to fix. */
export function reviewFeedbackPrompt(problems: ReviewProblem[]): string {
  return [
    "The conformance suite and the unit tests pass. A review of the tests found how to make them better - each, exactly:",
    "",
    ...problems.map((problem, index) => `${index + 1}. ${problemText(problem)}`),
    "",
    "Fix every one: implement what is missing, and make what is bad test the software black box and as the",
    "specification says. Then run the suite. One you are sure the review is wrong about, decline, and say why.",
    ...SUBMIT_AFTER_REVIEW,
    ...REVIEW_LESSON,
  ].join("\n");
}

export type Culprit = "code" | "tests" | "spec" | "environment";

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
  /** For code: the specification's words the code does not meet, as the judge quoted them. */
  specSays?: string;
  /** For code: it is wrong because it hides why the software failed. */
  causeHidden?: boolean;
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

/**
 * How many times, one after the other, the run's environment is judged what is wrong before it counts: once more
 * than once, so a second judge of a new run - the tests checked in between - has to agree.
 */
export const ENVIRONMENT_RAISES = 2;

/** Which is wrong when the conformance suite fails - the code, the tests, or the spec itself - read against the spec. */
/** Text as it is compared for a quote: lower case, words only. */
function words(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

/**
 * Why a verdict that the code is wrong cannot be taken as it is, or nothing when it can. The code is
 * wrong only against what the specification says - so the judge quotes it, and the quote has to be
 * in the specification - or when it hides why the software failed. A test asserting what the
 * specification leaves open is the test's mistake, however plausible the assertion.
 */
export function unfoundedCodeVerdict(verdict: Verdict, specText: string): string | undefined {
  if (verdict.causeHidden === true) return undefined;
  const quote = verdict.specSays?.trim() ?? "";
  if (quote === "") {
    return (
      "Your verdict blames the code, but quotes no words of the specification it does not meet. Call submit_verdict " +
      "again: for code, put the specification's own words the code does not meet in spec_says, copied exactly from " +
      "<specification>; or set cause_hidden when the output does not show why the software failed. If the specification " +
      "does not say what the failing test asserts, the test is what is wrong: culprit tests."
    );
  }
  const quoted = words(quote);
  if (quoted.trim().split(" ").length < 4 || !words(specText).includes(quoted)) {
    return (
      `Your verdict blames the code, but "${quote}" is not in the specification. Call submit_verdict again: for code, ` +
      "copy into spec_says the specification's own words the code does not meet, exactly as they are in <specification>. " +
      "If no words of it say what the failing test asserts, the test is what is wrong: culprit tests."
    );
  }
  return undefined;
}

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
    description: "Say what is wrong - the code, the tests, the specification itself, or the run's environment - and why. Call this exactly once.",
    parameters: Type.Object({
      culprit: Type.Union([Type.Literal("code"), Type.Literal("tests"), Type.Literal("spec"), Type.Literal("environment")], {
        description:
          "What has to change to meet the specification - or spec, when the specification cannot be met at all, or environment, when only the person can fix what the run is given",
      }),
      reason: Type.String({ description: "Why, against the specification: which test, which behaviour, what the spec says" }),
      spec_says: Type.Optional(
        Type.String({
          description:
            "For code: the specification's own words the code does not meet, copied exactly from <specification> - the sentence, or the part of it that says what the test checks",
        }),
      ),
      cause_hidden: Type.Optional(
        Type.Boolean({ description: "For code: true when it is wrong because the output does not show why the software failed - it hides the cause" }),
      ),
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
      const given = params as { culprit: Culprit; reason: string; spec_says?: string; cause_hidden?: boolean; functionalities?: Array<{ module: string; id: string }> };
      verdict = {
        culprit: given.culprit,
        reason: given.reason,
        ...(given.spec_says?.trim() ? { specSays: given.spec_says.trim() } : {}),
        ...(given.cause_hidden === true ? { causeHidden: true } : {}),
        ...(given.functionalities ? { functionalities: conflictRefs(given.functionalities) } : {}),
      };
      return { content: [{ type: "text" as const, text: "Recorded." }], details: {}, terminate: true };
    },
  }) as ToolDefinition;
  // It reads both, and changes neither. It has a shell and the web too - to try the software, or ask
  // a service it calls what it answers - as the explorer does: its file tools write nothing, and what
  // it changes through the shell is told.
  const fence = confinedTools({ workdir: options.conformanceDir, read: [options.buildDir, options.conformanceDir], write: [] });
  const before = { code: digestFiles(options.buildDir), tests: digestFiles(options.conformanceDir) };
  const session = await createExecutor({
    cwd: options.conformanceDir,
    customTools: [submit, ...createWebTools(), ...fence.tools],
    tools: [...fence.names, ...WEB_TOOLS, "submit_verdict"],
    model: options.model,
    label: `${options.label} judge`,
    system: fence.note,
    task: judgePrompt(options),
    budget: { calls: JUDGE_CALLS, finish: ["submit_verdict"] },
  });
  try {
    await ask(session, BEGIN, options.onDelta);
    for (let again = 0; again < 2; again += 1) {
      if (verdict === undefined) {
        await ask(session, "You have not called submit_verdict. Call it now: code, tests, spec or environment, and why.", options.onDelta);
        continue;
      }
      if (verdict.culprit === "code") {
        const unfounded = unfoundedCodeVerdict(verdict, options.spec.text);
        if (unfounded === undefined) break;
        verdict = undefined;
        await ask(session, unfounded, options.onDelta);
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
  // A judge changes nothing: what its shell changed anyway is said, for whoever looks at the run.
  for (const [what, dir, digest] of [["code", options.buildDir, before.code], ["tests", options.conformanceDir, before.tests]] as const) {
    const changed = diffFiles(digest, digestFiles(dir));
    const files = [...changed.added, ...changed.changed, ...changed.removed];
    if (files.length > 0) reportActivity(`  the judge changed the ${what}, which it must not: ${files.slice(0, 5).join(", ")}`);
  }
  if (verdict?.culprit === "spec" && specConflictProblem(verdict.functionalities, options.scope) !== undefined) verdict = undefined;
  if (verdict?.culprit === "code" && unfoundedCodeVerdict(verdict, options.spec.text) !== undefined) {
    // Blaming the code takes the specification's own words; without them, the test asserts what the spec does not say.
    return { culprit: "tests", reason: `${verdict.reason}\n\nBut no words of the specification say so: a test that asserts what the specification does not say is what is wrong. Check each failing assertion against the specification, and assert only what it says.` };
  }
  if (verdict?.culprit === "code" && verdict.specSays !== undefined) {
    verdict = { ...verdict, reason: `${verdict.reason}\n\nThe specification says: "${verdict.specSays}"` };
  }
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
    `The conformance tests of the \`${options.spec.moduleName}\` specification failed. Decide what is wrong: the code, the tests, the specification itself, or the run's environment.`,
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
    "- environment: neither the code nor the tests can fix it - only the person can, in what the run is given: a",
    "  credential the run reads is missing, empty or rejected (a 401 or 403 from a provider for a token the tests did not",
    "  make up), an account, plan or quota a service refuses, a service the specification names that cannot be reached",
    "  at all. Say what the person has to provide, and where the run read it from - the file, the variable. Not for what",
    "  the tests set up themselves - a credential, a variable or a fixture a test sets, overrides or names wrong: that is",
    "  tests; nor for a toolchain or package missing where the tests run: the agents install those. The run stops on it",
    `  once it has been judged so ${ENVIRONMENT_RAISES} times in a row; until then the tests are checked for whether they cause it.`,
    "",
    "When the output does not show why the software failed - it answered with an error that names no cause, and",
    "logged nothing about it - the code is what is wrong first: it hides the cause, and nobody can fix what they",
    "cannot see. Judge code with cause_hidden, say that the cause has to be made to show, and name where the error is caught.",
    "",
    "To blame the code, quote in spec_says the specification's own words it does not meet, copied exactly - a",
    "verdict of code without them is not taken. What the specification leaves open is never the code's fault: a test",
    "that asserts it - a status code, a message, a format the specification does not name - is what is wrong.",
    "",
    `You have ${JUDGE_CALLS} tool calls to decide in: read what the failure points at, not the whole codebase.`,
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
 * works in the code folder, may read the tests but never changes them, and keeps the unit
 * tests passing.
 * Made the first time it is needed, and kept for the rest of the run: each fix after the first starts from what the
 * ones before it tried. Its task is its instructions; its work is compacted as it grows.
 */
export async function createCodeFixer(options: {
  buildDir: string;
  /** The conformance tests: it reads them, and never changes them. */
  conformanceDir?: string;
  label: string;
  model?: string;
  /** The specification it fixes the code to: in its task. */
  spec: SpecContext;
  /** Its own tools beyond the file tools: running the unit tests, its notes. */
  tools: ToolDefinition[];
  toolNames: string[];
}): Promise<AgentSession> {
  const fence = confinedTools({
    workdir: options.buildDir,
    read: [options.buildDir, ...(options.conformanceDir !== undefined ? [options.conformanceDir] : [])],
    write: [options.buildDir],
  });
  return createExecutor({
    cwd: options.buildDir,
    customTools: [...options.tools, ...createWebTools(), ...fence.tools],
    tools: [...fence.names, ...options.toolNames, ...WEB_TOOLS],
    model: options.model,
    label: `${options.label} coding agent`,
    system: `${fence.note}\n\n${workspaceBlock({ dir: options.buildDir, hasMyDiff: options.toolNames.includes("my_diff") })}`,
    task: codeFixerTask(options),
    compaction: { instructions: CODER_COMPACTION },
  });
}

/**
 * The code fixer's task, for its instructions: whose code it is, the specification, and how a fix is made. It stays
 * word for word through every fix of the run; each failure comes as a message (`codeFixPrompt`).
 */
export function codeFixerTask(options: { buildDir: string; conformanceDir?: string; spec: SpecContext }): string {
  return [
    specPrimer({ testReqs: false }),
    `You are the coding agent of the \`${options.spec.moduleName}\` specification. Its code is in ${options.buildDir}. When its`,
    "conformance tests fail and the code is what is wrong, you are sent the failure, and fix the code.",
    "",
    "<specification>",
    options.spec.text.trim(),
    "</specification>",
    "",
    ...fixMethod({ what: "conformance tests", fixes: "code", runTool: "run_conformance_tests" }),
    "",
    "run_conformance_tests runs the project's conformance testing script on the code as it now is, with the whole",
    "suite, and you get its output. Make the failure show in your own unit tests too where you can - for software that",
    "will not start, a unit test that starts it - so run_unit_tests catches it from now on.",
    "",
    "If the output does not show why the software failed, make it show first (the rule on errors below), run",
    "run_conformance_tests to read the cause, then fix that. Keep the logging.",
    "",
    ...(options.conformanceDir !== undefined
      ? [
          `You have read access to the conformance tests, in ${options.conformanceDir}, with your file tools - read, grep,`,
          "find, ls - but not write access: read them to see what a failing test does and expects; never change them.",
          "",
        ]
      : []),
    "Fix the code so it does what the specification says. The tests are not yours: you never change them, and",
    "they are not the judge - the specification is. Keep the unit tests passing: call run_unit_tests before",
    "you finish.",
    "Keep the build's identity as it is - its name, coordinates, version, package and main class - unless the",
    "specification asks for another: the tests and other builds point at them. Leave in your notes what holds about",
    "the code for the next agent, not an account of this fix: the harness records the attempts itself.",
    ...INTEGRITY_RULES,
    ...ERROR_CAUSE_RULES,
  ].join("\n");
}

/** One failure for the code fixer: the run, and why the code is what is wrong. */
export function codeFixPrompt(options: { run: ScriptRun; reason: string }): string {
  return [
    `The conformance tests failed, and the code is what is wrong (exit ${options.run.exitCode}):`,
    "",
    `<why the code>\n${options.reason.trim()}\n</why the code>`,
    "",
    `<failing run command="${options.run.command}">`,
    options.run.output.trimEnd(),
    "</failing run>",
    "",
    "Fix the code, run the conformance tests and the unit tests, and finish.",
  ].join("\n");
}

/** The run's environment judged what is wrong: the conformance agent checks the tests do not cause it, and changes nothing when they do not. */
export function environmentCheckPrompt(options: { run: ScriptRun; reason: string }): string {
  return [
    `The harness ran the conformance testing script, \`${options.run.command}\`, on the whole suite, and it failed (exit ${options.run.exitCode}).`,
    "It was checked against the specification, and what is wrong is judged to be the run's environment - something only",
    "the person can fix, such as a credential the run is given:",
    "",
    `<why the environment>\n${options.reason.trim()}\n</why the environment>`,
    "",
    "<failing run>",
    options.run.output.trimEnd().slice(-6000),
    "</failing run>",
    "",
    "Before that is taken as the answer, check that the tests do not cause it themselves: a credential, an environment",
    "variable or a fixture a test sets, overrides, leaves behind for the next test, or reads under the wrong name. If",
    "they do, fix the tests and run them. If they do not, change nothing - never make up a credential, write a .env",
    "file, or weaken a test so it passes without what it needs - and say so in submit_work.",
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
    ...fixMethod({ what: "conformance tests", fixes: "tests", runTool: "run_conformance_tests" }),
    "",
    "Correct the test to what the specification says. Never change a test so it agrees with code that",
    "contradicts the specification.",
  ].join("\n");
}
