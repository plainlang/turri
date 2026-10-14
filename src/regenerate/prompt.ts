import { modulesScratchDir } from "./paths.ts";
import {
  ACCEPTANCE_TESTS,
  DEFINITIONS,
  FUNCTIONAL_REQUIREMENTS,
  NON_FUNCTIONAL_REQUIREMENTS,
  REQUIRED_FUNCTIONAL_SPECS,
  TEST_REQUIREMENTS,
  type MarshalledPlainSource,
  type Specifications,
} from "../plain/spec.ts";
import { codeCopyOf, isCodeResource, type LoadedResource } from "./resources.ts";
import { acceptanceLabel, acceptanceText, conformanceLabel } from "./test-kinds.ts";
import { codeCasesBlock, conformanceCasesBlock } from "./cases.ts";
import { marksRegenerateAgain } from "./records.ts";
import type { JobCases } from "./drift.ts";
import type { RequiredSpec } from "./state.ts";
import { resourcesChanged, type SpecChange } from "./spec-steps.ts";

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
  const entries = [...required, ...own.map((spec, index) => ({ module: moduleName, frid: String(index + 1), spec }))];
  return `<already implemented>\n${functionalitiesByModule(entries, moduleName, "implemented")}\n</already implemented>`;
}

/**
 * Functional specs grouped by the module they belong to - in the order the modules are built on
 * one another, the current module marked - and each tagged with its module and its id there. A codebase holds the
 * functionalities of every module it is built on, and each module numbers its own from 1, so
 * "functionality 1" alone is ambiguous: the first listed may be base's 1 and the next top's 3.
 * (the reference implementation's implemented functional requirements prompt section, as tags.)
 */
export function functionalitiesByModule(
  entries: Array<{ module: string; frid: string; spec: string }>,
  currentModule: string,
  status?: string,
): string {
  // In the order given: the bottom of the chain first. A regeneration in a later module's
  // codebase has modules built on the current one after it, so "current" is marked, never assumed last.
  const modules = [...new Set(entries.map((entry) => entry.module))];
  return modules
    .map((module) => {
      const items = entries
        .filter((entry) => entry.module === module)
        .map(
          (entry) =>
            `<functionality module="${entry.module}" id="${entry.frid}"${status !== undefined ? ` status="${status}"` : ""}>\n${entry.spec}\n</functionality>`,
        );
      return `<module name="${module}"${module === currentModule ? ' role="current"' : ""}>\n${items.join("\n\n")}\n</module>`;
    })
    .join("\n\n");
}

/** "functionality 3 of module `app`": a functionality, named so that no other module's can be meant. */
export function functionalityOf(frid: string, moduleName: string): string {
  return `functionality ${frid} of module \`${moduleName}\``;
}

/**
 * How to read a ***plain specification: what each section is, and what the predefined concepts
 * mean. At the head of every prompt for an agent that builds, tests or judges from a spec - the
 * spec-writing agents have it from the authoring rules. Without it an agent reads
 * "- :Implementation: uses FastAPI." as a term it should have found in the definitions.
 *
 * `testReqs`: whether this agent is given the test reqs - the agents that write and judge the
 * conformance tests are, the ones that write code are not.
 */
