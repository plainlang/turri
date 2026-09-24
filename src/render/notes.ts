import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Working notes: what one agent on a codebase leaves the next.
 *
 * Every agent the harness starts is a fresh session. Without notes, each one spends its first
 * turns finding its bearings - where the entry point is, how the tests run, what was installed,
 * which approach already failed. The notes carry that forward: each agent on a codebase gets
 * them the moment it starts, and updates them - a line added, changed or removed - before it
 * finishes, so they grow with the codebase instead of being rewritten by whoever came last.
 *
 * Stubborn on the specs, flexible on the assumptions. What the software must do is in the spec,
 * and the notes never repeat or override it. Where the spec is silent, an agent has to assume
 * something, and the assumptions it made are written down - so the next agent builds on the
 * same ones instead of guessing afresh, and changes one the moment the code or the spec shows
 * it to be wrong.
 *
 * The notes are disposable: delete the file and nothing breaks, the next agent just explores a
 * little more. They live beside the code, so they travel with it - copied up with it to a module
 * that requires this one, committed with it, and reset with it when a run is interrupted.
 */

export const NOTES_FILE = ".plainwright-notes.md";

/** How long the notes may grow. Past this, an update has to make room. */
export const NOTES_LIMIT = 6000;

/** The sections, in order, and what each is for - shown to the agent as the heading. */
export const SECTIONS = {
  where: "Where things are",
  run: "How to build, run and test",
  assumptions: "Assumptions",
  pitfalls: "Pitfalls",
} as const;

export type Section = keyof typeof SECTIONS;

const ORDER = Object.keys(SECTIONS) as Section[];

type Notes = Record<Section, string[]>;

export function notesPath(buildDir: string): string {
  return join(buildDir, NOTES_FILE);
}

function empty(): Notes {
  return { where: [], run: [], assumptions: [], pitfalls: [] };
}

/** The notes, as lines per section. Lines under no known heading go to pitfalls, not lost. */
export function parseNotes(text: string): Notes {
  const notes = empty();
  let section: Section = "pitfalls";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      section = ORDER.find((key) => SECTIONS[key].toLowerCase() === heading[1]!.trim().toLowerCase()) ?? section;
      continue;
    }
    const item = /^[-*]\s+(.+)$/.exec(line);
    if (item) notes[section].push(item[1]!.trim());
  }
  return notes;
}

export function formatNotes(notes: Notes): string {
  const parts = ["# Working notes", ""];
  for (const key of ORDER) {
    parts.push(`## ${SECTIONS[key]}`, "", ...(notes[key].length > 0 ? notes[key].map((line) => `- ${line}`) : ["(nothing yet)"]), "");
  }
  return parts.join("\n").trimEnd() + "\n";
}

export function readNotes(buildDir: string): Notes {
  const path = notesPath(buildDir);
  return existsSync(path) ? parseNotes(readFileSync(path, "utf8")) : empty();
}

function isEmpty(notes: Notes): boolean {
  return ORDER.every((key) => notes[key].length === 0);
}

const GUIDANCE = [
  "Before you finish, call update_notes to leave the next agent on this codebase what you learned - a fresh",
  "session that knows nothing of your work. Update them, do not rewrite them: add a line, change one that is",
  "no longer true, remove one that is wrong. In short lines, per section:",
  `- ${SECTIONS.where}: entry points, layout, where each functionality lives.`,
  `- ${SECTIONS.run}: the commands that work, what had to be installed.`,
  `- ${SECTIONS.assumptions}: what you assumed where the specification is silent - a format, a default, a`,
  "  choice it leaves open. Build on the assumptions already there; change or remove one the moment the code",
  "  or the specification shows it wrong.",
  `- ${SECTIONS.pitfalls}: what went wrong and what fixed it, approaches that did not work.`,
  "Stubborn on the specification, flexible on the assumptions: the specification is never an assumption, and",
  "never copied here. Where an assumption and the specification disagree, the specification is right.",
].join("\n");

/** A prompt, led by the notes earlier agents left - and told to update them for the next. */
export function withNotes(prompt: string, buildDir: string): string {
  const notes = readNotes(buildDir);
  const earlier = isEmpty(notes)
    ? "No earlier agent has left notes on this codebase yet."
    : [
        "<notes from earlier agents>",
        formatNotes(notes).trimEnd(),
        "</notes from earlier agents>",
        "",
        "Earlier agents on this codebase wrote these down, to spare you exploring from scratch. They may be",
        "out of date: the code and the specification are the truth. Build on the assumptions unless the code or",
        "the specification shows one wrong.",
      ].join("\n");
  return `${earlier}\n\n${prompt}\n\n${GUIDANCE}`;
}

