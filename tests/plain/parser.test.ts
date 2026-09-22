import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  normalizeLineEndings,
  parsePlainSource,
  plainFileParser,
  validateFunctionalitiesHaveImplementationReqs,
  type ParsedPlainSource,
} from "../../src/plain/parser.ts";
import { renderPlainSource } from "../../src/plain/liquid.ts";
import { getLoadedTemplates } from "../../src/plain/files.ts";
import {
  DEFINITIONS,
  FUNCTIONAL_REQUIREMENTS,
  NON_FUNCTIONAL_REQUIREMENTS,
  getSpecificationItems,
} from "../../src/plain/spec.ts";
import { MissingFunctionalitiesError, PlainSyntaxError } from "../../src/plain/errors.ts";

/** Mirrors the get_test_data_path / load_test_data pytest fixtures. */
const dataPath = (subfolder: string) => `tests/${subfolder}`;
const loadTestData = (relative: string) => readFileSync(`tests/${relative}`, "utf8");

/** Port of tests/test_plainfileparser.py. */
describe("plain file parser", () => {
  it("parses a regular plain source", () => {
    const [, plainSections] = plainFileParser("regular_plain_source.plain", [
      dataPath("data/plainfileparser"),
    ]);
    expect(plainSections).toEqual({
      definitions: [],
      "implementation reqs": [
        { markdown: "- First implementation requirement." },
        { markdown: "- Second implementation requirement." },
      ],
      "functional specs": [{ markdown: '- Display "hello, world"' }],
    });
  });

  it("rejects an unknown section", () => {
    const plainSource = `
***definitions***

***Unknown Section:***
`;
    expect(() => parsePlainSource(plainSource, {}, [], [], [])).toThrow(
      "Syntax error at line 4: Invalid specification heading (`Unknown Section:`). Allowed headings: definitions, implementation reqs, test reqs, functional specs, acceptance tests",
    );
  });

  it("rejects a duplicate section", () => {
    const plainSource = `
***definitions***

***definitions***
`;
    expect(() => parsePlainSource(plainSource, {}, [], [], [])).toThrow(
      "Syntax error at line 4: Duplicate specification heading (`definitions`)",
    );
  });

  it("rejects an invalid top level element", () => {
    const plainSource = `
***definitions***
\`\`\`
code block
\`\`\`
`;
    expect(() => parsePlainSource(plainSource, {}, [], [], [])).toThrow(
      "Syntax error at line 3: Invalid source structure  (`code block`)",
    );
  });

  it("reports a line number that accounts for frontmatter", () => {
    const plainSource = `---
description: 'Plain file with frontmatter'
---

***definitions***

***Unknown Section:***
`;
    expect(() => parsePlainSource(plainSource, {}, [], [], [])).toThrow(
      "Syntax error at line 7: Invalid specification heading (`Unknown Section:`)",
    );
  });

  it("reports a line number with windows line endings", () => {
    const plainSource =
      "---\r\n" +
      "description: 'Plain file with frontmatter'\r\n" +
      "---\r\n" +
      "\r\n" +
      "***definitions***\r\n" +
      "\r\n" +
      "***Unknown Section:***\r\n";
    expect(() => parsePlainSource(plainSource, {}, [], [], [])).toThrow(
      "Syntax error at line 7: Invalid specification heading (`Unknown Section:`)",
    );
  });

  it("normalizes line endings without duplicating newlines", () => {
    expect(normalizeLineEndings("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("drops commented requirements", () => {
    const [, plainSections] = plainFileParser("plain_file_parser_with_comments.plain", [
      dataPath("data/plainfileparser"),
    ]);
    expect(plainSections).toEqual({
      definitions: [],
      "implementation reqs": [{ markdown: "- Second implementation requirement." }],
      "functional specs": [{ markdown: '- Display "hello, world"' }],
    });
  });

  it("drops indented comments", () => {
    const [, plainSections] = plainFileParser("plain_file_with_comments_indented.plain", [
      dataPath("data/plainfileparser"),
    ]);
    expect(plainSections).toEqual({
      definitions: [],
      "implementation reqs": [
        { markdown: "- First implementation requirement." },
        { markdown: "- Second implementation requirement." },
      ],
      "functional specs": [{ markdown: '- Display "hello, world"' }],
    });
  });

  it("rejects a url link", () => {
    expect(() => plainFileParser("plain_source_with_url_link.plain", [dataPath("data/plainfile")])).toThrow(
      "Only relative links are allowed",
    );
  });

  it("rejects an absolute link", () => {
    expect(() =>
      plainFileParser("plain_source_with_absolute_link.plain", [dataPath("data/plainfile")]),
    ).toThrow("Only relative links are allowed");
  });

  it("parses reference links", () => {
    const [, plainSections] = plainFileParser("task_manager_with_reference_links.plain", [
      dataPath("data/plainfile"),
    ]);

    const assertedResources = [
      "tests/data/plainfile/task_list_ui_specification.yaml",
      "tests/data/plainfile/add_new_task_modal_specification.yaml",
    ];
    const functionalSpecs = getSpecificationItems(plainSections, FUNCTIONAL_REQUIREMENTS)!;

    for (const functionalRequirement of functionalSpecs) {
      for (const resource of functionalRequirement.linked_resources ?? []) {
        expect(assertedResources).toContain(resource.target);
        assertedResources.splice(assertedResources.indexOf(resource.target), 1);
        expect(/^[A-Za-z][A-Za-z0-9+.-]*:/.test(resource.target)).toBe(false);
        expect(resource.target.startsWith("/")).toBe(false);
      }
    }
    expect(assertedResources).toEqual([]);

    const allMarkdown = functionalSpecs.map((item) => item.markdown).join("\n");
    expect(allMarkdown).toContain("`[resource]task_list_ui_specification.yaml`");
    expect(allMarkdown).toContain("`[resource]add_new_task_modal_specification.yaml`");

    expect(functionalSpecs[1]!.linked_resources).toEqual([
      {
        text: "task_list_ui_specification.yaml",
        target: "tests/data/plainfile/task_list_ui_specification.yaml",
      },
    ]);
    expect(functionalSpecs[2]!.linked_resources).toEqual([
      {
        text: "add_new_task_modal_specification.yaml",
        target: "tests/data/plainfile/add_new_task_modal_specification.yaml",
      },
    ]);
  });

  it("rejects an invalid specification order", () => {
    expect(() => plainFileParser("invalid_specification_order.plain", [dataPath("data/plainfile")])).toThrow(
      "Syntax error at line 6: Definitions specification must be the first specification in the section",
    );
  });

  it("rejects a duplicate specification heading in a file", () => {
    expect(() =>
      plainFileParser("duplicate_specification_heading.plain", [dataPath("data/plainfile")]),
    ).toThrow("Syntax error at line 6: Duplicate specification heading (`definitions`)");
  });

  it("rejects missing implementation reqs", () => {
    expect(() =>
      plainFileParser("missing_non_functional_requirements.plain", [dataPath("data/plainfile")]),
    ).toThrow("defines functionalities but specifies no implementation reqs");
  });

  it("rejects a file without implementation reqs", () => {
    expect(() =>
      plainFileParser("without_non_functional_requirement.plain", [dataPath("data/plainfile")]),
    ).toThrow("defines functionalities but specifies no implementation reqs");
  });

  it("adds a hint about requires when implementation reqs are missing", () => {
    const plainSource: ParsedPlainSource = { [NON_FUNCTIONAL_REQUIREMENTS]: null };
    expect(() => validateFunctionalitiesHaveImplementationReqs(plainSource, "my_app", true)).toThrow(
      "not inherited through 'requires'",
    );
  });

  it("omits the requires hint when the module has no requires", () => {
    const plainSource: ParsedPlainSource = { [NON_FUNCTIONAL_REQUIREMENTS]: null };
    let message = "";
    try {
      validateFunctionalitiesHaveImplementationReqs(plainSource, "my_app", false);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain("requires");
  });

  it("rejects a module with no functional specs section", () => {
    expect(() => plainFileParser("no_functional_specs_section.plain", [dataPath("data/plainfile")])).toThrow(
      MissingFunctionalitiesError,
    );
  });

  it("rejects an empty functional specs section", () => {
    expect(() =>
      plainFileParser("empty_functional_specs_section.plain", [dataPath("data/plainfile")]),
    ).toThrow("has an empty 'functional specs' section");
  });

  it("renders indented include tags", () => {
    const plainSource = `# Main

***definitions***

- This is a definition.

***implementation reqs***
- First implementation requirement.
- Second implementation requirement.

> This is a comment
> This is a with an include tag {% include "template.plain" %}

***functional specs***
- Implement {% include "implement.plain" %}
{% include "template.plain" %}
- Display "hello, world"
    {% include "template.plain" %}
        {% include "template.plain" %}
    - Implement {% include "implement.plain" %}
`;
    const loadedTemplates = {
      "template.plain": "- This is a functionality inside a template.",
      "implement.plain": `something nice and useful
    - the nice thing should be really nice
    - the useful thing should be really useful`,
    };

    const expectedRendered = `# Main

***definitions***

- This is a definition.

***implementation reqs***
- First implementation requirement.
- Second implementation requirement.

> This is a comment
> This is a with an include tag {% include 'template.plain' %}

***functional specs***
- Implement something nice and useful
    - the nice thing should be really nice
    - the useful thing should be really useful
- This is a functionality inside a template.
- Display "hello, world"
    - This is a functionality inside a template.
        - This is a functionality inside a template.
    - Implement something nice and useful
        - the nice thing should be really nice
        - the useful thing should be really useful
`;

    expect(renderPlainSource(plainSource, loadedTemplates, {})).toBe(expectedRendered);

    // The Python test patches the loader; here the templates are read from disk and the
    // tracking loader is exercised for real.
    const [renderedFromDisk, loadedFromDisk] = getLoadedTemplates(
      [dataPath("data/templates")],
      `{% include "implement.plain", variable_name: "nice" %}\n`,
    );
    expect(renderedFromDisk).toContain("something nice and useful");
    expect(Object.keys(loadedFromDisk)).toEqual(["implement.plain"]);
  });

  it("collects code variables", () => {
    const plainSourceText = loadTestData("data/templates/code_variables.plain");
    const loadedTemplates = { "implement.plain": loadTestData("data/templates/implement.plain") };

    const codeVariables: Record<string, Record<string, string>> = {};
    const rendered = renderPlainSource(plainSourceText, loadedTemplates, codeVariables);
    const keys = Object.keys(codeVariables);

    expect(rendered).toBe(`***definitions***

- :concept: is a concept.

***implementation reqs***
- First implementation requirement.
- Second implementation requirement.

***functional specs***
- Implement something nice and useful
    - the nice thing should be really ${keys[0]}
    - the useful thing should be really useful
`);

    const [, parsed] = plainFileParser("code_variables.plain", [dataPath("data/templates")]);
    expect(parsed).toEqual({
      definitions: [{ markdown: "- :concept: is a concept." }],
      "implementation reqs": [
        { markdown: "- First implementation requirement." },
        { markdown: "- Second implementation requirement." },
      ],
      "functional specs": [
        {
          markdown:
            "- Implement something nice and useful\n    - the nice thing should be really {{ variable_name }}\n    - the useful thing should be really useful",
          code_variables: [{ name: "variable_name", value: "nice" }],
        },
      ],
    });
  });

  it("collects code variables through a template include", () => {
    const plainSourceText = loadTestData("data/templates/template_include.plain");
    const loadedTemplates = {
      "header.plain": loadTestData("data/templates/header.plain"),
      "implement_2.plain": loadTestData("data/templates/implement_2.plain"),
    };

    const codeVariables: Record<string, Record<string, string>> = {};
    const rendered = renderPlainSource(plainSourceText, loadedTemplates, codeVariables);
    const keys = Object.keys(codeVariables);

    expect(rendered).toBe(`***definitions***

- :concept: is a concept.

***implementation reqs***
- First implementation requirement ${keys[0]}.
- Second implementation requirement ${keys[1]}.

***functional specs***
- Implement something nice and useful
    - the nice thing should be really ${keys[2]}
    - the useful thing should be really useful
`);

    const [, parsed] = plainFileParser("template_include.plain", [dataPath("data/templates")]);
    expect(parsed).toEqual({
      definitions: [{ markdown: "- :concept: is a concept." }],
      "implementation reqs": [
        {
          markdown: "- First implementation requirement {{ variable_name_1 }}.",
          code_variables: [{ name: "variable_name_1", value: "nice_1" }],
        },
        {
          markdown: "- Second implementation requirement {{ variable_name_1 }}.",
          code_variables: [{ name: "variable_name_1", value: "nice_2" }],
        },
      ],
      "functional specs": [
        {
          markdown:
            "- Implement something nice and useful\n    - the nice thing should be really {{ variable_name_1 }}\n    - the useful thing should be really useful",
          code_variables: [{ name: "variable_name_1", value: "nice" }],
        },
      ],
    });
  });

  it("keeps structure for a block level include with a trailing newline", () => {
    expect(() => plainFileParser("block_level_include.plain", [dataPath("data/templates")])).not.toThrow();
  });

  it("rejects top level acceptance tests", () => {
    const plainSource = `
***acceptance tests***

- Test something.
`;
    expect(() => parsePlainSource(plainSource, {}, [], [], [])).toThrow(
      "Syntax error at line 2: acceptance tests heading should be nested under specific functional spec.",
    );
  });

  it("rejects top level acceptance tests after other headings", () => {
    const plainSource = `***definitions***

- :concept: is a concept.

***acceptance tests***

- Test something.
`;
    expect(() => parsePlainSource(plainSource, {}, [], [], [])).toThrow(
      "Syntax error at line 5: acceptance tests heading should be nested under specific functional spec.",
    );
  });

  it("rejects acceptance tests nested under definitions", () => {
    const plainSource = `***definitions***

- :concept: is a concept.

    ***acceptance tests***

    - Test the :concept:.

***functional specs***

- Display "hello, world"
`;
    expect(() => parsePlainSource(plainSource, {}, [], [], [])).toThrow(
      "Syntax error at line 5: acceptance tests heading should be nested under specific functional spec.",
    );
  });

  it("rejects acceptance tests nested under implementation reqs", () => {
    const plainSource = `***implementation reqs***

- First implementation requirement.

    ***acceptance tests***

    - Test something.
`;
    expect(() => parsePlainSource(plainSource, {}, [], [], [])).toThrow(
      "Syntax error at line 5: acceptance tests heading should be nested under specific functional spec.",
    );
  });

  it("rejects acceptance tests nested under test reqs", () => {
    const plainSource = `***test reqs***

- First test requirement.

    ***acceptance tests***

    - Test something.
`;
    expect(() => parsePlainSource(plainSource, {}, [], [], [])).toThrow(
      "Syntax error at line 5: acceptance tests heading should be nested under specific functional spec.",
    );
  });

  it("allows acceptance tests nested under a functional spec", () => {
    const plainSource = `***definitions***

- :concept: is a concept.

***functional specs***

- Display "hello, world"

    ***acceptance tests***

    - Test the :concept:.
`;
    const result = parsePlainSource(plainSource, {}, [], [], []);
    expect(FUNCTIONAL_REQUIREMENTS in result.plainSource).toBe(true);
  });

  describe("concept validation", () => {
    const parse = (name: string) => plainFileParser(name, [dataPath("data/plainfileparser")]);

    it("accepts valid definitions and rejects malformed ones", () => {
      expect(() => parse("concept_validation_definition.plain")).not.toThrow();
      expect(() => parse("concept_validation_noconcepts.plain")).toThrow(PlainSyntaxError);
    });

    it("checks concept usage", () => {
      expect(() => parse("concept_validation_valid.plain")).not.toThrow();
      expect(() => parse("concept_validation_nondefined.plain")).toThrow(PlainSyntaxError);
      expect(() => parse("concept_validation_defined_nondefined.plain")).toThrow(PlainSyntaxError);
      expect(() => parse("concept_validation_defined_nondefined_2.plain")).toThrow(PlainSyntaxError);
    });

    it("rejects redefinition", () => {
      expect(() => parse("concept_validation_redefinition.plain")).toThrow(PlainSyntaxError);
    });

    it("allows non-concept usage", () => {
      expect(() => parse("concept_validation_nonconcept.plain")).not.toThrow();
    });

    it("allows several concepts in one definition", () => {
      expect(() => parse("concept_validation_several_concepts.plain")).not.toThrow();
    });

    it("validates concepts inside acceptance tests", () => {
      expect(() => parse("concept_validation_acceptance_tests.plain")).not.toThrow();
      expect(() => parse("concept_validation_acceptance_tests_nondefined.plain")).toThrow(PlainSyntaxError);
    });
  });

  describe("module directives", () => {
    const parse = (name: string) => plainFileParser(name, [dataPath("data/plainfileparser")]);

    it("resolves required concepts", () => {
      expect(() => parse("required_concepts_example.plain")).not.toThrow();
      expect(() => parse("required_concepts_module.plain")).not.toThrow();
      expect(() => parse("required_concepts_partial.plain")).not.toThrow();
      expect(() => parse("required_concepts_missing.plain")).toThrow(PlainSyntaxError);
      expect(() => parse("required_concepts_partial_duplicate.plain")).toThrow(PlainSyntaxError);
    });

    it("resolves exported concepts", () => {
      expect(() => parse("exported_concepts_example.plain")).not.toThrow();
      expect(() => parse("exported_concepts_nested_example.plain")).not.toThrow();
      expect(() => parse("exported_concepts_missing_example.plain")).toThrow(PlainSyntaxError);
      expect(() => parse("exported_concepts_transitive_example.plain")).toThrow(PlainSyntaxError);
    });
  });

  it("sorts definitions topologically", () => {
    const [, plainSource] = plainFileParser("topological_sort.plain", [dataPath("data/plainfileparser")]);
    expect(DEFINITIONS in plainSource).toBe(true);
    expect(plainSource[DEFINITIONS]).toEqual([
      { markdown: "- :Concept1: is a concept." },
      { markdown: "- :Concept2: is a concept that depends on the :Concept1: concept." },
      { markdown: "- :Concept3: is a concept that depends on both the :Concept1: and :Concept2: concepts." },
    ]);
  });

  it("sorts definitions topologically including unreferenced concepts", () => {
    const [, plainSource] = plainFileParser("topological_sort_not_referenced.plain", [
      dataPath("data/plainfileparser"),
    ]);
    expect(plainSource[DEFINITIONS]).toEqual([
      { markdown: "- :Concept1: is a concept." },
      { markdown: "- :NonReferencedConcept: is a concept." },
      { markdown: "- :Concept7: is a concept." },
      { markdown: "- :Concept2: is a concept that depends on the :Concept1: concept." },
      { markdown: "- :Concept8: is a concept that depends on the :Concept1: concept." },
      { markdown: "- :Concept5: is a concept that depends on the :Concept1: concept." },
      { markdown: "- :Concept3: is a concept that depends on both the :Concept1: and :Concept2: concepts." },
      { markdown: "- :Concept9: is a concept that depends on the :Concept8:." },
      { markdown: "- :Concept4: is a concept that depends on the :Concept3: concept." },
      { markdown: "- :Concept6: is a concept that depends on the :Concept1: and :Concept4: concepts." },
    ]);
  });

  it("rejects a non .plain extension", () => {
    expect(() => plainFileParser("test.txt", [])).toThrow(PlainSyntaxError);
  });
});
