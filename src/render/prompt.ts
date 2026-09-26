import {
  ACCEPTANCE_TESTS,
  DEFINITIONS,
  FUNCTIONAL_REQUIREMENTS,
  NON_FUNCTIONAL_REQUIREMENTS,
  TEST_REQUIREMENTS,
  type Specifications,
} from "../plain/spec.ts";
import type { LoadedResource } from "./resources.ts";
import { acceptanceLabel, acceptanceText, conformanceLabel } from "./test-kinds.ts";
import type { RequiredSpec } from "./state.ts";

export interface PromptInput {
  moduleName: string;
  frid: string;
  specifications: Specifications;
  linkedResources: LoadedResource[];
  /** The harness's map of the code built so far. Absent or null when there is none. */
  codebase?: string | null;
  /** Functional specs of the modules this one requires, transitively: already in the code. */
  required?: RequiredSpec[];
}

/**
 * Everything already in the code: the required modules' functional specs, bottom of the
 * chain first, then this module's own earlier ones. Null when there is nothing.
 *
 * Every agent that works on this codebase gets the same list, whatever its job. A render
 * that does not know what exists re-implements it; a test writer that does not know it
 * cannot set up what a functionality depends on; a fixer that does not know it breaks it.
 */
function alreadyImplemented(moduleName: string, own: string[], required: RequiredSpec[]): string | null {
  if (own.length === 0 && required.length === 0) return null;
  const entries = [
    ...required.map(
      (spec) => `<functionality module="${spec.module}" id="${spec.frid}" status="implemented">\n${spec.spec}\n</functionality>`,
    ),
    ...own.map(
      (spec, index) => `<functionality module="${moduleName}" id="${index + 1}" status="implemented">\n${spec}\n</functionality>`,
    ),
  ];
  return `<already implemented>\n${entries.join("\n\n")}\n</already implemented>`;
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
  const required = input.required ?? [];
  const requiredModules = [...new Set(required.map((spec) => spec.module))];
  const done = implementedRange(alreadyBuilt.length);
  // The required modules' code is this codebase's starting point, so their specs are done
  // work here just as much as this module's earlier ones.
  const inherited =
    requiredModules.length === 0
      ? ""
      : ` It builds on ${requiredModules.map((m) => `\`${m}\``).join(" and ")}, whose ${required.length} ` +
        `functional spec${required.length === 1 ? " is" : "s are"} implemented in this codebase too and listed first below.`;

  const parts: Array<string | null> = [
    `You are implementing one functionality of the \`${input.moduleName}\` specification.`,
    "",
    done === null
      ? `Nothing of \`${input.moduleName}\` is implemented yet: functionality ${input.frid} is its first.${inherited}`
      : `${done} ${alreadyBuilt.length === 1 ? "is" : "are"} already implemented: the code is in the working ` +
        "directory and its unit tests pass. They are listed below so you know what exists - they are not " +
        `your task. Your task is functionality ${input.frid}, and only functionality ${input.frid}.${inherited}`,
    "",
    section(DEFINITIONS, specifications[DEFINITIONS]),
    section(NON_FUNCTIONAL_REQUIREMENTS, specifications[NON_FUNCTIONAL_REQUIREMENTS]),
    // Test reqs are deliberately absent. They govern conformance testing, which is
    // written by an agent that has not seen this code - showing them here invites the
    // implementer to build towards the tests that are meant to judge it from outside.
    alreadyImplemented(input.moduleName, alreadyBuilt, required),
    // Exact, because the harness wrote it from the files and the build record. Without it
    // every render starts by rediscovering the same codebase the last one just explored.
    input.codebase ? `<codebase>\n${input.codebase}\n</codebase>` : null,
  ];

  parts.push(linkedResourcesSection(input.linkedResources));

  parts.push(
    `<functionality id="${input.frid}">\n${target}\n</functionality>`,
    section("acceptance tests", specifications[ACCEPTANCE_TESTS] ?? []),
    "",
    `Implement functionality ${input.frid} and its unit tests - only functionality ${input.frid}.`,
    "",
    ...(done === null && required.length === 0
      ? []
      : done === null
        ? [
            `- The functionalities of ${requiredModules.join(" and ")} exist. Do not implement them again, and do not`,
            `  rewrite their code. Change it only where functionality ${input.frid} needs it to, and keep their`,
            "  behaviour and their tests passing.",
          ]
        : requiredModules.length > 0
          ? [
              `- ${done} and the functionalities of ${requiredModules.join(" and ")} exist. Do not implement them`,
              `  again, and do not rewrite their code. Change it only where functionality ${input.frid} needs it to,`,
              "  and keep their behaviour and their tests passing.",
            ]
          : [
              `- ${done} ${alreadyBuilt.length === 1 ? "exists" : "exist"}. Do not implement ${alreadyBuilt.length === 1 ? "it" : "them"} again, and do not`,
              `  rewrite ${alreadyBuilt.length === 1 ? "its" : "their"} code. Change it only where functionality ${input.frid} needs it to, and keep`,
              `  ${alreadyBuilt.length === 1 ? "its behaviour and its" : "their behaviour and their"} tests passing.`,
            ]),
    ...workingRules(Boolean(input.codebase)),
    "- Report what you created and the final test result.",
  );

  return parts.filter((part): part is string => part !== null).join("\n");
}