export function specPrimer(options: { testReqs: boolean }): string {
  return [
    "<how to read the specification>",
    "The specification is written in ***plain. It reaches you in tags, one for each section, and every section is called",
    "by its tag's name wherever this prompt mentions it:",
    "- <definitions>: the concepts the rest of the specification uses, each written :LikeThis:. Wherever such a term",
    "  appears, it means exactly what its definition says.",
    "- <implementation reqs>: how the system is built and the constraints it meets - language, frameworks, storage,",
    "  conventions, how the unit tests are written. They say how, not what the system does, and they bind the whole",
    "  codebase: every functionality, not just the one at hand.",
    options.testReqs
      ? "- <test reqs>: how the conformance tests are written and run."
      : "- <test reqs>: how the conformance tests are written and run. They are not given to you: the conformance tests\n" +
        "  are written apart from the code, from the specification.",
    "- <functional specs>: what the system does, one functionality at a time, numbered in order, each built on the ones",
    '  before it. Each functional spec is a <functionality module="..." id="...">; those in <already implemented> are',
    "  in the code.",
    "- Modules: a ***plain specification is split into modules, each a .plain file of its own. Modules are how the",
    "  specification is written, in ***plain's own syntax - not how the code is laid out. A module can require others:",
    "  it is built on their code, in one codebase with them, so the codebase holds their definitions, implementation",
    "  reqs and functionalities as well as its own. A module can also import others: those hold only definitions and",
    "  reqs - shared ones, never functional specs or code of their own - and what a module imports is its own. Every",
    "  section reaches you grouped under the module each item belongs to - <module name=\"...\">, the modules in the",
    "  order they are built on one another, the current one marked role=\"current\". Each module numbers its",
    "  functional specs from 1, so a functionality is always given with its module and its id there: functionality 1",
    "  of `base` and functionality 1 of `app` are two different functionalities.",
    "- You work only in the codebase of the current module: it is all you can reach, and it already holds the code of",
    "  every module it requires. Organise and write the code as the <implementation reqs> say - its layout, its",
    "  structure, its conventions - never by the ***plain modules: they say where the specification puts an item,",
    "  not where its code goes.",
    "- <acceptance tests>: under a functional spec, specific checks that functionality's implementation must pass.",
    "  They carry the same authority as the functional spec itself.",
    "- <linked resources>: files the specification refers to as `[resource]name`. They are part of the specification.",
    "  A linked resource is not in your workspace. When the code needs what one holds while it runs - a schema it",
    "  validates against, a version it reports - it keeps exactly one copy, at the path its code-copy names in the",
    "  codebase (or where the <implementation reqs> put such files), and reads it from there; otherwise it copies none.",
    "  copy_resource makes that copy, whole and byte for byte - never type a resource out. A long one is shown cut",
    "  short: copy it to read the whole of it. A resource that is code - a source file or a build manifest, with no",
    "  code-copy - is code that lives elsewhere, linked so you know what your code plugs into: build on it as the",
    "  specification says, and never copy it, nor recreate it or what it belongs to.",
    "  An image among them is attached to your first message, numbered in the order they are listed: look at it.",
    "- <spec change>: a change to the specification, section by section, each section in its own tag - what it adds,",
    "  what it changes (before and now), and what it removes.",
    "",
    "Predefined concepts - used in every specification without being defined in it:",
    "- :Implementation: - the system that implements :plainFunctionality:.",
    "- :plainImplementationCode: - the code of :Implementation:.",
    "- :UnitTests: - the unit tests of individual parts of :plainImplementationCode:, written with the code.",
    "- :ConformanceTests: - black-box tests that check :plainImplementationCode: conforms to :plainFunctionality:,",
    "  written apart from it and following :plainTestReqs:.",
    "- :AcceptanceTest: - one acceptance test: how some aspect of :plainImplementationCode: must be checked against",
    "  the specification. :AcceptanceTests: are a functional spec's collection of them.",
    "- :plainDefinitions:, :plainImplementationReqs:, :plainFunctionality:, :plainTestReqs: - how the specification's own",
    "  text names <definitions>, <implementation reqs>, <functional specs> and <test reqs>.",
    'So "- :Implementation: uses FastAPI." is an implementation req on the whole system, and "- :UnitTests: use',
    'pytest." says how the unit tests are written.',
    "</how to read the specification>",
    "",
  ].join("\n");
}

/**
 * How a failure is fixed without being hidden - for every agent that fixes code or tests. The
 * point of a failing test is the failure: a fix that makes it go away without making the software
 * right leaves the defect in, and the test unable to catch it again.
 */
export const INTEGRITY_RULES = [
  "- Fix the real cause of a failure. Never change test data or an expected value just so a test passes, never",
  "  mock or stub the system under test to hide a failure, and never skip, suppress or silence a failing test -",
  "  a known issue included: it keeps failing until the software does what the specification says.",
  "- A partial fix that makes real progress - a syntax error, a configuration problem, a test that could not run",
  "  at all - is fine, and so is adding diagnostic logging to find the cause.",
  "- Never make the code behave differently when a test runs it - for a test's input, name, id or environment -",
  "  than it would for anyone else.",
];

/**
 * How a failure is fixed - for every agent sent back with one: understand it, reproduce it, fix the
 * cause, check the fix the way the harness will. A fix made from the last line of the output alone
 * fixes the symptom, if anything, and comes back next round.
 */
export function fixMethod(options: { what: "unit tests" | "conformance tests"; fixes: "code" | "tests"; runTool: string }): string[] {
  const runOne =
    options.what === "unit tests"
      ? "run just that test with bash - one file, one case - and watch it fail the same way"
      : `run it with ${options.runTool} and watch it fail the same way - the output names the failing test`;
  return [
    "Work through it in order:",
    `1. Understand the failure. Which ${options.what === "unit tests" ? "test" : "conformance test"} failed, what it expected and what it got, and the exact error`,
    "   with its whole trace and every cause it names. When the output is cut, the whole of it is in the file the cut",
    "   names: read it. Don't go on the last line alone.",
    `2. Find where it comes from. Read the lines the trace points at, in the ${options.fixes === "code" ? "code - and the test, to see exactly what it does and expects" : "test - and the code, to see how it is reached"}.`,
    `   Hold what ${options.fixes === "code" ? "the code does" : "the test asserts"} against what the specification says. Say to yourself what the root cause is before`,
    "   you change anything - not the symptom: the null behind the exception, the wrong path behind the 404.",
    `3. Reproduce it: ${runOne}. A failure you cannot reproduce, you cannot`,
    "   know you fixed. If it does not fail, find out why before you change anything.",
    `4. Fix the cause, in the ${options.fixes}: the change that makes ${options.fixes === "code" ? "the code do" : "the test check"} what the specification says. One cause at a time.`,
    `5. Check the fix: run the failing test again and see it pass, then the whole suite with ${options.runTool}. A fix`,
    "   that breaks another test is not a fix. If it still fails, go back to 1 with the new output:",
    "   it may be the next cause, now that this one is out of the way.",
    "6. Leave in your notes what the cause was and what fixed it, in a line, for whoever meets it next.",
  ];
}

