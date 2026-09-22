import {
  ACCEPTANCE_TESTS,
  DEFINITIONS,
  FUNCTIONAL_REQUIREMENTS,
  NON_FUNCTIONAL_REQUIREMENTS,
  TEST_REQUIREMENTS,
  type Specifications,
} from "../plain/spec.ts";
import type { LoadedResource } from "./resources.ts";

export interface PromptInput {
  moduleName: string;
  frid: string;
  specifications: Specifications;
  linkedResources: LoadedResource[];
}

/** "Functionality 1", "Functionalities 1 and 2", "Functionalities 1 to 3", or null for none. */
function implementedRange(count: number): string | null {
  if (count === 0) return null;
  if (count === 1) return "Functionality 1";
  if (count === 2) return "Functionalities 1 and 2";
  return `Functionalities 1 to ${count}`;
}

function section(title: string, items: string[]): string | null {
  if (items.length === 0) return null;
  return `<${title}>\n${items.join("\n\n")}\n</${title}>`;
}

/**
 * Build the prompt for one functionality.
 *
 * `getSpecificationsForFrid` returns every functionality up to and including the target,
 * so the last entry is what this run implements and the ones before it are already-built
 * context. Keeping that distinction explicit is the difference between the agent
 * extending the codebase and rewriting it.
 */
export function buildRenderPrompt(input: PromptInput): string {
  const { specifications } = input;
  const functionalities = specifications[FUNCTIONAL_REQUIREMENTS];
  const target = functionalities[functionalities.length - 1];
  if (target === undefined) throw new Error(`Functionality ${input.frid} has no specification text.`);
  const alreadyBuilt = functionalities.slice(0, -1);
  const done = implementedRange(alreadyBuilt.length);

  const parts: Array<string | null> = [
    `You are implementing one functionality of the \`${input.moduleName}\` specification.`,
    "",
    done === null
      ? `Nothing is implemented yet: functionality ${input.frid} is the first, and the working directory is where it goes.`
      : `${done} ${alreadyBuilt.length === 1 ? "is" : "are"} already implemented: the code is in the working ` +
        "directory and its unit tests pass. They are listed below so you know what exists - they are not " +
        `your task. Your task is functionality ${input.frid}, and only functionality ${input.frid}.`,
    "",
    section(DEFINITIONS, specifications[DEFINITIONS]),
    section(NON_FUNCTIONAL_REQUIREMENTS, specifications[NON_FUNCTIONAL_REQUIREMENTS]),
    // Test reqs are deliberately absent. They govern conformance testing, which is
    // written by an agent that has not seen this code - showing them here invites the
    // implementer to build towards the tests that are meant to judge it from outside.
    alreadyBuilt.length === 0
      ? null
      : `<already implemented>\n${alreadyBuilt
          .map((spec, index) => `<functionality id="${index + 1}" status="implemented">\n${spec}\n</functionality>`)
          .join("\n\n")}\n</already implemented>`,
  ];

  if (input.linkedResources.length > 0) {
    const rendered = input.linkedResources.map(
      (resource) =>
        `<resource name="${resource.text}" path="${resource.target}">\n${resource.content}\n</resource>`,
    );
    parts.push(`<linked resources>\n${rendered.join("\n\n")}\n</linked resources>`);
  }

  parts.push(
    `<functionality id="${input.frid}">\n${target}\n</functionality>`,
    section("acceptance tests", specifications[ACCEPTANCE_TESTS] ?? []),
    "",
    `Implement functionality ${input.frid} and its unit tests - only functionality ${input.frid}.`,
    "",
    ...(done === null
      ? []
      : [
          `- ${done} ${alreadyBuilt.length === 1 ? "exists" : "exist"}. Do not implement ${alreadyBuilt.length === 1 ? "it" : "them"} again, and do not`,
          `  rewrite ${alreadyBuilt.length === 1 ? "its" : "their"} code. Change it only where functionality ${input.frid} needs it to, and keep`,
          `  ${alreadyBuilt.length === 1 ? "its behaviour and its" : "their behaviour and their"} tests passing.`,
        ]),
    "- Write the implementation first, then unit tests covering it.",
    "- Honour every implementation req: they constrain the whole codebase, not just this step.",
    "- The implementation reqs say how the code and its unit tests must be built. Follow them.",
    "- Terms in `:ColonWrapped:` form are defined in the definitions; use them as written.",
    "- A `` `[resource]name` `` reference points at one of the linked resources above.",
    "- Call run_unit_tests to run the suite, and keep going until it passes. A run through",
    "  run_unit_tests is the only result that counts; running tests any other way is not recorded.",
    "- Fix the cause of a failure. Never delete, skip or weaken a test to get a pass - that includes",
    "  tests already in the working directory from earlier functionalities. A test may be removed",
    "  only when it asserts nothing meaningful, and you must say which test and why.",
    "- Report what you created and the final test result.",
  );

  return parts.filter((part): part is string => part !== null).join("\n");
}


