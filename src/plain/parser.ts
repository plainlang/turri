import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { extname, isAbsolute, basename, resolve } from "node:path";
import { load as loadYaml } from "js-yaml";
import {
  extractConceptsFromDefinition,
  findConceptDefinitionsInPlainSource,
  sortDefinitions,
  validateConcepts,
  DEFAULT_CONCEPTS,
} from "./concepts.ts";
import {
  ImportedModuleWithFunctionalitiesError,
  MissingFunctionalitiesError,
  ModuleDoesNotExistError,
  PlainSyntaxError,
  UnsupportedBase64Content,
} from "./errors.ts";
import { findLargeBase64Blob, getLoadedTemplates, openFrom } from "./files.ts";
import { renderPlainSource } from "./liquid.ts";
import { isStdlibModule, readStdlibModule } from "./stdlib.ts";
import {
  getRawText,
  lineNumber,
  parseMarkdown,
  removeQuotes,
  renderToMarkdown,
  traverse,
  type AnyNode,
  type LinkedResource,
  type Section,
} from "./markdown.ts";
import {
  ACCEPTANCE_TESTS,
  ACCEPTANCE_TEST_HEADING,
  ALLOWED_IMPORT_SPECIFICATION_HEADINGS,
  ALLOWED_SPECIFICATION_HEADINGS,
  DEFINITIONS,
  FUNCTIONAL_REQUIREMENTS,
  NON_FUNCTIONAL_REQUIREMENTS,
  TEST_REQUIREMENTS,
  getSpecificationItems,
  REQUIRED_FUNCTIONAL_SPECS,
  type InheritedSpecificationItem,
  type MarshalledPlainSource,
  type SpecificationItem,
} from "./spec.ts";

export const IMPORT_DIRECTIVE = "import";
export const REQUIRES_DIRECTIVE = "requires";
export const REQUIRED_CONCEPTS_DIRECTIVE = "required_concepts";
export const EXPORTED_CONCEPTS_DIRECTIVE = "exported_concepts";

export const PLAIN_SOURCE_FILE_EXTENSION = ".plain";

/** definitions / implementation reqs / test reqs always exist as keys; functional specs does not. */
export type ParsedPlainSource = Record<string, Section | null | undefined>;

function newPlainSource(): ParsedPlainSource {
  return {
    [DEFINITIONS]: null,
    [NON_FUNCTIONAL_REQUIREMENTS]: null,
    [TEST_REQUIREMENTS]: null,
  };
}

export interface FrontmatterPost {
  metadata: Record<string, unknown>;
  content: string;
}

export interface PlainFileParseResult {
  plainSource: ParsedPlainSource;
  plainSourceObj: FrontmatterPost;
  requiredModules: string[];
  requiredConcepts: string[];
}

export function getFilenameFromModuleName(moduleName: string): string {
  return `${moduleName}${PLAIN_SOURCE_FILE_EXTENSION}`;
}

export function getModuleNameFromFilename(filename: string): string {
  return filename.split(PLAIN_SOURCE_FILE_EXTENSION).join("");
}

function hasScheme(target: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target);
}

/**
 * A link's file: found where resources are loaded from - the spec's own folder first, then the
 * other template folders - or else from the current directory, as the reference parser has it.
 * Links are relative to the spec, so a spec in a subfolder is checked where it is, wherever
 * turri was started.
 */
function linkedFile(target: string, dirs: string[]): string {
  for (const dir of dirs) {
    const candidate = resolve(dir, target);
    if (existsSync(candidate)) return candidate;
  }
  return target;
}

export function checkSectionForLinkedResources(section: AnyNode, dirs: string[] = []): void {
  const linkedResources: LinkedResource[] = [];

  for (const link of traverse(section, "link")) {
    const target = String(link.url ?? "");
    const children = link.children ?? [];

    if (hasScheme(target) || isAbsolute(target)) {
      const text = (children[0]?.value as string) ?? "";
      throw new PlainSyntaxError(
        `Plain syntax error: Only relative links are allowed (text: ${text}, target: ${target}).`,
      );
    }

    const file = linkedFile(target, dirs);
    if (!existsSync(file)) {
      throw new PlainSyntaxError(`Plain syntax error: Link ${target} does not exist.`);
    }

    if (!statSync(file).isFile()) {
      throw new PlainSyntaxError(`Plain syntax error: Link ${target} must be a file.`);
    }

    if (children.length !== 1) {
      throw new PlainSyntaxError(
        `Plain syntax error: Link must have text specified (link: ${target}).`,
      );
    }

    if (extname(basename(target)) === ".plain") {
      throw new PlainSyntaxError(
        `Referenced resource '${target}' is a .plain file. ` +
          "Referencing .plain files through Linked Resources is not supported. " +
          "Please use the import section to include definitions or implementation/test requirements from another module.",
      );
    }

    linkedResources.push({ text: String(children[0]!.value ?? ""), target });
  }

  if (linkedResources.length > 0) section.linked_resources = linkedResources;
}