/**
 * Why something failed is never lost - for every agent that writes or fixes code. A failure answered
 * with a bare "failed" and logged nowhere leaves whoever has to fix it guessing, round after round.
 */
export const ERROR_CAUSE_RULES = [
  "- Never lose why something failed. Where the code catches an error and turns it into a response, a status, a",
  "  result or a retry, it logs the error with its whole trace, and what it hands on names the cause - never a bare",
  "  \"failed\" or \"error\" in its place, unless the specification says what it answers. A call to another",
  "  service that fails says what was called - the method and the address - and what came back: the status and",
  "  the body. Never a secret: no password, key or token in a log or a message.",
];

/** A section's tag - its name in every prompt: `<implementation reqs>`, `<acceptance tests>`. */
export function sectionTag(key: string): string {
  return key === ACCEPTANCE_TESTS ? "acceptance tests" : key;
}

export function section(key: string, items: string[]): string | null {
  if (items.length === 0) return null;
  const tag = sectionTag(key);
  return `<${tag}>\n${items.join("\n\n")}\n</${tag}>`;
}

/**
 * The module each item of a spec's sections belongs to, in order, by section. A codebase is built from the spec of its
 * whole requires chain: an item of a module below carries that module's name (records.ts `chainTree`); the module's
 * own - and what it imports, which is its own - carry none, and are `moduleName`'s.
 */
export type SectionModules = Partial<Record<string, string[]>>;

export function sectionModules(tree: MarshalledPlainSource, moduleName: string): SectionModules {
  const of = (key: string) => ((tree[key] as Array<{ module?: string }> | undefined) ?? []).map((item) => item.module ?? moduleName);
  return { [DEFINITIONS]: of(DEFINITIONS), [NON_FUNCTIONAL_REQUIREMENTS]: of(NON_FUNCTIONAL_REQUIREMENTS), [TEST_REQUIREMENTS]: of(TEST_REQUIREMENTS) };
}

/**
 * A section of the spec, its items grouped under the module each belongs to - the modules in the order they are built on
 * one another, the current one marked - as the functional specs are (`functionalitiesByModule`). Without `modules`, or
 * when they do not match the items one for one, every item is the current module's.
 */
export function moduleSection(key: string, items: string[], moduleName: string, modules?: SectionModules): string | null {
  if (items.length === 0) return null;
  const given = modules?.[key];
  const owners = given !== undefined && given.length === items.length ? given : items.map(() => moduleName);
  const groups = [...new Set(owners)].map(
    (module) =>
      `<module name="${module}"${module === moduleName ? ' role="current"' : ""}>\n${items.filter((_, index) => owners[index] === module).join("\n\n")}\n</module>`,
  );
  const tag = sectionTag(key);
  return `<${tag}>\n${groups.join("\n\n")}\n</${tag}>`;
}

function linkedResourcesSection(resources: LoadedResource[]): string | null {
  if (resources.length === 0) return null;
  // An image is not text: the prompt says where it is - attached to the first message, by number - and what type.
  // A text resource has one home in the codebase, should the code need it: its path, made relative to the codebase.
  const rendered = resources.map(
    (resource) =>
      `<resource name="${resource.text}" path="${resource.target}"${resource.image !== undefined ? ` type="${resource.image.mimeType}"` : isCodeResource(resource.target) ? ' kind="code"' : ` code-copy="${codeCopyOf(resource.target)}"`}>\n${resource.content}\n</resource>`,
  );
  return `<linked resources>\n${rendered.join("\n\n")}\n</linked resources>`;
}

/** How to work, for any agent writing code in this codebase from a spec. `mechanical`: the job writes no new tests. */
function workingRules(hasCodebase: boolean, mechanical = false): string[] {
  return [
    ...(hasCodebase
      ? [
          "- The <codebase> map is exact - the harness wrote it from the files. Start from it: open the",
          "  files this functionality touches instead of listing or searching the whole directory.",
        ]
      : []),
    ...(mechanical ? [] : ["- Write the implementation first, then unit tests covering it.", "- Your tests are unit tests, in the code."]),
    "- Honour every implementation req.",
    "- Keep the build's identity as it is: its name, coordinates, version, package and main class. Change one only",
    "  when the specification asks you to - other builds and the conformance tests point at them.",
    // How the tests are run, and which run counts, is the testing scripts' note (test-scripts.ts); how a failure is
    // fixed, INTEGRITY_RULES. What is the coder's alone: which tests it may remove.
    "- A test may be removed only when it asserts nothing meaningful - one from an earlier functionality too - and",
    "  you say which test and why.",
    ...INTEGRITY_RULES,
    ...ERROR_CAUSE_RULES,
  ];
}

