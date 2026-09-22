import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * The ***plain authoring rules.
 *
 * These are loaded in full into every session's system prompt. They are large - around
 * 40k tokens - and that is the deliberate trade: a rule the model has to decide to go and
 * read is a rule it can skip, and these govern every spec this project writes.
 */
export function loadRules(rulesDir: string): Array<{ name: string; content: string }> {
  let entries: string[];
  try {
    entries = readdirSync(rulesDir).filter((entry) => entry.endsWith(".md")).sort();
  } catch {
    return [];
  }

  return entries.map((entry) => ({
    name: basename(entry, ".md"),
    content: readFileSync(join(rulesDir, entry), "utf8").trim(),
  }));
}

/** The block appended to the system prompt. Identical every turn, so it stays cacheable. */
export function renderRulesBlock(rules: Array<{ name: string; content: string }>): string {
  if (rules.length === 0) return "";

  const body = rules
    .map((rule) => `<rule name="${rule.name}">\n${rule.content}\n</rule>`)
    .join("\n\n");

  return [
    "<plain-rules>",
    "The authoring rules for ***plain specifications. They are binding: when writing or",
    "editing a .plain file, follow them exactly rather than inferring from surrounding text.",
    "",
    body,
    "</plain-rules>",
  ].join("\n");
}

export function rulesSummary(rules: Array<{ name: string; content: string }>): string {
  const chars = rules.reduce((total, rule) => total + rule.content.length, 0);
  return `${rules.length} rules, ~${Math.round(chars / 4000)}k tokens`;
}