export function checkForLinkedResources(plainSource: ParsedPlainSource, dirs: string[] = []): void {
  for (const heading of ALLOWED_SPECIFICATION_HEADINGS) {
    const section = plainSource[heading];
    if (!section) continue;
    for (const requirement of section.children) {
      checkSectionForLinkedResources(requirement, dirs);
      for (const acceptanceTest of requirement[ACCEPTANCE_TESTS] ?? []) {
        checkSectionForLinkedResources(acceptanceTest, dirs);
      }
    }
  }
}

export function processSectionCodeVariables(
  section: SpecificationItem,
  codeVariables: Record<string, Record<string, string>>,
): void {
  if (!("markdown" in section)) return;

  const codeVariablesArray: Array<{ name: string; value: string }> = [];
  for (const [key, value] of Object.entries(codeVariables)) {
    if (!section.markdown.includes(key)) continue;

    const variableName = Object.keys(value)[0]!;
    section.markdown = section.markdown.split(key).join(`{{ ${variableName} }}`);
    codeVariablesArray.push({ name: variableName, value: value[variableName]! });
  }

  if (codeVariablesArray.length > 0) section.code_variables = codeVariablesArray;
}

export function processCodeVariables(
  marshalled: MarshalledPlainSource,
  codeVariables: Record<string, Record<string, string>>,
): void {
  for (const heading of ALLOWED_SPECIFICATION_HEADINGS) {
    for (const requirement of getSpecificationItems(marshalled, heading) ?? []) {
      processSectionCodeVariables(requirement, codeVariables);
    }
  }
}

/** Whether the module declares a ***functional specs*** section (even if it is empty). */
export function hasFunctionalSpecsSection(plainSource: ParsedPlainSource): boolean {
  return FUNCTIONAL_REQUIREMENTS in plainSource;
}

/** Number of functionalities under ***functional specs*** (0 if absent or empty). */
export function countFunctionalities(plainSource: ParsedPlainSource): number {
  const section = plainSource[FUNCTIONAL_REQUIREMENTS];
  return section ? section.children.length : 0;
}

export function validateFunctionalitiesHaveImplementationReqs(
  plainSource: ParsedPlainSource,
  moduleName: string,
  hasRequires = false,
): void {
  const implementationReqs = plainSource[NON_FUNCTIONAL_REQUIREMENTS];
  const hasImplementationReqs = Boolean(implementationReqs && implementationReqs.children.length > 0);

  if (hasImplementationReqs) return;

  let message =
    `Plain syntax error: Module '${moduleName}' defines functionalities but specifies no ` +
    `${NON_FUNCTIONAL_REQUIREMENTS}. At least one implementation req is required.`;
  if (hasRequires) {
    message +=
      " Implementation reqs are not inherited through 'requires' — " +
      "add them to this module, or 'import' a module that provides them.";
  }
  throw new PlainSyntaxError(message);
}

/**
 * Is this token an `acceptance tests` heading?
 *
 * True only for a paragraph holding exactly one emphasis, holding exactly one strong,
 * holding exactly one text node whose content is the heading. Anything that looks like
 * a heading but reads differently comes back as a problem string rather than false, so
 * the caller can reject a near miss instead of silently keeping it.
 */
export function isAcceptanceTestHeading(token: AnyNode): [boolean, string | null] {
  if (token.type !== "paragraph") return [false, null];

  const children = token.children ?? [];
  if (children.length !== 1 || children[0]!.type !== "emphasis") return [false, null];

  const emphasisChildren = children[0]!.children ?? [];
  if (emphasisChildren.length !== 1 || emphasisChildren[0]!.type !== "strong") return [false, null];

  const strongChildren = emphasisChildren[0]!.children ?? [];
  if (strongChildren.length !== 1 || strongChildren[0]!.type !== "text") return [false, null];

  const content = String(strongChildren[0]!.value ?? "").trim();
  if (content === ACCEPTANCE_TEST_HEADING) return [true, null];

  return [
    false,
    `Syntax error at line ${lineNumber(token)}: Invalid acceptance test heading (\`${content}\`). ` +
      `Expected: \`${ACCEPTANCE_TEST_HEADING}.\``,
  ];
}

/** Find an acceptance tests heading anywhere in a subtree. */
export function findAcceptanceTestHeading(token: AnyNode): AnyNode | null {
  const [isHeading] = isAcceptanceTestHeading(token);
  if (isHeading) return token;

  for (const child of token.children ?? []) {
    const found = findAcceptanceTestHeading(child);
    if (found !== null) return found;
  }

  return null;
}