export interface SpecDiffPromptInput {
  moduleName: string;
  /** The spec change, as a diff of the .plain files. */
  diff: string;
  /** The change item by item, from what the code is built from to the spec it ends on: shown section by section in place of the diff. */
  changes?: SpecChange[];
  /** The module's sections and its functional specs, as they stand after the change. */
  specifications: Specifications;
  /** Functional specs of the modules this one requires, as they stand after the change. */
  required: RequiredSpec[];
  linkedResources: LoadedResource[];
  codebase?: string | null;
  /** Nothing is built yet: the change is the whole spec. */
  empty: boolean;
  /** What the job does to each functional spec (work.ts): the agent is told case by case. Not given: in general. */
  cases?: JobCases;
  /** The module each definition and req belongs to: see `sectionModules`. */
  modules?: SectionModules;
}

/**
 * The specification a review of some work is given: laid out exactly as the coding agent had it - how to read a
 * ***plain spec, the definitions, the implementation reqs, what was already implemented - and then what is new, in
 * a block of its own: the change the work made, section by section. The reviewer reads what the coding agent read,
 * and knows exactly what this work was.
 */
export function reviewedSpec(input: {
  moduleName: string;
  specifications: Specifications;
  /** Functional specs of the modules this one requires: already in the code. */
  required?: RequiredSpec[];
  /** The change, section by section. */
  change?: string;
  /** The module each definition and req belongs to: see `sectionModules`. */
  modules?: SectionModules;
}): string {
  const { specifications } = input;
  const functionalities = specifications[FUNCTIONAL_REQUIREMENTS] ?? [];
  const required = input.required ?? [];
  return [
    specPrimer({ testReqs: false }),
    "",
    moduleSection(DEFINITIONS, specifications[DEFINITIONS] ?? [], input.moduleName, input.modules),
    moduleSection(NON_FUNCTIONAL_REQUIREMENTS, specifications[NON_FUNCTIONAL_REQUIREMENTS] ?? [], input.moduleName, input.modules),
    alreadyImplemented(input.moduleName, functionalities, required),
    "<new in this work>",
    specChangeBlock(input.change ?? "(the change is not known)"),
    "</new in this work>",
  ]
    .filter((part): part is string => part !== null)
    .join("\n");
}

/**
 * Said above a spec change given as the raw diff of the .plain files - when it could not be told section by section:
 * the one place an agent meets the files' own headings, so it is told which tag each is.
 */
const RAW_CHANGE_NOTE =
  "The change could not be told section by section, so it is the diff of the .plain files, as the person made it. There,\n" +
  "each section is headed by its name in stars: ***definitions*** is <definitions>, ***implementation reqs*** is\n" +
  "<implementation reqs>, ***test reqs*** is <test reqs>, ***functional specs*** is <functional specs>, and\n" +
  "***acceptance tests*** under a functional spec is its <acceptance tests>.";

/** A change in its tag: told section by section, or - when it could not be - the raw diff, with which tag each heading is. */
export function specChangeBlock(change: string): string {
  const raw = /^diff --git |^@@ |^[+-]{3} /m.test(change);
  return `<spec change>\n${raw ? `${RAW_CHANGE_NOTE}\n\n` : ""}${change.trim()}\n</spec change>`;
}

/** The sections as the change is told, in the order a spec has them. Test reqs are the conformance tests', not the code's. */
const CHANGE_SECTIONS: Array<{ key: string; title: string }> = [
  { key: DEFINITIONS, title: "definitions" },
  { key: NON_FUNCTIONAL_REQUIREMENTS, title: "implementation reqs" },
  { key: FUNCTIONAL_REQUIREMENTS, title: "functional specs" },
  { key: "required functional specs", title: "functional specs of the modules this one requires" },
];

/** A changed item's text: its markdown, and its acceptance tests under it. */
function itemText(serialized: string | undefined): string {
  if (serialized === undefined) return "";
  let item: unknown;
  try {
    item = JSON.parse(serialized);
  } catch {
    return serialized;
  }
  if (typeof item === "string") return item;
  const { markdown, [ACCEPTANCE_TESTS]: tests } = (item ?? {}) as { markdown?: string; [key: string]: unknown };
  const lines = [markdown ?? JSON.stringify(item)];
  if (Array.isArray(tests) && tests.length > 0) lines.push("  <acceptance tests>", ...tests.map((test) => `  ${String(test)}`), "  </acceptance tests>");
  return lines.join("\n");
}

const indent = (text: string, by: string) => text.split("\n").map((line) => `${by}${line}`).join("\n");

/** A changed item, read back: undefined when its line is not one. */
const parsed = (serialized: string | undefined): unknown => {
  try {
    return serialized === undefined ? undefined : JSON.parse(serialized);
  } catch {
    return undefined;
  }
};

