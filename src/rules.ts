import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { stdlibCatalogue } from "./stdlib.ts";

/**
 * The ***plain authoring rules.
 *
 * These are loaded in full into every session's system prompt. They are large - around
 * 40k tokens - and that is the deliberate trade: a rule the model has to decide to go and
 * read is a rule it can skip, and these govern every spec this project writes.
 */
export function loadRules(rulesDir: string, off: readonly string[] = []): Array<{ name: string; content: string }> {
  let entries: string[];
  try {
    // A project's config.yaml can leave rules out (rules-off): by name, with or without .md.
    const left = new Set(off.map((name) => name.replace(/\.md$/, "")));
    entries = readdirSync(rulesDir).filter((entry) => entry.endsWith(".md") && !left.has(basename(entry, ".md"))).sort();
  } catch {
    return [];
  }

  return entries.map((entry) => {
    const name = basename(entry, ".md");
    const content = readFileSync(join(rulesDir, entry), "utf8").trim();
    // The standard library's rule carries what is in it, read from the templates themselves.
    return { name, content: name === "stdlib" ? [content, stdlibCatalogue()].filter(Boolean).join("\n\n") : content };
  });
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