/**
 * Pull the acceptance tests out of one functionality.
 *
 * A functionality with acceptance tests has three children: its own text, the
 * `***acceptance tests***` heading, and the list of tests. The heading and list are
 * lifted onto `acceptance_tests` and removed from the children.
 */
export function processSingleAcceptanceTestRequirement(functionalRequirement: AnyNode): void {
  const newChildren: AnyNode[] = [];
  const children = functionalRequirement.children ?? [];
  let acceptanceTestsFoundAlready = false;

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    const [isHeading, problem] = isAcceptanceTestHeading(child);

    if (problem) {
      // A near-miss heading: `acceptance test` instead of `acceptance tests`, or some
      // other block written where the tests were meant to go.
      throw new PlainSyntaxError(`Plain syntax error: ${problem}`);
    }

    if (!isHeading) {
      newChildren.push(child);
      continue;
    }

    if (acceptanceTestsFoundAlready) {
      throw new PlainSyntaxError(
        `Plain syntax error: Syntax error at line ${lineNumber(child)}: Duplicate 'acceptance tests' ` +
          "heading found within the same functionality. Only one block of acceptance tests is allowed per functionality.",
      );
    }

    const nextToken = children[index + 1];
    if (nextToken === undefined) {
      newChildren.push(child);
      continue;
    }

    index += 1;
    if (nextToken.type === "list") {
      if (functionalRequirement[ACCEPTANCE_TESTS] === undefined) {
        functionalRequirement[ACCEPTANCE_TESTS] = [];
      }
      for (const listItem of nextToken.children ?? []) {
        functionalRequirement[ACCEPTANCE_TESTS]!.push(listItem);
      }
      acceptanceTestsFoundAlready = true;
    } else {
      // Not followed by a list: keep both tokens.
      newChildren.push(child);
      newChildren.push(nextToken);
    }
  }

  functionalRequirement.children = newChildren;
}

export function processAcceptanceTests(plainSource: ParsedPlainSource): void {
  if (!(FUNCTIONAL_REQUIREMENTS in plainSource)) return;
  const frs = plainSource[FUNCTIONAL_REQUIREMENTS];
  if (!frs) return;

  for (const functionalRequirement of frs.children) {
    if (functionalRequirement.children === undefined) continue;
    processSingleAcceptanceTestRequirement(functionalRequirement);
  }
}

export function marshallPlainSource(input: ParsedPlainSource): MarshalledPlainSource {
  const plainSource: MarshalledPlainSource = {};


  for (const heading of ALLOWED_SPECIFICATION_HEADINGS) {
    const section = input[heading];
    if (!section) continue;

    const listOfRequirements: SpecificationItem[] = [];
    for (const requirement of section.children) {
      const requirementSection: SpecificationItem = {
        markdown: renderToMarkdown(requirement).trim(),
      };
      if (requirement.linked_resources) {
        requirementSection.linked_resources = requirement.linked_resources;
      }

      const acceptanceTests = requirement[ACCEPTANCE_TESTS];
      if (acceptanceTests !== undefined) {
        requirementSection[ACCEPTANCE_TESTS] = acceptanceTests.map((acceptanceTest) => {
          const section: SpecificationItem = { markdown: renderToMarkdown(acceptanceTest).trim() };
          if (acceptanceTest.linked_resources) section.linked_resources = acceptanceTest.linked_resources;
          return section;
        });
      }

      listOfRequirements.push(requirementSection);
    }

    plainSource[heading] = listOfRequirements;
  }

  return plainSource;
}

export function normalizeLineEndings(plainSourceText: string): string {
  return plainSourceText.split("\r\n").join("\n").split("\r").join("\n");
}

/**
 * Frontmatter parsing strips leading blank lines, which would shift every reported
 * line number. Put them back so syntax errors point at the real line.
 */
export function restoreStrippedLines(plainSourceText: string, content: string): string {
  const strippedSource = plainSourceText.replace(/\s+$/, "");
  if (!content || !strippedSource.endsWith(content)) return content;

  const prefix = strippedSource.slice(0, strippedSource.length - content.length);
  const strippedLineCount = (prefix.match(/\n/g) ?? []).length;
  return "\n".repeat(strippedLineCount) + content;
}