/**
 * A spec change as an agent reads it: section by section, what was added, what changed - before and now - and what
 * was removed. A definition taken out and put back reworded, or moved, is one change to it, not two. Every item is
 * named so no other module's can be meant: a functional spec by its module and number, and a definition or req of a
 * module below by its module; `moduleName` is the module whose codebase it is - whose own items carry no module.
 */
export function describeSpecChange(changes: SpecChange[], moduleName?: string): string {
  const conceptOf = (text: string) => /^-\s+(:[^:\s]+:)/.exec(text)?.[1];
  const blocks: string[] = [];
  const known = new Set(CHANGE_SECTIONS.map((section) => section.key));
  const sections = [...CHANGE_SECTIONS, ...[...new Set(changes.map((change) => change.section))].filter((key) => !known.has(key) && key !== TEST_REQUIREMENTS).map((key) => ({ key, title: sectionTag(key) }))];
  for (const { key, title } of sections) {
    const here = changes.filter((change) => change.section === key);
    if (here.length === 0) continue;
    /** Which item it is: a functional spec by its module and number, a definition by its concept, and one of a module below with that module. */
    const labelOf = (change: SpecChange, line: string | undefined): string => {
      const item = parsed(line) as { module?: string; frid?: string } | undefined;
      const below = item?.module !== undefined && item.module !== moduleName ? ` of module \`${item.module}\`` : "";
      if (key === FUNCTIONAL_REQUIREMENTS) return moduleName !== undefined ? functionalityOf(String(change.position), moduleName) : `functionality ${change.position}`;
      if (key === REQUIRED_FUNCTIONAL_SPECS) return item?.module !== undefined && item.frid !== undefined ? functionalityOf(item.frid, item.module) : `functionality ${change.position}${below}`;
      if (key === DEFINITIONS) return `${conceptOf(itemText(line)) ?? `item ${change.position}`}${below}`;
      return `item ${change.position}${below}`;
    };
    /** Whether an added or removed item is named above its text: a functional spec always, anything else of a module below. */
    const named = (line: string | undefined) =>
      key === FUNCTIONAL_REQUIREMENTS || key === REQUIRED_FUNCTIONAL_SPECS || (() => {
        const item = parsed(line) as { module?: string } | undefined;
        return item?.module !== undefined && item.module !== moduleName;
      })();
    const changed: Array<{ label: string; before: string; after: string; resources?: string[] }> = [];
    // A definition "changed" into another concept is one removed and another added: a definition is itself by its concept.
    const split = here.flatMap((change): SpecChange[] =>
      key === DEFINITIONS && change.kind === "change" && conceptOf(itemText(change.before)) !== conceptOf(itemText(change.after))
        ? [{ ...change, kind: "remove", after: undefined }, { ...change, kind: "add", before: undefined }]
        : [change],
    );
    let added = split.filter((change) => change.kind === "add");
    let removed = split.filter((change) => change.kind === "remove");
    // Marked to regenerate again: built, and regenerated again - what it says now, and what it said, where that changed too.
    const again = split.filter((change) => change.kind === "change" && marksRegenerateAgain(parsed(change.before)));
    for (const change of split.filter((item) => item.kind === "change" && !again.includes(item))) {
      const label = labelOf(change, change.after);
      const resources = resourcesChanged(change.before, change.after).map((resource) => resource.target);
      changed.push({ label, before: itemText(change.before), after: itemText(change.after), ...(resources.length > 0 ? { resources } : {}) });
    }
    // A definition removed and added again under the same concept is that definition changed.
    if (key === DEFINITIONS) {
      for (const out of [...removed]) {
        const concept = conceptOf(itemText(out.before));
        const back = concept === undefined ? undefined : added.find((change) => conceptOf(itemText(change.after)) === concept);
        if (back === undefined) continue;
        removed = removed.filter((change) => change !== out);
        added = added.filter((change) => change !== back);
        if (itemText(out.before) !== itemText(back.after)) changed.push({ label: labelOf(back, back.after), before: itemText(out.before), after: itemText(back.after) });
      }
    }
    const counts = [
      added.length > 0 ? `${added.length} added` : "",
      changed.length > 0 ? `${changed.length} changed` : "",
      again.length > 0 ? `${again.length} to regenerate again` : "",
      removed.length > 0 ? `${removed.length} removed` : "",
    ].filter(Boolean);
    if (counts.length === 0) continue;
    const lines = [`<${title} change="${counts.join(", ")}">`];
    if (changed.length > 0) {
      lines.push("Changed:");
      for (const change of changed) {
        // What a file it links holds changed: said, since its text may read as it did.
        const held = change.resources?.map((target) => `    what ${target} holds changed - it is in <linked resources> as it is now: make the code match it`) ?? [];
        if (change.before === change.after && held.length > 0) lines.push(`  ${change.label}`, "    its text is as it was:", indent(change.after, "      "), ...held);
        else lines.push(`  ${change.label}`, "    before:", indent(change.before, "      "), "    now:", indent(change.after, "      "), ...held);
      }
    }
    if (again.length > 0) {
      lines.push("To regenerate again - built already, and regenerated again:");
      for (const change of again) {
        const label = labelOf(change, change.after);
        if (itemText(change.before) === itemText(change.after)) lines.push(`  ${label}:`, indent(itemText(change.after), "    "));
        else lines.push(`  ${label}`, "    before:", indent(itemText(change.before), "      "), "    now:", indent(itemText(change.after), "      "));
      }
    }
    if (added.length > 0) {
      lines.push("Added:");
      for (const change of added) {
        if (named(change.after)) lines.push(`  ${labelOf(change, change.after)}:`);
        lines.push(indent(itemText(change.after), "  "));
      }
    }
    if (removed.length > 0) {
      lines.push("Removed:");
      for (const change of removed) {
        if (named(change.before)) lines.push(`  ${labelOf(change, change.before)}:`);
        lines.push(indent(itemText(change.before), "  "));
      }
    }
    lines.push(`</${title}>`);
    blocks.push(lines.join("\n"));
  }
  return blocks.length > 0 ? blocks.join("\n\n") : "Nothing the code is built from changes: the change is only in how the specs are laid out, or in the test reqs.";
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
    specPrimer({ testReqs: false }),
    `You are changing the \`${input.moduleName}\` codebase to match a change in its specification.`,
    "",
    input.empty
      ? "Nothing is built yet: the working directory is empty, and the change is the whole specification."
      : "The working directory holds the code built so far, from the specs below - the specs before the change.",
    "The specification the code is built from follows - its functional specs in <already implemented> - and then",
    "<spec change>, the change to it, section by section: the specification below with the change applied is what the",
    "code has to do once you are done. Your task is to apply the change to the code - everything it adds, changes and",
    "removes - and nothing else.",
    "",
    moduleSection(DEFINITIONS, specifications[DEFINITIONS], input.moduleName, input.modules),
    moduleSection(NON_FUNCTIONAL_REQUIREMENTS, specifications[NON_FUNCTIONAL_REQUIREMENTS], input.moduleName, input.modules),
    all.length === 0 ? null : `<already implemented>\n${functionalitiesByModule(all, input.moduleName, "implemented")}\n</already implemented>`,
    input.codebase ? `<codebase>\n${input.codebase}\n</codebase>` : null,
    linkedResourcesSection(input.linkedResources),
    input.changes !== undefined && input.changes.length > 0
      ? specChangeBlock(describeSpecChange(input.changes, input.moduleName))
      : `<spec change>\n${RAW_CHANGE_NOTE}\n\n${input.diff.trim()}\n</spec change>`,
    "",
    ...(input.cases !== undefined
      ? codeCasesBlock(input.cases)
      : [
          "- Implement what the change adds. Update what it changes. Remove what it removes - its code and its",
          "  unit tests - where nothing that remains still needs it.",
          "- A change to a definition or an implementation req reaches every functional spec that relies on it. Follow it there.",
        ]),
    "- Everything the change does not touch must keep working, and its tests passing.",
    ...workingRules(Boolean(input.codebase), input.cases?.mechanical === true),
  ];
  return parts.filter((part): part is string => part !== null).join("\n");
}