export interface ConformancePromptInput {
  moduleName: string;
  frid: string;
  specifications: Specifications;
  linkedResources: LoadedResource[];
  /** File names in the build directory. Names only - the code itself stays unseen. */
  manifest: string[];
  /** Tests already in the conformance directory, from an earlier version of the spec. */
  existingTests?: string[];
}

/**
 * Build the prompt for conformance tests.
 *
 * These are black-box in shape: they invoke the built functionality from outside and check
 * it does what the specification says. The agent can read the implementation - it needs to
 * know how to call the thing - but the prompt leads with the specification, because a test
 * written from the code can only ever agree with it.
 */
export function buildConformancePrompt(input: ConformancePromptInput): string {
  const { specifications } = input;
  const functionalities = specifications[FUNCTIONAL_REQUIREMENTS];
  const target = functionalities[functionalities.length - 1];
  if (target === undefined) throw new Error(`Functionality ${input.frid} has no specification text.`);

  const parts: Array<string | null> = [
    `You are writing conformance tests for the \`${input.moduleName}\` specification.`,
    "",
    "Conformance tests are black box. They invoke the built functionality from the outside -",
    "running its executable or importing its public entry point - and check that it behaves as",
    "the specification says.",
    "",
    "You can read the implementation, and you should, but only to find out how the thing is",
    "invoked: its entry point, its arguments, the shape of its output. Every assertion comes",
    "from the specification. A test that asserts what the code happens to do agrees with the",
    "code by construction and can never catch it being wrong - which is the only thing these",
    "tests are for. Where the code and the specification disagree, the test follows the",
    "specification and fails.",
    "",
    section(DEFINITIONS, specifications[DEFINITIONS]),
    section(NON_FUNCTIONAL_REQUIREMENTS, specifications[NON_FUNCTIONAL_REQUIREMENTS]),
    section(TEST_REQUIREMENTS, specifications[TEST_REQUIREMENTS]),
  ];

  if (input.linkedResources.length > 0) {
    const rendered = input.linkedResources.map(
      (resource) =>
        `<resource name="${resource.text}" path="${resource.target}">\n${resource.content}\n</resource>`,
    );
    parts.push(`<linked resources>\n${rendered.join("\n\n")}\n</linked resources>`);
  }

  parts.push(
    `<functionality id="${input.frid}">\n${target}\n</functionality>`,
    section("acceptance tests", specifications[ACCEPTANCE_TESTS] ?? []),
    `<files in the build>\n${input.manifest.join("\n")}\n</files in the build>`,
    input.existingTests && input.existingTests.length > 0
      ? [
          `<your existing tests>\n${input.existingTests.join("\n")}\n</your existing tests>`,
          "",
          "Those are your tests for this functionality, written against an earlier version of the",
          "specification. Read them and update them to match the specification",
          "above. Keep the coverage you already had; change only what the specification changed.",
        ].join("\n")
      : null,
    "",
    `Write conformance tests for functionality ${input.frid}.`,
    "",
    "- Write them in the working directory. It is merged with the build when they run, so refer",
    "  to the built files by the paths in <files in the build>, resolved against the current working",
    "  directory rather than against your test file's own location.",
    `- Put the functionality id in each test file name, for example \`test_conformance_${input.frid.replace(/\./g, "_")}\`.`,
    "  Every functionality's tests are merged into one directory when the suite runs as a regression,",
    "  and a clashing name would be renamed.",
    "- The acceptance tests above are the criteria. Cover each one.",
    "- Test observable behaviour only: output, exit codes, files produced, values returned by the",
    "  public entry point. Never assert on internal names, private helpers or implementation detail.",
    "- The test reqs say how conformance tests must be written and run. Follow them.",
    "- Call run_conformance_tests to run them. A run through that tool is the only result that counts.",
    "- At least one of your runs must use the whole-suite command from the test reqs, the one that",
    "  discovers every test in the working directory. Narrowing to the file you just wrote is fine",
    "  while iterating, but the suite command is what the regression run will reuse.",
    "- When a test fails, decide what is actually wrong: your test, or the code. Call submit_triage",
    "  with that judgement. A test that misreads the specification is your bug; code that does not do",
    "  what the specification says is the implementation's, and will be sent back to be fixed.",
    "- Never delete, skip or weaken a test to get a pass. A test may be removed only when it asserts",
    "  nothing meaningful, and you must say which test and why.",
  );

  return parts.filter((part): part is string => part !== null).join("\n");
}