export function readPlainSourceMetadata(plainSourceText: string): FrontmatterPost {
  let metadata: Record<string, unknown> = {};
  let content = plainSourceText;

  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(plainSourceText);
  if (match) {
    try {
      // python-frontmatter yields {} when the block does not parse to a mapping,
      // so a malformed directive block is ignored rather than fatal.
      const loaded = loadYaml(match[1]!);
      metadata =
        loaded !== null && typeof loaded === "object" && !Array.isArray(loaded)
          ? (loaded as Record<string, unknown>)
          : {};
    } catch (error) {
      throw new PlainSyntaxError(
        `Plain syntax error: Invalid frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    content = plainSourceText.slice(match[0].length);
  }
  content = content.trim();

  for (const directive of [EXPORTED_CONCEPTS_DIRECTIVE, REQUIRED_CONCEPTS_DIRECTIVE]) {
    if (!(directive in metadata)) continue;
    const value = metadata[directive];
    if (!Array.isArray(value)) {
      throw new Error(`Syntax error: Invalid ${directive} metadata. Expected a list.`);
    }

    const prepared: string[] = [];
    for (const item of value) {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
          prepared.push(`- ${k}: ${v}`);
        }
      } else if (typeof item === "string") {
        prepared.push(`- ${item}`);
      } else {
        throw new PlainSyntaxError(
          `Plain syntax error: Invalid ${directive} metadata. Expected a dictionary or a string.`,
        );
      }
    }
    metadata[directive] = prepared;
  }

  return { metadata, content };
}

function processImports(
  plainSource: ParsedPlainSource,
  imports: string[],
  codeVariables: Record<string, Record<string, string>>,
  templateDirs: string[],
  importedModules: string[],
  modulesTrace: string[],
): string[] {
  const requiredConcepts: string[] = [];

  for (const moduleName of imports) {
    if (modulesTrace.includes(moduleName)) {
      throw new PlainSyntaxError(`Plain syntax error: Circular import detected: ${moduleName}.`);
    }
    if (importedModules.includes(moduleName)) continue;

    const result = parsePlainFile(moduleName, codeVariables, templateDirs, importedModules, modulesTrace);

    if (hasFunctionalSpecsSection(result.plainSource)) {
      throw new ImportedModuleWithFunctionalitiesError(
        `Module '${moduleName}' is imported but contains functional specs. ` +
          "Imported modules may only provide definitions, implementation reqs, and test reqs — " +
          "use 'requires' instead of 'import' if this module's functionalities should be built on.",
      );
    }

    for (const heading of Object.keys(result.plainSource)) {
      if (!ALLOWED_IMPORT_SPECIFICATION_HEADINGS.includes(heading)) {
        throw new PlainSyntaxError(
          `Plain syntax error: Invalid specification heading (\`${heading}\`). ` +
            `Allowed headings: ${ALLOWED_IMPORT_SPECIFICATION_HEADINGS.join(", ")}`,
        );
      }

      if (plainSource[heading] == null) {
        plainSource[heading] = result.plainSource[heading] ?? null;
      } else if (result.plainSource[heading] != null) {
        plainSource[heading]!.children.push(...result.plainSource[heading]!.children);
      }
    }

    if (REQUIRED_CONCEPTS_DIRECTIVE in result.plainSourceObj.metadata) {
      for (const item of result.plainSourceObj.metadata[REQUIRED_CONCEPTS_DIRECTIVE] as unknown[]) {
        if (typeof item !== "string") {
          throw new Error(`Syntax error: Invalid ${REQUIRED_CONCEPTS_DIRECTIVE} metadata. Expected a string.`);
        }
        const [newConcepts] = extractConceptsFromDefinition(item);
        requiredConcepts.push(...newConcepts);
      }
      requiredConcepts.push(...result.requiredConcepts);
    }

    importedModules.push(moduleName);
  }

  return requiredConcepts;
}

