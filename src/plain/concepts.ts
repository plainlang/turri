import { PlainSyntaxError } from "./errors.ts";
import { renderToMarkdown, type AnyNode, type Section } from "./markdown.ts";
import {
  ACCEPTANCE_TESTS,
  DEFINITIONS,
  FUNCTIONAL_REQUIREMENTS,
  NON_FUNCTIONAL_REQUIREMENTS,
  TEST_REQUIREMENTS,
  getSpecificationItems,
  type MarshalledPlainSource,
  type SpecificationItem,
} from "./spec.ts";

/** Port of concept_utils.py. */

/** Reserved concept names that must not be redefined in the definitions section. */
export const DEFAULT_CONCEPTS = new Set([
  ":ConformanceTests:",
  ":UnitTests:",
  ":AcceptanceTest:",
  ":AcceptanceTests:",
  ":Implementation:",
  ":plainDefinitions:",
  ":plainImplementationReqs:",
  ":plainFunctionality:",
  ":plainTestReqs:",
  ":plainImplementationCode:",
]);

const DEFINITION_PATTERN = /-\s(:[^:]+:)(?:,\s*:[^:]+:)*/;
const CONCEPT_CANDIDATE_PATTERN = /:[^:]+:/g;
const VALID_CONCEPT_PATTERN = /^:[+\-.0-9A-Z_a-z]+:/;
const SPEC_CONCEPT_PATTERN = /:[+\-.0-9A-Z_a-z]+:/g;

export function extractConceptsFromDefinition(text: string): [string[], string[]] {
  const match = DEFINITION_PATTERN.exec(text);
  if (!match) {
    return [
      [],
      [
        `Syntax error: Invalid definition specification text: ${text}. Should start with \`- :<concept>:\` ` +
          "(where <concept> is any string that does not contain `:`).",
      ],
    ];
  }

  const candidates = match[0].match(CONCEPT_CANDIDATE_PATTERN) ?? [];
  const valid: string[] = [];
  const errors: string[] = [];
  for (const candidate of candidates) {
    if (VALID_CONCEPT_PATTERN.test(candidate)) {
      valid.push(candidate);
    } else {
      errors.push(
        `Syntax error: Invalid concept: ${candidate}. Should contain only letters, numbers, hyphens and dots.`,
      );
    }
  }
  return [valid, errors];
}

export function extractConceptsFromSpecText(text: string): string[] {
  return text.match(SPEC_CONCEPT_PATTERN) ?? [];
}

export function collectConcepts(plainSource: MarshalledPlainSource): [string[], string[]] {
  const definitions = getSpecificationItems(plainSource, DEFINITIONS);
  if (definitions === undefined) return [[], []];

  const concepts: string[] = [];
  const errors: string[] = [];
  for (const definition of definitions) {
    const [newConcepts, newErrors] = extractConceptsFromDefinition(definition.markdown);
    errors.push(...newErrors);
    concepts.push(...newConcepts);
  }
  return [concepts, errors];
}

function validateConceptsInSpec(spec: SpecificationItem, concepts: Set<string>, specGroup: string): string[] {
  const errors: string[] = [];
  for (const used of extractConceptsFromSpecText(spec.markdown)) {
    if (!concepts.has(used) && !DEFAULT_CONCEPTS.has(used)) {
      errors.push(
        `Syntax error: Concept ${used} is not defined in the definitions. ${specGroup}: ${spec.markdown}`,
      );
    }
  }
  return errors;
}

function validateConceptsInSpecGroup(
  specGroup: string,
  plainSource: MarshalledPlainSource,
  concepts: Set<string>,
): string[] {
  const specs = getSpecificationItems(plainSource, specGroup);
  if (specs === undefined) return [];
  return specs.flatMap((spec) => validateConceptsInSpec(spec, concepts, specGroup));
}

export function validateConcepts(marshalled: MarshalledPlainSource): string[] {
  const errors: string[] = [];
  const concepts = new Set(DEFAULT_CONCEPTS);

  const [newConcepts, newErrors] = collectConcepts(marshalled);
  errors.push(...newErrors);

  const uniqueNewConcepts = new Set(newConcepts);
  const intersection = [...uniqueNewConcepts].filter((c) => concepts.has(c));

  if (uniqueNewConcepts.size < newConcepts.length || intersection.length > 0) {
    const misused = new Set(newConcepts.filter((c) => newConcepts.filter((o) => o === c).length > 1));
    for (const c of intersection) misused.add(c);
    errors.push(`Syntax error: Concepts were defined multiple times: ${[...misused].join(", ")} .`);
  }

  const treeBasedConcepts = new Set([...DEFAULT_CONCEPTS, ...uniqueNewConcepts]);

  for (const specGroup of [
    NON_FUNCTIONAL_REQUIREMENTS,
    TEST_REQUIREMENTS,
    FUNCTIONAL_REQUIREMENTS,
    DEFINITIONS,
  ]) {
    errors.push(...validateConceptsInSpecGroup(specGroup, marshalled, treeBasedConcepts));
  }

  for (const funcSpec of getSpecificationItems(marshalled, FUNCTIONAL_REQUIREMENTS) ?? []) {
    for (const test of funcSpec[ACCEPTANCE_TESTS] ?? []) {
      errors.push(...validateConceptsInSpec(test, treeBasedConcepts, ACCEPTANCE_TESTS));
    }
  }

  return errors;
}

