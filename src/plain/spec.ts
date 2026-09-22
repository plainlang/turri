import { createHash } from "node:crypto";
import { InvalidFridArgument } from "./errors.ts";
import type { LinkedResource } from "./markdown.ts";

/** Port of plain_spec.py. */

export const DEFINITIONS = "definitions";
export const NON_FUNCTIONAL_REQUIREMENTS = "implementation reqs";
export const TEST_REQUIREMENTS = "test reqs";
export const FUNCTIONAL_REQUIREMENTS = "functional specs";
export const ACCEPTANCE_TESTS = "acceptance_tests";
export const ACCEPTANCE_TEST_HEADING = "acceptance tests";

export const ALLOWED_SPECIFICATION_HEADINGS = [
  DEFINITIONS,
  NON_FUNCTIONAL_REQUIREMENTS,
  TEST_REQUIREMENTS,
  FUNCTIONAL_REQUIREMENTS,
  ACCEPTANCE_TEST_HEADING,
];

export const ALLOWED_IMPORT_SPECIFICATION_HEADINGS = [
  DEFINITIONS,
  NON_FUNCTIONAL_REQUIREMENTS,
  TEST_REQUIREMENTS,
];

export interface CodeVariable {
  name: string;
  value: string;
}

export interface SpecificationItem {
  markdown: string;
  linked_resources?: LinkedResource[];
  code_variables?: CodeVariable[];
  [ACCEPTANCE_TESTS]?: SpecificationItem[];
}

/**
 * The marshalled tree: heading -> list of items. Flat: functionalities are numbered 1, 2, 3
 * in the order they appear. Nested sections with dotted ids ("2.3") are not supported.
 */
export interface MarshalledPlainSource {
  [heading: string]: unknown;
}

export function getSpecificationItems(
  tree: MarshalledPlainSource,
  heading: string,
): SpecificationItem[] | undefined {
  const value = tree[heading];
  return Array.isArray(value) ? (value as SpecificationItem[]) : undefined;
}

export function hasAcceptanceTests(tree: MarshalledPlainSource): boolean {
  for (const requirement of getSpecificationItems(tree, FUNCTIONAL_REQUIREMENTS) ?? []) {
    const tests = requirement[ACCEPTANCE_TESTS];
    if (tests !== undefined && tests.length > 0) return true;
  }
  return false;
}

export interface CollectedLinkedResource extends LinkedResource {
  sections: string[];
}

export function collectSpecificationLinkedResources(
  specification: SpecificationItem,
  specificationHeading: string,
  linkedResourcesList: CollectedLinkedResource[],
): void {
  for (const resource of specification.linked_resources ?? []) {
    let resourceFound = false;
    for (const resourceMap of linkedResourcesList) {
      if (resource.text === resourceMap.text) {
        if (resource.target !== resourceMap.target) {
          throw new Error(
            `The file ${resource.target} is linked to multiple linked resources with the same text: ${resource.text}`,
          );
        }
      } else if (resource.target === resourceMap.target) {
        if (resource.text !== resourceMap.text) {
          throw new Error(
            `The linked resource ${resource.text} is linked to multiple files: ${resourceMap.target}`,
          );
        }
      } else {
        continue;
      }

      if (resourceFound) {
        throw new Error(`Duplicate linked resource found: ${resource.text} (${resource.target})`);
      }

      resourceFound = true;
      resourceMap.sections.push(specificationHeading);
    }

    if (!resourceFound) {
      linkedResourcesList.push({
        text: resource.text,
        target: resource.target,
        sections: [specificationHeading],
      });
    }
  }
}

export function collectLinkedResourcesInSection(
  section: MarshalledPlainSource,
  linkedResourcesList: CollectedLinkedResource[],
  specificationsList: string[] | null,
  includeAcceptanceTests: boolean,
  frid: string | null,
): boolean {
  let toCollect = [DEFINITIONS, NON_FUNCTIONAL_REQUIREMENTS, TEST_REQUIREMENTS];
  if (specificationsList && specificationsList.length > 0) {
    toCollect = toCollect.filter((heading) => specificationsList.includes(heading));
  }
  for (const heading of toCollect) {
    for (const requirement of getSpecificationItems(section, heading) ?? []) {
      collectSpecificationLinkedResources(requirement, heading, linkedResourcesList);
    }
  }

  const functionalRequirements = getSpecificationItems(section, FUNCTIONAL_REQUIREMENTS);
  if (
    functionalRequirements !== undefined &&
    (!specificationsList ||
      specificationsList.length === 0 ||
      specificationsList.includes(FUNCTIONAL_REQUIREMENTS))
  ) {
    let count = 0;
    for (const requirement of functionalRequirements) {
      collectSpecificationLinkedResources(requirement, FUNCTIONAL_REQUIREMENTS, linkedResourcesList);

      count += 1;
      const currentFrid = String(count);

      const tests = requirement[ACCEPTANCE_TESTS];
      if (tests !== undefined && includeAcceptanceTests && (frid === null || frid === currentFrid)) {
        for (const test of tests) {
          collectSpecificationLinkedResources(test, FUNCTIONAL_REQUIREMENTS, linkedResourcesList);
        }
      }

      // FRIDs increment, so once the requested one is reached nothing after it counts.
      if (frid !== null && currentFrid === frid) return true;
    }
  }

  return false;
}

