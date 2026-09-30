import {
  DEFINITIONS,
  getSpecificationItemMarkdown,
  NON_FUNCTIONAL_REQUIREMENTS,
  TEST_REQUIREMENTS,
  type MarshalledPlainSource,
} from "../plain/spec.ts";

/**
 * A module's spec as the prompts read it: the sections every functional spec shares, and a
 * functional spec a module inherits. What the code and the tests are built from is in `records.ts`.
 */

/** The sections a module shares across all its functionalities, as text. */
export interface SharedSections {
  [DEFINITIONS]: string[];
  [NON_FUNCTIONAL_REQUIREMENTS]: string[];
  [TEST_REQUIREMENTS]: string[];
}

/** A functional spec of a module this one requires: documented, not built here. */
export interface RequiredSpec {
  module: string;
  frid: string;
  spec: string;
  acceptanceTests?: string[];
}

/** A module's shared sections as they stand, with or without a functional spec to read them through. */
export function sectionsOf(tree: MarshalledPlainSource): SharedSections {
  const render = (heading: string) =>
    ((tree[heading] as Array<Parameters<typeof getSpecificationItemMarkdown>[0]> | undefined) ?? []).map((item) =>
      getSpecificationItemMarkdown(item, {}, true),
    );
  return {
    [DEFINITIONS]: render(DEFINITIONS),
    [NON_FUNCTIONAL_REQUIREMENTS]: render(NON_FUNCTIONAL_REQUIREMENTS),
    [TEST_REQUIREMENTS]: render(TEST_REQUIREMENTS),
  };
}