function linkedResourcesSection(resources: LoadedResource[]): string | null {
  if (resources.length === 0) return null;
  const rendered = resources.map(
    (resource) => `<resource name="${resource.text}" path="${resource.target}">\n${resource.content}\n</resource>`,
  );
  return `<linked resources>\n${rendered.join("\n\n")}\n</linked resources>`;
}

/** How to work, for any agent writing code in this codebase from a spec. */
function workingRules(hasCodebase: boolean): string[] {
  return [
    ...(hasCodebase
      ? [
          "- The <codebase> map is exact - the harness wrote it from the files. Start from it: open the",
          "  files this functionality touches instead of listing or searching the whole directory.",
        ]
      : []),
    "- Write the implementation first, then unit tests covering it.",
    "- Your tests are unit tests, in the code. Conformance and acceptance tests are not yours: they are",
    "  written after you, from the spec, in the module's tests folder.",
    "- Honour every implementation req: they constrain the whole codebase, not just this step.",
    "- The implementation reqs say how the code and its unit tests must be built. Follow them.",
    "- Terms in `:ColonWrapped:` form are defined in the definitions; use them as written.",
    "- A `` `[resource]name` `` reference points at one of the linked resources above.",
    "- Run the tests however you like while you work - one file, one case, any configuration - with bash.",
    "  Before you finish, call run_unit_tests: it runs the project's unit testing script exactly as the",
    "  harness does to decide whether this is done, and that run is the only one that counts.",
    "- Fix the cause of a failure. Never delete, skip or weaken a test to get a pass - that includes",
    "  tests already in the working directory from earlier functionalities. A test may be removed",
    "  only when it asserts nothing meaningful, and you must say which test and why.",
  ];
}

export interface SpecDiffPromptInput {
  moduleName: string;
  /** The spec change, as a diff of the .plain files. */
  diff: string;
  /** The module's sections and its functional specs, as they stand after the change. */
  specifications: Specifications;
  /** Functional specs of the modules this one requires, as they stand after the change. */
  required: RequiredSpec[];
  linkedResources: LoadedResource[];
  codebase?: string | null;
  /** Nothing is built yet: the change is the whole spec. */
  empty: boolean;
}

/**
 * Build the prompt for rendering a change to the specs.
 *
 * The change is given as the person made it - a diff of the .plain files - and the specs as
 * they stand after it come with it, so the agent has both what moved and what it must add up
 * to. Additions, changes and removals, in any section, are one task: make the code match.
 */