export function parsePlainSource(
  plainSourceText: string,
  codeVariables: Record<string, Record<string, string>>,
  templateDirs: string[],
  importedModules: string[],
  modulesTrace: string[],
): PlainFileParseResult {
  plainSourceText = normalizeLineEndings(plainSourceText);

  const plainSourceObj = readPlainSourceMetadata(plainSourceText);
  const plainSource = newPlainSource();

  let requiredConcepts: string[] = [];
  if (IMPORT_DIRECTIVE in plainSourceObj.metadata) {
    requiredConcepts = processImports(
      plainSource,
      plainSourceObj.metadata[IMPORT_DIRECTIVE] as string[],
      codeVariables,
      templateDirs,
      importedModules,
      modulesTrace,
    );
  }

  const [, loadedTemplates] = getLoadedTemplates(templateDirs, plainSourceText);
  const plainSourceContent = restoreStrippedLines(plainSourceText, plainSourceObj.content);
  const plainSourceFullText = renderPlainSource(plainSourceContent, loadedTemplates, codeVariables);

  const plainFile = parseMarkdown(plainSourceFullText);
  removeQuotes(plainFile);

  let currentSpecificationHeading: string | null = null;
  const processedSpecificationHeadings = new Set<string>();

  for (const token of plainFile.children ?? []) {
    const tokenText = getRawText(token).trim();

    if (token.type === "paragraph") {
      const paragraphChildren = token.children ?? [];
      const emphasisChildren =
        paragraphChildren.length > 0 && paragraphChildren[0]!.type === "emphasis"
          ? (paragraphChildren[0]!.children ?? [])
          : [];

      if (
        !(
          paragraphChildren.length === 1 &&
          paragraphChildren[0]!.type === "emphasis" &&
          emphasisChildren.length === 1 &&
          emphasisChildren[0]!.type === "strong"
        )
      ) {
        throw new PlainSyntaxError(
          `Plain syntax error: Syntax error at line ${lineNumber(token)}: Invalid specification (\`${tokenText}\`)`,
        );
      }

      const specificationHeading = String((emphasisChildren[0]!.children ?? [])[0]?.value ?? "");

      if (specificationHeading === ACCEPTANCE_TEST_HEADING) {
        throw new PlainSyntaxError(
          `Plain syntax error: Syntax error at line ${lineNumber(token)}: ${ACCEPTANCE_TEST_HEADING} heading should be nested under specific functional spec.`,
        );
      }

      if (!ALLOWED_SPECIFICATION_HEADINGS.includes(specificationHeading)) {
        throw new PlainSyntaxError(
          `Plain syntax error: Syntax error at line ${lineNumber(token)}: Invalid specification heading (\`${specificationHeading}\`). Allowed headings: ${ALLOWED_SPECIFICATION_HEADINGS.join(", ")}`,
        );
      }

      if (specificationHeading === FUNCTIONAL_REQUIREMENTS && !(specificationHeading in plainSource)) {
        plainSource[specificationHeading] = null;
      }

      if (processedSpecificationHeadings.has(specificationHeading)) {
        throw new PlainSyntaxError(
          `Plain syntax error: Syntax error at line ${lineNumber(token)}: Duplicate specification heading (\`${specificationHeading}\`)`,
        );
      }

      if (specificationHeading === DEFINITIONS && currentSpecificationHeading !== null) {
        throw new PlainSyntaxError(
          `Plain syntax error: Syntax error at line ${lineNumber(token)}: Definitions specification must be the first specification in the section  (\`${tokenText}\`)`,
        );
      }

      currentSpecificationHeading = specificationHeading;
      if (plainSource[currentSpecificationHeading] == null) {
        plainSource[currentSpecificationHeading] = { children: [] };
      }

      processedSpecificationHeadings.add(currentSpecificationHeading);
    } else if (token.type === "list") {
      if (currentSpecificationHeading === null) {
        throw new PlainSyntaxError(
          `Plain syntax error: Syntax error at line ${lineNumber(token)}: Missing specification heading (\`${tokenText}\`)`,
        );
      }
      plainSource[currentSpecificationHeading]!.children.push(...(token.children ?? []));
    } else {
      throw new PlainSyntaxError(
        `Plain syntax error: Syntax error at line ${lineNumber(token)}: Invalid source structure  (\`${tokenText}\`)`,
      );
    }
  }

  // Acceptance tests belong under functional specs only.
  for (const nonFunctionalHeading of [DEFINITIONS, NON_FUNCTIONAL_REQUIREMENTS, TEST_REQUIREMENTS]) {
    const section = plainSource[nonFunctionalHeading];
    if (!section) continue;
    for (const child of section.children) {
      const nested = findAcceptanceTestHeading(child);
      if (nested !== null) {
        throw new PlainSyntaxError(
          `Plain syntax error: Syntax error at line ${lineNumber(nested)}: ${ACCEPTANCE_TEST_HEADING} heading should be nested under specific functional spec.`,
        );
      }
    }
  }

  const definitionsSection = plainSource[DEFINITIONS];
  if (definitionsSection) {
    for (const token of definitionsSection.children) {
      const [newConcepts] = extractConceptsFromDefinition(renderToMarkdown(token));
      for (const concept of newConcepts) {
        const index = requiredConcepts.indexOf(concept);
        if (index !== -1) requiredConcepts.splice(index, 1);
      }
    }
  }

  const requiredModules = (plainSourceObj.metadata[REQUIRES_DIRECTIVE] as string[] | undefined) ?? [];

  return { plainSource, plainSourceObj, requiredModules, requiredConcepts };
}