export function findConceptDefinitionsInPlainSource(concept: string, definitions: Section | null): AnyNode[] {
  const found: AnyNode[] = [];
  if (definitions === null) return found;

  for (const definition of definitions.children) {
    const rendered = renderToMarkdown(definition);
    const [definedConcepts] = extractConceptsFromDefinition(rendered);
    if (!definedConcepts.includes(concept)) continue;

    found.push(definition);
    const usedConcepts = extractConceptsFromSpecText(rendered).filter(
      (used) => used !== concept && !DEFAULT_CONCEPTS.has(used),
    );
    for (const used of usedConcepts) {
      found.push(...findConceptDefinitionsInPlainSource(used, definitions));
    }
  }

  return found;
}

function buildAdjacencyList(
  definitions: SpecificationItem[],
): [Map<string, string[]>, Map<string, SpecificationItem>] {
  const adjacency = new Map<string, string[]>();
  const conceptDefinitions = new Map<string, SpecificationItem>();

  for (const definition of definitions) {
    const text = definition.markdown;
    const [newConcepts] = extractConceptsFromDefinition(text);
    const usedConcepts = new Set(
      extractConceptsFromSpecText(text).filter(
        (used) => !newConcepts.includes(used) && !DEFAULT_CONCEPTS.has(used),
      ),
    );

    for (const newConcept of newConcepts) {
      if (!adjacency.has(newConcept)) adjacency.set(newConcept, []);
    }
    for (const used of usedConcepts) {
      if (!adjacency.has(used)) adjacency.set(used, []);
      adjacency.get(used)!.push(...newConcepts);
    }
    for (const newConcept of newConcepts) {
      conceptDefinitions.set(newConcept, definition);
    }
  }

  return [adjacency, conceptDefinitions];
}

/**
 * networkx's topological_sort, reproduced.
 *
 * It flattens `topological_generations`, which is Kahn's algorithm processed one
 * generation at a time with nodes visited in graph insertion order. The ordering of
 * independent concepts therefore depends on insertion order, and the Python tests
 * assert that exact order - a generic topological sort would pass the dependency
 * constraints but produce a different sequence.
 */
function topologicalSort(successors: Map<string, string[]>): { order: string[]; cycle: string[] | null } {
  const inDegree = new Map<string, number>();
  for (const node of successors.keys()) inDegree.set(node, 0);
  for (const [, targets] of successors) {
    for (const target of targets) inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
  }

  let generation = [...successors.keys()].filter((node) => (inDegree.get(node) ?? 0) === 0);
  const order: string[] = [];
  const remaining = new Map(inDegree);
  for (const node of generation) remaining.delete(node);

  while (generation.length > 0) {
    const next: string[] = [];
    for (const node of generation) {
      order.push(node);
      for (const child of successors.get(node) ?? []) {
        const degree = (remaining.get(child) ?? 0) - 1;
        remaining.set(child, degree);
        if (degree === 0) {
          next.push(child);
          remaining.delete(child);
        }
      }
    }
    generation = next;
  }

  if (remaining.size > 0) return { order, cycle: [...remaining.keys()] };
  return { order, cycle: null };
}

export function sortDefinitions(definitions: SpecificationItem[]): void {
  if (definitions.length <= 1) return;

  const [adjacency, conceptDefinitions] = buildAdjacencyList(definitions);
  const { order, cycle } = topologicalSort(adjacency);

  if (cycle !== null) {
    let msg = "Found cycles in the concept graph. Cycles are not allowed.";
    const cyclicDefinitions = cycle
      .slice(0, 2)
      .map((concept) => conceptDefinitions.get(concept)?.markdown)
      .filter((markdown): markdown is string => markdown !== undefined);
    msg += "Cyclic definitons:\n";
    msg += cyclicDefinitions.join("\n");
    msg += "\n";
    throw new PlainSyntaxError(`Plain syntax error: ${msg}`);
  }

  if (order.length === 0) return;

  const definitionOrder = new Map<SpecificationItem, number>();
  order.forEach((concept, index) => {
    // Python keys this map by definition and lets later concepts overwrite, so a
    // definition that introduces several concepts takes the index of its last one.
    const definition = conceptDefinitions.get(concept);
    if (definition !== undefined) definitionOrder.set(definition, index);
  });

  definitions.sort((a, b) => (definitionOrder.get(a) ?? 0) - (definitionOrder.get(b) ?? 0));
}