export function buildSpecDiffPrompt(input: SpecDiffPromptInput): string {
  const { specifications } = input;
  const all = [
    ...input.required,
    ...specifications[FUNCTIONAL_REQUIREMENTS].map((spec, index) => ({
      module: input.moduleName,
      frid: String(index + 1),
      spec,
    })),
  ];
  const parts: Array<string | null> = [
    `You are changing the \`${input.moduleName}\` codebase to match a change in its specification.`,
    "",
    input.empty
      ? "Nothing is built yet: the working directory is empty, and the change is the whole specification."
      : "The working directory holds the code built so far, from the specs as they were before the change.",
    "<spec change> shows the change as a diff; the specs as they now stand follow. Your task is to make the",
    "code do what the specs say now - everything the change adds, changes and removes - and nothing else.",
    "",
    section(DEFINITIONS, specifications[DEFINITIONS]),
    section(NON_FUNCTIONAL_REQUIREMENTS, specifications[NON_FUNCTIONAL_REQUIREMENTS]),
    all.length === 0
      ? null
      : `<functional specs as they now stand>\n${all
          .map((spec) => `<functionality module="${spec.module}" id="${spec.frid}">\n${spec.spec}\n</functionality>`)
          .join("\n\n")}\n</functional specs as they now stand>`,
    input.codebase ? `<codebase>\n${input.codebase}\n</codebase>` : null,
    linkedResourcesSection(input.linkedResources),
    `<spec change>\n${input.diff.trim()}\n</spec change>`,
    "",
    "Make the code match the specs as they now stand.",
    "",
    "- Implement what the change adds. Update what it changes. Remove what it removes - its code and its",
    "  unit tests - where nothing that remains still needs it.",
    "- Your tests are unit tests, in the code. Conformance and acceptance tests are not yours: they are",
    "  written after you, from the spec, in the module's tests folder.",
    "- A change to a definition or a req reaches every functional spec that relies on it. Follow it there.",
    "- Everything the change does not touch must keep working, and its tests passing.",
    "- If the specs as they now stand hold changes that are not in <spec change>, those are later changes,",
    "  rendered on their own after this one. Leave them.",
    ...workingRules(Boolean(input.codebase)),
    "- Report what you changed and the final test result.",
  ];
  return parts.filter((part): part is string => part !== null).join("\n");
}

export interface RegeneratePromptInput {
  moduleName: string;
  frid: string;
  specifications: Specifications;
  linkedResources: LoadedResource[];
  /** The spec as this code was built from it. Unknown for a build recorded before it was kept. */
  previous?: string;
  /** Added to its module after this codebase was built: not in the code at all yet. */
  added?: boolean;
  /** The spec is exactly what the code was built from: regenerating by request, not because of a change. */
  unchanged?: boolean;
  /** Everything else in the codebase: every functional spec it holds except this one. */
  implemented: RequiredSpec[];
  /** Whose codebase this is, when it is not the functionality's own module's. */
  codebaseOf?: string;
  codebase?: string | null;
}

/**
 * Build the prompt for updating a functionality whose spec changed.
 *
 * Unlike a first render, the functionality is already in the code, and so is everything
 * built after it - possibly several modules' worth, when the codebase is a later module's.
 * So the task is a change, shown as one: what the spec said, what it says now, and every
 * other functionality in the code that has to keep working through it.
 */