export interface CodeFixPromptInput {
  moduleName: string;
  frid: string;
  specifications: Specifications;
  /** Why the conformance run was judged to be the code's fault. */
  triage: string;
  /** Output of the failing conformance run. */
  failure: string;
}

/**
 * Build the prompt for fixing code that failed conformance.
 *
 * This agent can see and change the implementation; it cannot see or change the
 * conformance tests. That asymmetry is the point - the tests state what the
 * specification requires, and the code is what moves.
 */
export function buildCodeFixPrompt(input: CodeFixPromptInput): string {
  const { specifications } = input;
  const functionalities = specifications[FUNCTIONAL_REQUIREMENTS];
  const target = functionalities[functionalities.length - 1] ?? "";

  const parts: Array<string | null> = [
    `Conformance tests for \`${input.moduleName}\` functionality ${input.frid} are failing, and the`,
    "failure has been judged to be in the code rather than in the tests.",
    "",
    section(DEFINITIONS, specifications[DEFINITIONS]),
    section(NON_FUNCTIONAL_REQUIREMENTS, specifications[NON_FUNCTIONAL_REQUIREMENTS]),
    `<functionality id="${input.frid}">\n${target}\n</functionality>`,
    section("acceptance tests", specifications[ACCEPTANCE_TESTS] ?? []),
    `<why the code is at fault>\n${input.triage}\n</why the code is at fault>`,
    `<conformance failure>\n${input.failure}\n</conformance failure>`,
    "",
    "Change the implementation so it does what the specification says.",
    "",
    "- The conformance tests are not in this directory and you cannot edit them. Fix the code.",
    "- Do not special-case the test. Make the behaviour the specification describes actually true.",
    "- Keep the existing unit tests passing; call run_unit_tests to check.",
    "- Never delete or weaken an existing test to get a pass.",
    "- Report what you changed and why.",
  ];

  return parts.filter((part): part is string => part !== null).join("\n");
}


export interface RegressionFixPromptInput {
  moduleName: string;
  /** Functionalities built so far, in order. */
  frids: string[];
  specifications: Specifications;
  failure: string;
}

/**
 * Build the prompt for repairing a regression.
 *
 * A regression means the newest functionality broke an older one, so the whole module's
 * conformance suite is the subject. The tests are not editable from here - they state
 * what the specification requires of every functionality built so far.
 */
export function buildRegressionFixPrompt(input: RegressionFixPromptInput): string {
  const { specifications } = input;
  const parts: Array<string | null> = [
    `The conformance suite for \`${input.moduleName}\` is failing.`,
    "",
    `It covers functionalities ${input.frids.join(", ")} together. A functionality that passed`,
    "on its own can still be broken by a later one, which is what this run is for.",
    "",
    section(DEFINITIONS, specifications[DEFINITIONS]),
    section(NON_FUNCTIONAL_REQUIREMENTS, specifications[NON_FUNCTIONAL_REQUIREMENTS]),
    section("functionalities built so far", specifications[FUNCTIONAL_REQUIREMENTS]),
    `<conformance failure>\n${input.failure}\n</conformance failure>`,
    "",
    "Change the implementation so every functionality above works at the same time.",
    "",
    "- The conformance tests are not in this directory and you cannot edit them. Fix the code.",
    "- Do not fix one functionality by breaking another. They must all hold together.",
    "- Do not special-case the test. Make the behaviour the specification describes actually true.",
    "- Keep the existing unit tests passing; call run_unit_tests to check.",
    "- Never delete or weaken an existing test to get a pass.",
    "- Report what you changed and why.",
  ];

  return parts.filter((part): part is string => part !== null).join("\n");
}