export function readModulePlainSource(moduleName: string, templateDirs: string[]): string {
  // `stdlib/...` is turri's standard library, and only that - see stdlib.ts.
  const plainSourceText = isStdlibModule(moduleName) ? readStdlibModule(moduleName, templateDirs) : openFrom(templateDirs, moduleName + PLAIN_SOURCE_FILE_EXTENSION);
  if (plainSourceText === null) {
    throw new ModuleDoesNotExistError(`Module does not exist (${moduleName}).`);
  }

  const blob = findLargeBase64Blob(plainSourceText);
  if (blob !== null) {
    throw new UnsupportedBase64Content(
      `Module '${moduleName}' contains a base64-encoded blob (${blob.length} characters) ` +
        "inlined in the specification. This is not supported." +
        "Remove the base64 data from the .plain file or if necessary," +
        "include the binary file path in the specification.",
    );
  }

  return plainSourceText;
}

export function parsePlainFile(
  moduleName: string,
  codeVariables: Record<string, Record<string, string>>,
  templateDirs: string[],
  importedModules: string[],
  modulesTrace: string[],
): PlainFileParseResult {
  const plainSourceText = readModulePlainSource(moduleName, templateDirs);
  return parsePlainSource(plainSourceText, codeVariables, templateDirs, importedModules, [
    ...modulesTrace,
    moduleName,
  ]);
}

export function processRequiredModules(
  requiredModules: string[],
  codeVariables: Record<string, Record<string, string>>,
  templateDirs: string[],
  allRequiredModules: string[],
  modulesTrace: string[],
): AnyNode[] {
  const exportedDefinitions: AnyNode[] = [];

  for (const moduleName of requiredModules) {
    if (modulesTrace.includes(moduleName)) {
      throw new PlainSyntaxError(`Plain syntax error: Circular required module detected: ${moduleName}.`);
    }

    if (allRequiredModules.length > 0 && moduleName === allRequiredModules[allRequiredModules.length - 1]) {
      continue;
    }

    const result = parsePlainFile(moduleName, codeVariables, templateDirs, [], []);

    if (result.requiredModules.length === 0) {
      if (allRequiredModules.length > 0) {
        // Required modules must form one chain; independent modules cannot yet be merged.
        throw new PlainSyntaxError(
          `Plain syntax error: There must be a fixed order how required modules are dependent (${moduleName}).`,
        );
      }
    } else {
      processRequiredModules(result.requiredModules, codeVariables, templateDirs, allRequiredModules, [
        ...modulesTrace,
        moduleName,
      ]);
    }

    if (EXPORTED_CONCEPTS_DIRECTIVE in result.plainSourceObj.metadata) {
      const exportedConcepts: string[] = [];
      for (const concept of result.plainSourceObj.metadata[EXPORTED_CONCEPTS_DIRECTIVE] as unknown[]) {
        if (typeof concept === "string" && DEFAULT_CONCEPTS.has(concept)) {
          throw new PlainSyntaxError(
            `Plain syntax error: Default concept cannot be exported: ${concept}. Only user-defined concepts can be exported.`,
          );
        }
        if (typeof concept === "string") {
          exportedConcepts.push(...extractConceptsFromDefinition(concept)[0]);
        } else {
          throw new PlainSyntaxError(`Plain syntax error: Invalid exported concept: ${concept}.`);
        }
      }

      for (const exportedConcept of exportedConcepts) {
        exportedDefinitions.push(
          ...findConceptDefinitionsInPlainSource(exportedConcept, result.plainSource[DEFINITIONS] ?? null),
        );
      }
    }

    allRequiredModules.push(moduleName);
  }

  return exportedDefinitions;
}

export function processExportedDefinitions(
  plainSource: ParsedPlainSource,
  exportedDefinitions: AnyNode[],
): void {
  if (exportedDefinitions.length === 0) return;

  const definitions = plainSource[DEFINITIONS];
  if (!definitions) return;

  for (const exportedDefinition of exportedDefinitions) {
    const exportedRendered = renderToMarkdown(exportedDefinition).trim();
    const alreadyPresent = definitions.children.some(
      (definition) => renderToMarkdown(definition).trim() === exportedRendered,
    );
    if (!alreadyPresent) definitions.children.push(exportedDefinition);
  }
}

/**
 * Parse a .plain file into the marshalled tree.
 *
 * Returns the module name, the tree, and the modules it requires.
 */
export interface ParseOptions {
  /**
   * Accept a module with no functional specs yet. Not renderable one functionality at a
   * time - there is none - but a spec change can already be built from it: a module whose
   * product interview has so far given it definitions and reqs.
   */
  allowNoFunctionalities?: boolean;
}