export function buildRegeneratePrompt(input: RegeneratePromptInput): string {
  const { specifications } = input;
  const target = specifications[FUNCTIONAL_REQUIREMENTS].at(-1);
  if (target === undefined) throw new Error(`Functionality ${input.frid} has no specification text.`);
  const where =
    input.codebaseOf === undefined
      ? "the working directory"
      : `the working directory, which is the codebase of \`${input.codebaseOf}\` - built on top of \`${input.moduleName}\``;

  // Three situations share this prompt, and each needs saying plainly: a spec that changed is
  // a diff to apply; a spec that is new is a first implementation in a grown codebase; a spec
  // that did not change is a request to redo the work, which a diff of nothing would ignore.
  const mode = input.added ? "added" : input.unchanged ? "redo" : "changed";
  const opening = {
    added: `Functionality ${input.frid} was added to the \`${input.moduleName}\` specification after this codebase was built.`,
    redo: `Functionality ${input.frid} of the \`${input.moduleName}\` specification is to be regenerated. Its spec has not changed since it was built.`,
    changed: `Functionality ${input.frid} of the \`${input.moduleName}\` specification has changed since it was built.`,
  }[mode];
  const task = {
    added:
      `Every functionality listed as already implemented is in ${where}. Your task is to implement ` +
      `functionality ${input.frid} there - and only that.`,
    redo:
      `The code for it, and for every functionality listed as already implemented, is in ${where}. Your task ` +
      `is to implement functionality ${input.frid} again from its spec, replacing the code it has now - and only that.`,
    changed:
      `The code for it, and for every functionality listed as already implemented, is in ${where}. ` +
      `Your task is to update the code so functionality ${input.frid} does what its spec says now - and only that.`,
  }[mode];

  const parts: Array<string | null> = [
    opening,
    "",
    task,
    "",
    section(DEFINITIONS, specifications[DEFINITIONS]),
    section(NON_FUNCTIONAL_REQUIREMENTS, specifications[NON_FUNCTIONAL_REQUIREMENTS]),
    alreadyImplemented(input.moduleName, [], input.implemented),
    input.codebase ? `<codebase>\n${input.codebase}\n</codebase>` : null,
    linkedResourcesSection(input.linkedResources),
    input.previous !== undefined && mode === "changed"
      ? `<functionality id="${input.frid}" version="as built">\n${input.previous}\n</functionality>`
      : null,
    mode === "changed"
      ? `<functionality id="${input.frid}" version="now">\n${target}\n</functionality>`
      : `<functionality id="${input.frid}">\n${target}\n</functionality>`,
    section("acceptance tests", specifications[ACCEPTANCE_TESTS] ?? []),
    "",
    {
      added: `Implement functionality ${input.frid} and its unit tests.`,
      redo: `Implement functionality ${input.frid} and its unit tests again, from the spec.`,
      changed: `Update functionality ${input.frid} and its unit tests to the spec as it is now.`,
    }[mode],
    "",
    mode === "redo"
      ? "- Replace its code rather than patching it: write it as you would from the spec alone. Keep its interface " +
        "to the rest of the codebase - what other code calls, and what it calls."
      : mode === "changed"
        ? input.previous !== undefined
          ? "- Change what the new version changes, and nothing else. Where the two versions agree, the code stays."
          : "- The version it was built from is not recorded. Read the code for it, and change what no longer matches."
        : null,
    "- Everything listed as already implemented exists and must keep working, including what was built",
    "  after this functionality. Do not reimplement it or rewrite it; change it only where this update needs to.",
    {
      added: "- Write unit tests for it. Tests of anything else stay as they are.",
      redo: "- Rewrite the unit tests for this functionality from its spec. Tests of anything else stay as they are.",
      changed: "- Update the unit tests for this functionality to the new spec. Tests of anything else stay as they are.",
    }[mode],
    ...workingRules(Boolean(input.codebase)),
    "- Report what you changed and the final test result.",
  ];

  return parts.filter((part): part is string => part !== null).join("\n");
}