export interface NotesChange {
  section: Section;
  action: "add" | "change" | "remove";
  /** The line to add, or for a change the new line. For a remove, the line to remove. */
  text: string;
  /** For a change: the line it replaces, as it reads now. */
  replaces?: string;
}

/** A line in a section that is, or starts with, what the agent quoted. */
function find(lines: string[], quoted: string): number {
  const wanted = quoted.trim().replace(/^[-*]\s+/, "");
  const exact = lines.findIndex((line) => line === wanted);
  return exact !== -1 ? exact : lines.findIndex((line) => line.startsWith(wanted));
}

/** Apply the changes; the notes that result, or what could not be applied. */
export function applyNotesChanges(notes: Notes, changes: NotesChange[]): { notes: Notes; problems: string[] } {
  const next: Notes = { where: [...notes.where], run: [...notes.run], assumptions: [...notes.assumptions], pitfalls: [...notes.pitfalls] };
  const problems: string[] = [];
  for (const change of changes) {
    const lines = next[change.section];
    const text = change.text.trim().replace(/^[-*]\s+/, "").replace(/\s*\n\s*/g, " ");
    if (change.action === "add") {
      if (text !== "" && !lines.includes(text)) lines.push(text);
      continue;
    }
    const target = change.action === "change" ? change.replaces ?? "" : text;
    if (target.trim() === "") {
      problems.push(`A ${change.action} in ${SECTIONS[change.section]} has to name the line it ${change.action === "change" ? "replaces, in `replaces`" : "removes"}.`);
      continue;
    }
    const at = find(lines, target);
    if (at === -1) {
      problems.push(
        `${SECTIONS[change.section]} has no line "${target}". Its lines now:\n` +
          (lines.length > 0 ? lines.map((line) => `  - ${line}`).join("\n") : "  (none)"),
      );
      continue;
    }
    if (change.action === "remove") lines.splice(at, 1);
    else lines[at] = text;
  }
  return { notes: next, problems };
}

/** `update_notes`: lines added, changed or removed, never the notes rewritten. */
export function createNotesTool(buildDir: string, onWrite: () => void) {
  return defineTool({
    name: "update_notes",
    label: "Update notes",
    description:
      "Update the working notes on this codebase for the next agent - add a line, change one that is no longer " +
      "true, remove one that is wrong - in its sections: where things are, how to build, run and test, " +
      "assumptions made where the specification is silent, and pitfalls. Never requirements: the specification " +
      "is never an assumption.",
    promptSnippet: "update_notes: leave the next agent what you learned and assumed about this codebase",
    parameters: Type.Object({
      changes: Type.Array(
        Type.Object({
          section: Type.Union(ORDER.map((key) => Type.Literal(key)), {
            description: `${ORDER.map((key) => `${key} = ${SECTIONS[key]}`).join("; ")}`,
          }),
          action: Type.Union([Type.Literal("add"), Type.Literal("change"), Type.Literal("remove")]),
          text: Type.String({ description: "The line to add, the new line for a change, or the line to remove - one short line" }),
          replaces: Type.Optional(Type.String({ description: "For a change: the line it replaces, as it reads now" })),
        }),
        { minItems: 1 },
      ),
    }),
    async execute(_id, params) {
      const { notes, problems } = applyNotesChanges(readNotes(buildDir), params.changes as NotesChange[]);
      if (problems.length > 0) {
        throw new Error(`Nothing saved - fix these and call update_notes again:\n\n${problems.join("\n\n")}`);
      }
      const text = formatNotes(notes);
      if (text.length > NOTES_LIMIT) {
        throw new Error(
          `Nothing saved: the notes would be ${text.length} characters, and the limit is ${NOTES_LIMIT}. Make room - ` +
            "remove lines the next agent does not need, or merge ones that say the same - in the same call.",
        );
      }
      writeFileSync(notesPath(buildDir), text);
      onWrite();
      return { content: [{ type: "text" as const, text: "Notes updated." }], details: { characters: text.length } };
    },
  });
}

/**
 * The notes tool for one agent's session, and the check that it was used: an agent that
 * finishes without updating the notes is asked to, once.
 */
export function notesForSession(buildDir: string) {
  let written = false;
  return {
    tool: createNotesTool(buildDir, () => {
      written = true;
    }),
    /** Ask for the notes if this agent has not updated them. */
    async ensureWritten(ask: (prompt: string) => Promise<unknown>): Promise<void> {
      if (written) return;
      await ask(
        "Before you finish: call update_notes - add what you learned about this codebase, change what is no longer " +
          "true, and record the assumptions you made where the specification is silent.",
      );
    },
  };
}