export function plainFileParser(
  plainSourceFileName: string,
  templateDirs: string[],
  options: ParseOptions = {},
): [string, MarshalledPlainSource, string[]] {
  const key = `${options.allowNoFunctionalities ? "any" : "renderable"}\0${process.cwd()}\0${templateDirs.join("\0")}\0${plainSourceFileName}`;
  if (activeCache === undefined) {
    // Between calls: the parse from before, while nothing it could have read has changed since.
    const fingerprint = filesFingerprint(templateDirs);
    const kept = fingerprint !== undefined ? lastParses.get(key) : undefined;
    if (kept !== undefined && kept.fingerprint === fingerprint) {
      if (kept.error !== undefined) throw kept.error;
      return structuredClone(kept.parsed!);
    }
    let parsed: ParsedModule;
    try {
      parsed = parseModule(plainSourceFileName, templateDirs, new Map(), options);
    } catch (error) {
      // A spec that does not parse does not parse again until it changes: it is not parsed again to say so.
      if (fingerprint !== undefined) remember(key, { fingerprint, error });
      throw error;
    }
    if (fingerprint !== undefined) remember(key, { fingerprint, parsed: structuredClone(parsed) });
    return parsed;
  }
  let parsed = activeCache.get(key);
  if (parsed === undefined) {
    // Nothing changes while `run` runs: each folder set's fingerprint is taken once.
    const dirsKey = templateDirs.join("\0");
    let fingerprint = activeCache.fingerprints.get(dirsKey);
    if (!activeCache.fingerprints.has(dirsKey)) {
      fingerprint = filesFingerprint(templateDirs);
      activeCache.fingerprints.set(dirsKey, fingerprint);
    }
    const kept = fingerprint !== undefined ? lastParses.get(key) : undefined;
    if (kept !== undefined && kept.fingerprint === fingerprint) {
      if (kept.error !== undefined) throw kept.error;
      parsed = structuredClone(kept.parsed!);
    } else {
      try {
        parsed = parseModule(plainSourceFileName, templateDirs, activeCache.modules, options);
      } catch (error) {
        if (fingerprint !== undefined) remember(key, { fingerprint, error });
        throw error;
      }
      if (fingerprint !== undefined) remember(key, { fingerprint, parsed: structuredClone(parsed) });
    }
    activeCache.set(key, parsed);
  }
  return parsed;
}

/**
 * One parse per file for the length of `run`, however many times it is asked for.
 *
 * Walking a requires chain parses each module in it, and each parse gathers what it inherits
 * by parsing the modules below - so looking across a project of long chains asks for the
 * same files thousands of times. Inside `run` they are parsed once. Outside it nothing is
 * kept, so an edit made between two calls is always seen: the cache is for one question
 * about the specs, not for the life of the process.
 */
export function withParseCache<T>(run: () => T): T {
  if (activeCache !== undefined) return run();
  activeCache = Object.assign(new Map<string, ParsedModule>(), { modules: new Map<string, ParsedModule>(), fingerprints: new Map<string, string | undefined>() });
  try {
    return run();
  } finally {
    activeCache = undefined;
  }
}

let activeCache: (Map<string, ParsedModule> & { modules: Map<string, ParsedModule>; fingerprints: Map<string, string | undefined> }) | undefined;

/**
 * Parses kept between calls, each with what the files it could have read were when it was made: every file directly
 * in the template folders and the current one - its name, size and modification time, and a .plain file's text.
 * The same fingerprint, the same parse: a spec is parsed again only once something it could read has changed. A
 * copy is handed out, so no caller can change what is kept. Bounded, oldest out first.
 */
const lastParses = new Map<string, { fingerprint: string; parsed?: ParsedModule; error?: unknown }>();
const KEPT_PARSES = 200;

function remember(key: string, entry: { fingerprint: string; parsed?: ParsedModule; error?: unknown }): void {
  lastParses.delete(key);
  lastParses.set(key, entry);
  while (lastParses.size > KEPT_PARSES) lastParses.delete(lastParses.keys().next().value!);
}

function filesFingerprint(templateDirs: string[]): string | undefined {
  try {
    const parts: string[] = [];
    for (const dir of [process.cwd(), ...templateDirs]) {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        parts.push(`${dir}:-`);
        continue;
      }
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (!entry.isFile()) continue;
        const path = resolve(dir, entry.name);
        const stat = statSync(path);
        parts.push(`${path}:${stat.size}:${stat.mtimeMs}${entry.name.endsWith(".plain") ? `:${readFileSync(path, "utf8")}` : ""}`);
      }
    }
    return createHash("sha1").update(parts.join("\n")).digest("hex");
  } catch {
    return undefined;
  }
}

type ParsedModule = [string, MarshalledPlainSource, string[]];