export interface ConformancePromptInput {
  moduleName: string;
  /** The functionality under test; for a spec change, the last there is - none before the first is written. */
  frid?: string;
  specifications: Specifications;
  linkedResources: LoadedResource[];
  /** File names in the build directory. */
  manifest: string[];
  /** Where the code is, for fixing it when it is what is wrong. */
  codeDir?: string;
  /** Tests already in the conformance directory, from an earlier version of the spec. */
  existingTests?: string[];
  /** Functional specs of the modules this one requires, transitively. */
  required?: RequiredSpec[];
  /**
   * A change to the specs, as a diff, instead of one functionality: the tests are brought in
   * line with the specs as they stand after it.
   */
  diff?: string;
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
  const forChange = input.diff !== undefined;
  const target = functionalities[functionalities.length - 1];
  if (target === undefined && !forChange) throw new Error(`Functionality ${input.frid} has no specification text.`);

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
    // Context, not the subject: what this functionality can rely on already existing - a
    // user registered before one logs in - so its tests can set that up through the same
    // public entry points. Only the functionality below is under test. For a diff, every
    // functionality is the spec as it now stands.
    alreadyImplemented(input.moduleName, input.diff !== undefined ? functionalities : functionalities.slice(0, -1), input.required ?? []),
  ];

  if (input.linkedResources.length > 0) {
    const rendered = input.linkedResources.map(
      (resource) =>
        `<resource name="${resource.text}" path="${resource.target}">\n${resource.content}\n</resource>`,
    );
    parts.push(`<linked resources>\n${rendered.join("\n\n")}\n</linked resources>`);
  }

  parts.push(
    input.diff !== undefined
      ? `<spec change>\n${input.diff.trim()}\n</spec change>`
      : `<functionality id="${input.frid}">\n${target}\n</functionality>`,
    input.diff !== undefined ? null : numberedAcceptanceTests(input.frid!, specifications[ACCEPTANCE_TESTS] ?? []),
    `<files in the build>\n${input.manifest.join("\n")}\n</files in the build>`,
    input.existingTests && input.existingTests.length > 0
      ? [
          `<conformance tests already here>\n${input.existingTests.join("\n")}\n</conformance tests already here>`,
          "",
          "This directory holds the conformance tests of every functionality built so far - this module's",
          "and those of the modules it requires, copied up with their code. Tests for other functionalities",
          "must keep passing: leave them as they are. If tests for this functionality are among them, from an",
          "earlier version of the specification, update them to it: keep the coverage, change only what the",
          "specification changed.",
        ].join("\n")
      : null,
    "",
    ...(input.diff !== undefined
      ? [
          "The specs were changed as in <spec change>, and the code has been updated to match. Bring the",
          "conformance tests in line with the specs as they now stand.",
          "",
          "- Add tests for behaviour the change adds, change the tests of behaviour it changes, and remove the",
          "  tests of behaviour it removes. Leave the tests of everything the change does not touch as they are.",
          "- The change is tested whatever it touches: a definition, an implementation req, the test reqs, as",
          "  well as a functional spec. Where it changes what built software must do or how the tests reach it,",
          "  the tests check that - with or without a functional spec that uses it yet.",
          "- A test is removed only because the spec no longer asks for what it checks. Say which, and why.",
        ]
      : [
          `Write conformance tests for functionality ${input.frid}.`,
          "",
          `- Test functionality ${input.frid} only. What is listed as already implemented is there to be`,
          "  used - to set up the state a test needs - not tested again.",
        ]),
    "- Write them in your working directory - the module's tests folder - and nowhere else: never in the",
    "  code folder, never beside the unit tests. That folder is the conformance suite; the harness runs it,",
    "  and nothing else, as one. When it runs, the tests are put together with a copy of the build, so refer",
    "  to the built files by the paths in <files in the build>, resolved against the current working",
    "  directory rather than against your test file's own location.",
    "- Organise the tests however suits them - files, folders, shared helpers. Make it clear which",
    forChange
      ? "  functionality a test covers, so its tests can be found and updated later."
      : `  functionality a test covers, so functionality ${input.frid}'s tests can be found and updated later.`,
    ...(forChange ? changeTestKinds() : testKinds(input.frid!, (specifications[ACCEPTANCE_TESTS] ?? []).length)),
    "- Test observable behaviour only: output, exit codes, files produced, values returned by the",
    "  public entry point. Never assert on internal names, private helpers or implementation detail.",
    "- The test reqs say how conformance tests must be written and run. Follow them.",
    "- Run them however you like while you work - one file, one case, any configuration - with bash.",
    "  Before you finish, call run_conformance_tests: it runs the project's conformance testing script on",
    "  the whole suite exactly as the harness does to decide whether this is done, and that run is the",
    "  only one that counts.",
    "- When a test fails, work out against the specification what is wrong - the test or the code - and",
    "  fix that one. A test that misreads the specification is corrected. Code that does not do what the",
    input.codeDir
      ? `  specification says is fixed, in ${input.codeDir}; then check its unit tests with run_unit_tests.`
      : "  specification says is fixed; then check its unit tests with run_unit_tests.",
    "- Never change a test so it agrees with code that contradicts the specification: the tests say what",
    "  the specification requires, and the code is what has to meet it.",
    "- Never delete, skip or weaken a test to get a pass. A test may be removed only when it asserts",
    "  nothing meaningful, and you must say which test and why.",
  );

  return parts.filter((part): part is string => part !== null).join("\n");
}