export interface ConformancePromptInput {
  /** What the job does to each functional spec (work.ts): the agent is told case by case. Not given: in general. */
  cases?: JobCases;
  moduleName: string;
  /** The functionality under test; for a spec change, the last there is - none before the first is written. */
  frid?: string;
  specifications: Specifications;
  linkedResources: LoadedResource[];
  /** File names in the build directory. */
  manifest: string[];
  /** Where the code is, for fixing it when it is what is wrong. */
  codeDir?: string;
  /**
   * How to invoke the built software from outside, as an agent that explored the code wrote it.
   * Given, the author works from this and fixes only tests - when a run fails, another agent decides
   * whether the test or the code is wrong.
   */
  invocation?: string;
  /** The code, which the author may read but never change. */
  readCode?: string;
  /** The code's build files, read by the harness: the exact name, coordinates and version a test project points at. */
  manifests?: Array<{ path: string; content: string }>;
  /** For a spec change: the functionalities it touches, with their acceptance tests - each implemented and labelled. */
  touched?: Array<{ frid: string; acceptanceTests: string[] }>;
  /** Tests already in the conformance directory, from an earlier version of the spec. */
  existingTests?: string[];
  /** Functional specs of the modules this one requires, transitively. */
  required?: RequiredSpec[];
  /**
   * A change to the specs, as a diff, instead of one functionality: the tests are brought in
   * line with the specs as they stand after it.
   */
  diff?: string;
  /** The module each definition and req belongs to: see `sectionModules`. */
  modules?: SectionModules;
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
    specPrimer({ testReqs: true }),
    `You are writing conformance tests for the \`${input.moduleName}\` specification.`,
    "",
    "Conformance tests are black box. They invoke the built functionality from the outside -",
    "running its executable or importing its public entry point - and check that it behaves as",
    "the specification says.",
    "",
    ...(input.invocation !== undefined
      ? [
          ...(input.readCode !== undefined
            ? [
                `You have read access to the code, in ${input.readCode}, with your file tools - read, grep, find, ls - but`,
                "not write access: you write tests, never code. Read it to see how the software is reached - its routes,",
                "commands, names, how it starts - never for what it should do: that comes from the specification. Your",
                "shell holds your tests folder and the code, the code read only: to build or run the software yourself,",
                `copy the code into a folder of your own under ${modulesScratchDir(input.readCode)}, and build and run it there.`,
              ]
            : [
                "You cannot read or view the code. It is not in your sandbox - your file tools and your shell hold your",
                "tests folder and nothing else - so do not look for it: no searching parent folders, absolute paths or /tmp.",
              ]),
          "An agent that explored the code wrote down what you need of it, in <how to invoke it>: how it is",
          "built and run, how each functionality is reached from outside, what it needs around it, and a plan for",
          "these tests. Write the conformance tests from this prompt - the specification, that account and its",
          "plan - and what is in your tests folder: the tests already there show how the suite is built and run.",
          "Every assertion comes from the specification, never from what the account says the code does. Where the",
          "code and the specification disagree, the test follows the specification and fails. The plan is a",
          "starting point: where it and the specification differ, the specification is right.",
          "The conformance testing script at the top of this prompt is how your tests are built and run: read what it",
          "builds or installs before your tests run, and so what they can depend on or start to reach the software.",
          "Write the tests' own build - its dependencies, how it starts the software - to fit that script.",
          "",
          `<how to invoke it>\n${input.invocation.trim()}\n</how to invoke it>`,
          ...((input.manifests ?? []).length > 0
            ? [
                "",
                "The code's build files, read from the code by the harness, as they are. They are the one place to take the",
                "code's exact name, coordinates and version from - whatever your tests' own build has to point at. Copy them",
                "from here; never guess them, and never take them from a folder or module name.",
                "",
                ...input.manifests!.map((manifest) => `<code build file path="${manifest.path}">\n${manifest.content.trimEnd()}\n</code build file>`),
              ]
            : []),
        ]
      : [
          "You can read the implementation, and you should, but only to find out how the thing is",
          "invoked: its entry point, its arguments, the shape of its output. Every assertion comes",
          "from the specification. A test that asserts what the code happens to do agrees with the",
          "code by construction and can never catch it being wrong - which is the only thing these",
          "tests are for. Where the code and the specification disagree, the test follows the",
          "specification and fails.",
        ]),
    "",
    moduleSection(DEFINITIONS, specifications[DEFINITIONS], input.moduleName, input.modules),
    moduleSection(NON_FUNCTIONAL_REQUIREMENTS, specifications[NON_FUNCTIONAL_REQUIREMENTS], input.moduleName, input.modules),
    moduleSection(TEST_REQUIREMENTS, specifications[TEST_REQUIREMENTS], input.moduleName, input.modules),
    // Context, not the subject: what this functionality can rely on already existing - a
    // user registered before one logs in - so its tests can set that up through the same
    // public entry points. Only the functionality below is under test. For a diff, every
    // functionality is the spec as it now stands.
    alreadyImplemented(input.moduleName, input.diff !== undefined ? functionalities : functionalities.slice(0, -1), input.required ?? []),
  ];

  const resources = linkedResourcesSection(input.linkedResources);
  if (resources !== null) parts.push(resources);

  parts.push(
    input.diff !== undefined
      ? specChangeBlock(input.diff)
      : `<functionality module="${input.moduleName}" id="${input.frid}">\n${target}\n</functionality>`,
    input.diff !== undefined
      ? touchedAcceptanceTests(input.touched ?? [])
      : numberedAcceptanceTests(input.frid!, specifications[ACCEPTANCE_TESTS] ?? []),
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
          ...(input.cases !== undefined
            ? conformanceCasesBlock(input.cases)
            : [
                "- Add tests for behaviour the change adds, change the tests of behaviour it changes, and remove the",
                "  tests of behaviour it removes. Leave the tests of everything the change does not touch as they are.",
                "- The change is tested whatever it touches: a definition, an implementation req, the test reqs, as",
                "  well as a functional spec. Where it changes what built software must do or how the tests reach it,",
                "  the tests check that - with or without a functional spec that uses it yet.",
              ]),
          "- A test is removed only because the spec no longer asks for what it checks. Say which, and why.",
        ]
      : [
          `Write conformance tests for ${functionalityOf(input.frid!, input.moduleName)}.`,
          "",
          `- Test ${functionalityOf(input.frid!, input.moduleName)} only. What is listed as already implemented is there to be`,
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
      : `  functionality a test covers, so the tests of ${functionalityOf(input.frid!, input.moduleName)} can be found and updated later.`,
    ...(forChange ? changeTestKinds() : testKinds(input.frid!, (specifications[ACCEPTANCE_TESTS] ?? []).length)),
    "- Test observable behaviour only: output, exit codes, files produced, values returned by the",
    "  public entry point. Never assert on internal names, private helpers or implementation detail.",
    "- <test reqs> say how conformance tests must be written and run. Follow them.",
    ...(input.invocation !== undefined
      ? [
          "- Your shell holds the tests folder, and the code read only. Run the tests with run_conformance_tests:",
          "  it puts the whole suite together with a copy of the build and runs the project's conformance",
          "  testing script exactly as the harness does to decide whether this is done, and that run is the only",
          "  one that counts. Call it before you finish.",
          "- You change tests, never code. When the harness's run fails, another agent works out against the",
          "  specification whether a test or the code is wrong. When it is a test, you are sent back with why:",
          "  correct it to what the specification says. When it is the code, the coding agent fixes that.",
          "- When a run fails because of the software itself - it does not build or start, or does what the",
          "  specification says it must not - the tests are not what is wrong: do not work around it in them - no",
          "  mocking, no skipping, no changing what they expect, no pointing them elsewhere. Stop, and say in your",
          "  report what the software does; the harness has the code fixed.",
          "- You can run the suite three times a turn with run_conformance_tests. The third ends your turn: the harness",
          "  then runs it itself, and works out what is wrong. When a run's output is cut, the cut names the id the",
          "  whole of it is kept as - read it with read_output before you change anything.",
        ]
      : [
          "- Run them however you like while you work - one file, one case, any configuration - with bash.",
          "  Before you finish, call run_conformance_tests: it runs the project's conformance testing script on",
          "  the whole suite exactly as the harness does to decide whether this is done, and that run is the",
          "  only one that counts.",
          "- When a test fails, work out against the specification what is wrong - the test or the code - and",
          "  fix that one. A test that misreads the specification is corrected. Code that does not do what the",
          input.codeDir
            ? `  specification says is fixed, in ${input.codeDir}; then check its unit tests with run_unit_tests.`
            : "  specification says is fixed; then check its unit tests with run_unit_tests.",
        ]),
    "- Never change a test so it agrees with code that contradicts the specification: the tests say what",
    "  the specification requires, and the code is what has to meet it.",
    "- Never delete, skip or weaken a test to get a pass. A test may be removed only when it asserts",
    "  nothing meaningful, and you must say which test and why.",
    ...INTEGRITY_RULES,
    "- Every test fails explicitly - through an assertion or a raised error - when what it checks does not hold,",
    "  and its failure message says what was expected, what came back, and enough of the context to debug it",
    "  from: the failure output is all the next agent, and whoever judges it, gets.",
  );

  return parts.filter((part): part is string => part !== null).join("\n");
}


