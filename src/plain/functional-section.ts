/**
 * Editing the `***functional specs***` section of a .plain file as text.
 *
 * The section is found by its header at the start of a line and runs to the next top-level
 * `***...***` header or the end of the file. Nested headers - `***acceptance tests***`
 * under a spec - are indented, so they stay inside it. Each functional spec is one
 * top-level `- ` item and everything indented under it, numbered 1, 2, 3 in order.
 */

export const FUNCTIONAL_SPECS_HEADER = "***functional specs***";

const HEADER = /^\*\*\*[^*].*\*\*\*\s*$/;
const ITEM = /^- /;

interface Section {
  /** Line index of the header. */
  header: number;
  /** First line after the header, and one past the last line of the section. */
  start: number;
  end: number;
}

function findSection(lines: string[]): Section | null {
  const header = lines.findIndex((line) => line.trim() === FUNCTIONAL_SPECS_HEADER && !line.startsWith(" "));
  if (header === -1) return null;
  let end = header + 1;
  while (end < lines.length && !HEADER.test(lines[end]!)) end += 1;
  return { header, start: header + 1, end };
}

const ACCEPTANCE_TESTS_HEADER = "***acceptance tests***";

/**
 * The specs themselves, for telling whether an edit changed them. Empty when there are none.
 *
 * Acceptance tests are left out. They sit indented under the spec they check, but they are
 * written in the testing phase, by their own skill, and adding one is not changing what the
 * spec asks for.
 */
export function functionalSpecsText(text: string): string {
  const lines = text.split("\n");
  const section = findSection(lines);
  if (section === null) return "";
  const kept: string[] = [];
  let testsIndent: number | null = null;
  for (const line of lines.slice(section.start, section.end)) {
    const indent = line.length - line.trimStart().length;
    if (testsIndent !== null) {
      // The block runs until something at or left of its header's indentation.
      if (line.trim() === "" || indent > testsIndent || (indent === testsIndent && line.trimStart().startsWith("- "))) continue;
      testsIndent = null;
    }
    if (line.trim() === ACCEPTANCE_TESTS_HEADER) {
      testsIndent = indent;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n").trim();
}

/** Line ranges of each functional spec in the section, in order. */
function items(lines: string[], section: Section): Array<{ start: number; end: number }> {
  const starts: number[] = [];
  for (let i = section.start; i < section.end; i += 1) if (ITEM.test(lines[i]!)) starts.push(i);
  return starts.map((start, index) => {
    let end = index + 1 < starts.length ? starts[index + 1]! : section.end;
    while (end > start + 1 && lines[end - 1]!.trim() === "") end -= 1;
    return { start, end };
  });
}

export class FunctionalSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FunctionalSpecError";
  }
}

/** One spec, cleaned up, or an error saying why it is not one. */
export function normaliseSpec(spec: string): string {
  const lines = spec.replace(/\r\n/g, "\n").split("\n").map((line) => line.trimEnd());
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();

  if (lines.length === 0 || !ITEM.test(lines[0]!)) {
    throw new FunctionalSpecError("A functional spec is one list item: it starts with `- `.");
  }
  const topLevel = lines.filter((line) => ITEM.test(line)).length;
  if (topLevel > 1) {
    throw new FunctionalSpecError(
      `That is ${topLevel} functional specs. Write exactly one per call - each is its own ` +
        "question, answer and build. Detail belongs indented under the one item.",
    );
  }
  const stray = lines.find((line, index) => index > 0 && line !== "" && !line.startsWith(" "));
  if (stray !== undefined) {
    throw new FunctionalSpecError(
      `'${stray}' is not indented under the spec. Everything after the first line belongs ` +
        "under it, indented.",
    );
  }
  return lines.join("\n");
}

export function countFunctionalSpecs(text: string): number {
  const lines = text.split("\n");
  const section = findSection(lines);
  return section === null ? 0 : items(lines, section).length;
}

/**
 * The file with `spec` added as the last functional spec, or put in place of functionality
 * `replaces`. Returns the new text and the spec's functionality id.
 */
export function withFunctionalSpec(
  text: string,
  spec: string,
  replaces?: string,
): { text: string; frid: string } {
  const body = normaliseSpec(spec).split("\n");
  const lines = text.split("\n");
  const section = findSection(lines);

  if (replaces !== undefined) {
    const all = section === null ? [] : items(lines, section);
    const index = Number(replaces) - 1;
    const target = /^\d+$/.test(replaces) ? all[index] : undefined;
    if (target === undefined) {
      throw new FunctionalSpecError(
        `There is no functionality ${replaces} to replace. The file has ${all.length}` +
          (all.length > 0 ? `: 1 to ${all.length}.` : "."),
      );
    }
    // The spec's acceptance tests are the testing phase's work, not part of what is being
    // rewritten: they stay unless the new text brings its own.
    const old = lines.slice(target.start, target.end);
    const testsAt = old.findIndex((line) => line.trim() === ACCEPTANCE_TESTS_HEADER);
    const bringsTests = body.some((line) => line.trim() === ACCEPTANCE_TESTS_HEADER);
    const kept = testsAt !== -1 && !bringsTests ? ["", ...old.slice(testsAt)] : [];
    lines.splice(target.start, target.end - target.start, ...body, ...kept);
    return { text: lines.join("\n"), frid: replaces };
  }

  if (section === null) {
    while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
    lines.push("", FUNCTIONAL_SPECS_HEADER, "", ...body, "");
    return { text: lines.join("\n"), frid: "1" };
  }

  const count = items(lines, section).length;
  // After the last non-blank line of the section, a blank line either side: one to set it
  // apart from the spec above, one before whatever follows or the end of the file.
  let at = section.end;
  while (at > section.start && lines[at - 1]!.trim() === "") at -= 1;
  lines.splice(at, section.end - at, "", ...body, "");
  return { text: lines.join("\n"), frid: String(count + 1) };
}