export function collectLinkedResources(
  tree: MarshalledPlainSource,
  linkedResourcesList: CollectedLinkedResource[],
  specificationsList: string[] | null,
  includeAcceptanceTests: boolean,
  frid: string | null = null,
): boolean {
  if (tree === null || typeof tree !== "object" || Array.isArray(tree)) {
    throw new TypeError("[plain_source_tree must be a dictionary.");
  }

  if (frid !== null && ![...getFrids(tree)].includes(frid)) {
    throw new Error(`frid ${frid} does not exist.`);
  }

  const result = collectLinkedResourcesInSection(
    tree,
    linkedResourcesList,
    specificationsList,
    includeAcceptanceTests,
    frid,
  );

  linkedResourcesList.sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));

  return result;
}

/**
 * The FRID iterator: one functionality ID per functional spec, 1, 2, 3 in order.
 * Everything that walks the spec one functionality at a time - rendering, ranges, context
 * building - is driven by this.
 */
export function* getFrids(tree: MarshalledPlainSource): Generator<string> {
  const functionalRequirements = getSpecificationItems(tree, FUNCTIONAL_REQUIREMENTS) ?? [];
  for (let id = 1; id <= functionalRequirements.length; id += 1) yield String(id);
}

export function getFirstFrid(tree: MarshalledPlainSource): string | null {
  const first = getFrids(tree).next();
  return first.done ? null : first.value;
}

export function getNextFrid(tree: MarshalledPlainSource, frid: string): string | null {
  const iterator = getFrids(tree);
  for (const candidate of iterator) {
    if (candidate === frid) {
      const next = iterator.next();
      return next.done ? null : next.value;
    }
  }
  throw new Error(`Functionality ${frid} does not exist.`);
}

export function getPreviousFrid(tree: MarshalledPlainSource, frid: string): string | null {
  let previous: string | null = null;
  for (const candidate of getFrids(tree)) {
    if (candidate === frid) return previous;
    previous = candidate;
  }
  throw new Error(`Functionality ${frid} does not exist.`);
}

export function getFridsBefore(tree: MarshalledPlainSource, targetFrid: string): string[] {
  const before: string[] = [];
  for (const frid of getFrids(tree)) {
    if (frid === targetFrid) break;
    before.push(frid);
  }
  return before;
}

export function getSpecificationItemMarkdown(
  specificationItem: SpecificationItem,
  codeVariables: Record<string, string>,
  replaceCodeVariables: boolean,
): string {
  let markdown = specificationItem.markdown;
  for (const codeVariable of specificationItem.code_variables ?? []) {
    if (codeVariable.name in codeVariables) {
      if (codeVariables[codeVariable.name] !== codeVariable.value) {
        throw new Error(
          `Code variable ${codeVariable.name} has multiple values: ${codeVariables[codeVariable.name]} and ${codeVariable.value}`,
        );
      }
    } else {
      codeVariables[codeVariable.name] = codeVariable.value;
    }

    if (replaceCodeVariables) {
      markdown = markdown.split(`{{ ${codeVariable.name} }}`).join(codeVariable.value);
    }
  }
  return markdown;
}

export interface Specifications {
  [DEFINITIONS]: string[];
  [NON_FUNCTIONAL_REQUIREMENTS]: string[];
  [TEST_REQUIREMENTS]: string[];
  [FUNCTIONAL_REQUIREMENTS]: string[];
  [ACCEPTANCE_TESTS]?: string[];
}