/**
 * For a spec change: the acceptance tests of the functionalities it touches, numbered as their tests
 * are labelled - each implemented as a test of its own, as a functionality's own run has them.
 */
function touchedAcceptanceTests(touched: Array<{ frid: string; acceptanceTests: string[] }>): string | null {
  const withTests = touched.filter((item) => item.acceptanceTests.length > 0);
  if (withTests.length === 0) return null;
  const rendered = withTests.flatMap((item) => item.acceptanceTests.map((test, index) => `${acceptanceLabel(item.frid, index + 1)}: ${acceptanceText(test)}`));
  return [
    "The acceptance tests of the functional specs the change touches:",
    `<acceptance tests>\n${rendered.join("\n\n")}\n</acceptance tests>`,
    "Each of these is implemented as a test of its own, doing every step it lists and asserting every expectation it",
    "states, and labelled as it is numbered here - bring the ones already there in line with the change.",
  ].join("\n");
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
    "- Acceptance tests - the ones in <acceptance tests> - are implemented separately from the conformance tests,",
    "  each as its own test, doing what it says, in files whose names say acceptance.",
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
      ? "- Acceptance tests - the ones in <acceptance tests> - are implemented separately from the"
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
  /** The module each definition and req belongs to: see `sectionModules`. */
  modules?: SectionModules;
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
    specPrimer({ testReqs: false }),
    `The conformance suite for \`${input.moduleName}\` is failing.`,
    "",
    `It covers functionalities ${input.frids.join(", ")} of module \`${input.moduleName}\` together. A functionality that passed`,
    "on its own can still be broken by a later one, which is what this run is for.",
    "",
    moduleSection(DEFINITIONS, specifications[DEFINITIONS], input.moduleName, input.modules),
    moduleSection(NON_FUNCTIONAL_REQUIREMENTS, specifications[NON_FUNCTIONAL_REQUIREMENTS], input.moduleName, input.modules),
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
    ...INTEGRITY_RULES,
    ...ERROR_CAUSE_RULES,
    "- Keep the build's identity as it is: its name, coordinates, version, package and main class. Change one only",
    "  when the specification asks you to - other builds and the conformance tests point at them.",
    "- Report what you changed and why.",
  ];

  return parts.filter((part): part is string => part !== null).join("\n");
}