/** The functionality's acceptance tests, numbered as their tests are labelled. */
function numberedAcceptanceTests(frid: string, items: string[]): string | null {
  if (items.length === 0) return null;
  const rendered = items.map((item, i) => `${acceptanceLabel(frid, i + 1)}: ${acceptanceText(item)}`);
  return `<acceptance tests>\n${rendered.join("\n\n")}\n</acceptance tests>`;
}

/** The two kinds of test, for a spec change: each labelled with what it covers. */
function changeTestKinds(): string[] {
  return [
    "- Conformance tests come from the specs themselves: what they say the software does, its edge cases, its",
    "  errors - written as if no acceptance tests had been given. They do not copy the acceptance tests.",
    `- Label them: files whose names say conformance, each with a comment at its top naming the functionality it`,
    `  covers - "${conformanceLabel("<id>")}" - or, for one that covers no functional spec yet, "${CHANGE_LABEL}".`,
    "- Acceptance tests - the ones the specs list under acceptance tests - are implemented separately from the",
    "  conformance tests, each as its own test, doing what it says, in files whose names say acceptance.",
    `- Label each acceptance test with a comment right above it: "${acceptanceLabel("<id>", 1)}:" and the text`,
    "  of the acceptance test, numbered as the spec lists them.",
  ];
}

/** What a conformance test covering no functional spec yet - a definition, a req - is labelled. */
export const CHANGE_LABEL = "conformance tests of the spec";

/**
 * The two kinds of test, kept apart and labelled (see test-kinds.ts). `acceptance` is how many
 * acceptance tests the functionality has; for a spec change, it is left to the change.
 */
function testKinds(frid: string, acceptance: number | undefined): string[] {
  const conformance = [
    "- Conformance tests come from the functional spec itself: what it says the functionality does, its edge",
    "  cases, its errors - written as if no acceptance tests had been given. They do not copy the acceptance",
    "  tests, and do not stop where the acceptance tests stop.",
    `- Label them: files whose names say conformance, each with a comment "${conformanceLabel(frid)}" at its top`,
    "  (for a spec change, the functionality each covers).",
  ];
  if (acceptance === 0) return conformance;
  return [
    ...conformance,
    acceptance === undefined
      ? "- Acceptance tests - the ones the specs list under acceptance tests - are implemented separately from the"
      : `- Separately from them, implement each of the ${acceptance} acceptance test${acceptance === 1 ? "" : "s"} above as its own test, doing what it`,
    acceptance === undefined
      ? "  conformance tests, each as its own test, doing what it says, in files whose names say acceptance."
      : "  says, in files whose names say acceptance. Never fold one into a conformance test, even where they overlap.",
    `- Label each acceptance test with a comment right above it: "${acceptanceLabel(frid, 1)}:" and the text`,
    "  of the acceptance test, numbered as above.",
  ];
}

export interface RegressionFixPromptInput {
  moduleName: string;
  /** Functionalities built so far, in order. */
  frids: string[];
  specifications: Specifications;
  failure: string;
  /** Functional specs of the modules this one requires, transitively. */
  required?: RequiredSpec[];
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
    // All of it is in the code, the required modules' functionalities included, and any of it
    // may be what the latest change broke.
    alreadyImplemented(input.moduleName, specifications[FUNCTIONAL_REQUIREMENTS], input.required ?? []),
    `<conformance failure>\n${input.failure}\n</conformance failure>`,
    "",
    "Change the implementation so every functionality listed as already implemented works at the same time.",
    "",
    "- The conformance tests are not in this directory and you cannot edit them. Fix the code.",
    "- Do not fix one functionality by breaking another. They must all hold together.",
    "- Do not special-case the test. Make the behaviour the specification describes actually true.",
    "- Keep the existing unit tests passing. Run any tests you like with bash; before you finish, call",
    "  run_conformance_tests and run_unit_tests - the project's scripts, run as the harness runs them.",
    "- Never delete or weaken an existing test to get a pass.",
    "- Report what you changed and why.",
  ];

  return parts.filter((part): part is string => part !== null).join("\n");
}