function getSpecificationsFromPlainSourceTree(
  frid: string,
  tree: MarshalledPlainSource,
  definitions: string[],
  nonFunctionalRequirements: string[],
  testRequirements: string[],
  functionalRequirements: string[],
  acceptanceTests: string[],
  codeVariables: Record<string, string>,
  replaceCodeVariables: boolean,
): string | null {
  let returnFrid: string | null = null;

  const requirements = getSpecificationItems(tree, FUNCTIONAL_REQUIREMENTS);
  if (requirements !== undefined && requirements.length > 0) {
    let count = 0;
    for (const requirement of requirements) {
      count += 1;
      const currentFrid = String(count);

      functionalRequirements.push(
        getSpecificationItemMarkdown(requirement, codeVariables, replaceCodeVariables),
      );

      if (currentFrid === frid) {
        for (const test of requirement[ACCEPTANCE_TESTS] ?? []) {
          acceptanceTests.push(getSpecificationItemMarkdown(test, codeVariables, replaceCodeVariables));
        }
        returnFrid = currentFrid;
        break;
      }
    }
  }

  if (returnFrid !== null) {
    const prepend = (target: string[], heading: string) => {
      const source = getSpecificationItems(tree, heading);
      if (source === undefined) return;
      target.unshift(
        ...source.map((item) => getSpecificationItemMarkdown(item, codeVariables, replaceCodeVariables)),
      );
    };
    prepend(definitions, DEFINITIONS);
    prepend(nonFunctionalRequirements, NON_FUNCTIONAL_REQUIREMENTS);
    prepend(testRequirements, TEST_REQUIREMENTS);
  }

  return returnFrid;
}

/**
 * Build the rendering context for one functionality: every definition and
 * implementation/test req in scope, the functionalities up to and including this one,
 * and this one's acceptance tests.
 */
export function getSpecificationsForFrid(
  tree: MarshalledPlainSource,
  frid: string,
  replaceCodeVariables = true,
): [Specifications, Record<string, string> | null] {
  const definitions: string[] = [];
  const nonFunctionalRequirements: string[] = [];
  const testRequirements: string[] = [];
  const functionalRequirements: string[] = [];
  const acceptanceTests: string[] = [];
  const codeVariables: Record<string, string> = {};

  const result = getSpecificationsFromPlainSourceTree(
    frid,
    tree,
    definitions,
    nonFunctionalRequirements,
    testRequirements,
    functionalRequirements,
    acceptanceTests,
    codeVariables,
    replaceCodeVariables,
  );
  if (result === null) throw new Error(`Functionality ${frid} does not exist.`);

  const specifications: Specifications = {
    [DEFINITIONS]: definitions,
    [NON_FUNCTIONAL_REQUIREMENTS]: nonFunctionalRequirements,
    [TEST_REQUIREMENTS]: testRequirements,
    [FUNCTIONAL_REQUIREMENTS]: functionalRequirements,
  };

  if (acceptanceTests.length > 0) specifications[ACCEPTANCE_TESTS] = acceptanceTests;

  return [specifications, Object.keys(codeVariables).length > 0 ? codeVariables : null];
}

/** Iterate every functionality with the context that should be rendered for it. */
export function* iterateFunctionalSpecs(
  tree: MarshalledPlainSource,
  replaceCodeVariables = true,
): Generator<{ frid: string; specifications: Specifications; codeVariables: Record<string, string> | null }> {
  for (const frid of getFrids(tree)) {
    const [specifications, codeVariables] = getSpecificationsForFrid(tree, frid, replaceCodeVariables);
    yield { frid, specifications, codeVariables };
  }
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function getHashValue(specifications: unknown): string {
  return hashText(JSON.stringify(specifications, null, 4));
}

function getFridsRange(tree: MarshalledPlainSource, start: string, end?: string): string[] {
  const frids = [...getFrids(tree)];
  start = String(start);

  if (!frids.includes(start)) {
    throw new InvalidFridArgument(
      `Invalid start functionality ID: ${start}. Valid IDs are: ${JSON.stringify(frids)}.`,
    );
  }

  let endIdx: number;
  if (end !== undefined) {
    end = String(end);
    if (!frids.includes(end)) {
      throw new InvalidFridArgument(
        `Invalid end functionality ID: ${end}. Valid IDs are: ${JSON.stringify(frids)}.`,
      );
    }
    endIdx = frids.indexOf(end) + 1;
  } else {
    endIdx = frids.length;
  }

  const startIdx = frids.indexOf(start);
  if (startIdx >= endIdx) {
    throw new InvalidFridArgument(
      `Start functionality ID: ${start} must be before end functionality ID: ${end}.`,
    );
  }

  return frids.slice(startIdx, endIdx);
}

export function getRenderRange(renderRange: string, tree: MarshalledPlainSource): string[] {
  const parts = renderRange.split(",");
  const rangeEnd = parts.length === 2 ? parts[1]! : parts[0]!;
  return getFridsRange(tree, parts[0]!, rangeEnd);
}

export function getRenderRangeFrom(start: string, tree: MarshalledPlainSource): string[] {
  return getFridsRange(tree, start);
}