/**
 * The functional specs a module inherits through `requires`, bottom of the chain first.
 *
 * This is what `requires` means: the required module's code is this module's starting
 * point, so its functional specs - and, transitively, its ancestors' - are previous
 * functional specs here. Each required module's own tree already carries what it inherits,
 * so taking that and then its own specs walks the whole chain; a module reached twice, as
 * when `requires` lists ancestors for their exported concepts, is counted once.
 */
function inheritFunctionalSpecs(
  requires: string[],
  templateDirs: string[],
  cache: Map<string, ParsedModule>,
): InheritedSpecificationItem[] {
  const inherited: InheritedSpecificationItem[] = [];
  const seen = new Set<string>();
  const add = (item: InheritedSpecificationItem) => {
    const key = `${item.module}/${item.frid}`;
    if (seen.has(key)) return;
    seen.add(key);
    inherited.push(item);
  };

  for (const name of requires) {
    let parsed = cache.get(name);
    if (parsed === undefined) {
      parsed = parseModule(`${name}${PLAIN_SOURCE_FILE_EXTENSION}`, templateDirs, cache);
      cache.set(name, parsed);
    }
    const [moduleName, tree] = parsed;
    for (const item of (tree[REQUIRED_FUNCTIONAL_SPECS] as InheritedSpecificationItem[] | undefined) ?? []) add(item);
    (getSpecificationItems(tree, FUNCTIONAL_REQUIREMENTS) ?? []).forEach((item, index) =>
      add({ ...item, module: moduleName, frid: String(index + 1) }),
    );
  }
  return inherited;
}

function parseModule(
  plainSourceFileName: string,
  templateDirs: string[],
  cache: Map<string, ParsedModule>,
  options: ParseOptions = {},
): ParsedModule {
  const suffix = extname(plainSourceFileName);
  if (suffix !== PLAIN_SOURCE_FILE_EXTENSION) {
    throw new PlainSyntaxError(
      `Plain syntax error: Invalid plain file extension: ${suffix}. Expected: ${PLAIN_SOURCE_FILE_EXTENSION}.`,
    );
  }

  const moduleName = isAbsolute(plainSourceFileName)
    ? basename(plainSourceFileName, PLAIN_SOURCE_FILE_EXTENSION)
    : plainSourceFileName.slice(0, -PLAIN_SOURCE_FILE_EXTENSION.length).split("\\").join("/");

  // Populated while Liquid renders; read back after the tree is marshalled.
  const codeVariables: Record<string, Record<string, string>> = {};

  const result = parsePlainFile(moduleName, codeVariables, templateDirs, [], []);

  if (result.requiredConcepts.length > 0) {
    throw new PlainSyntaxError(
      "Plain syntax error: Not all required concepts were defined. Missing required concepts: " +
        `${result.requiredConcepts.join(", ")}.`,
    );
  }

  if (!options.allowNoFunctionalities && !hasFunctionalSpecsSection(result.plainSource)) {
    // Valid as an import, but not renderable.
    throw new MissingFunctionalitiesError(
      `Module '${moduleName}' does not have any functionality specified. ` +
        "At least one functionality is required for rendering.",
    );
  }

  if (!options.allowNoFunctionalities && countFunctionalities(result.plainSource) === 0) {
    throw new PlainSyntaxError(
      `Plain syntax error: Module '${moduleName}' has an empty '${FUNCTIONAL_REQUIREMENTS}' section. ` +
        "At least one functionality must be specified.",
    );
  }

  validateFunctionalitiesHaveImplementationReqs(
    result.plainSource,
    moduleName,
    result.requiredModules.length > 0,
  );

  const exportedDefinitions = processRequiredModules(result.requiredModules, {}, templateDirs, [], []);
  processExportedDefinitions(result.plainSource, exportedDefinitions);
  processAcceptanceTests(result.plainSource);
  checkForLinkedResources(result.plainSource, templateDirs);

  const marshalled = marshallPlainSource(result.plainSource);
  processCodeVariables(marshalled, codeVariables);

  const validationErrors = validateConcepts(marshalled);
  if (validationErrors.length > 0) {
    const msg = `Found ${validationErrors.length} errors in the plain file:\n${validationErrors.join("\n")}`;
    throw new PlainSyntaxError(`Plain syntax error: ${msg}`);
  }

  const definitions = getSpecificationItems(marshalled, DEFINITIONS);
  if (definitions !== undefined) sortDefinitions(definitions);

  // What `import` brings - definitions, implementation reqs, test reqs - is already merged
  // into the module's own sections. What `requires` brings is the functional specs.
  const inherited = inheritFunctionalSpecs(result.requiredModules, templateDirs, cache);
  if (inherited.length > 0) marshalled[REQUIRED_FUNCTIONAL_SPECS] = inherited;

  return [moduleName, marshalled, result.requiredModules];
}
