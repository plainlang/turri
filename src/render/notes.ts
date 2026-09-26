import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { reportActivity } from "./activity.ts";

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
 * Every line says when and where it came from - `[2026-09-24 16:49 · backend 3]` for
 * functionality 3 of backend, `backend 3 conformance`, `backend spec change` - stamped by the
 * harness, not written by the agent, so a line read two modules later can still be traced to the
 * step that wrote it. A line that is changed is stamped again: an assumption one agent revised
 * shows as newer than the ones around it, and where two lines disagree the later one is right. And every line
 * has to say something: "none", "N/A", "nothing new" are refused - a section with nothing to add
 * is left alone.
 *
 * Leaving them is not optional, and neither is how: only update_notes writes the file. The file
 * tools refuse it, a change made any other way - a shell, a script - is undone, and an agent
 * that finishes without calling update_notes is asked again until it does.
 *
 * The notes are disposable: delete the file and nothing breaks, the next agent just explores a
 * little more. They live beside the code, so they travel with it - copied up with it to a module
 * that requires this one, committed with it, and reset with it when a run is interrupted.
 */

export const NOTES_FILE = ".plainwright-notes.md";

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
  `- ${SECTIONS.where}: entry points, layout, where each functionality and its tests live.`,
  `- ${SECTIONS.run}: the commands that build, run and test it, and what had to be installed for them.`,
  `- ${SECTIONS.assumptions}: what you assumed where the specification is silent - a format, a default, a`,
  "  choice it leaves open. Build on the assumptions already there; change or remove one the moment the code",
  "  or the specification shows it wrong.",
  `- ${SECTIONS.pitfalls}: what went wrong and what fixed it, approaches that did not work.`,
  "Each line stands on its own, for someone who never saw your work. When and where it came from is added",
  "to it for you - do not write it. Where two lines disagree, the later one is right: change the older one",
  'rather than add a contradicting line. Leave a section with nothing new alone: "none" is not a note.',
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
        "out of date: the code and the specification are the truth. Each line says when and by which step it was",
        "written; where two disagree, the later one is right. Build on the assumptions unless the code or the",
        "specification shows one wrong.",
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

const SOURCE = /^\[[^\]\n]+\]\s+/;

/** A line without the `[where it came from]` in front. */
function body(line: string): string {
  return line.trim().replace(/^[-*]\s+/, "").replace(SOURCE, "");
}

/**
 * What says nothing: a line whose whole point is that there is nothing to say. Kept narrow, so
 * "None of the endpoints need auth" is still a note.
 */
const FILLER = [
  /^(none|n\/a|na|nothing|not applicable)( (specifically|so far|yet|found|noted|new|here|at all|for (this|now|the)|to (add|note|report))\b.*)?[.!]?$/i,
  /^no (new |other |specific )?(pitfalls?|assumptions?|notes?|issues?|problems?)( (so far|yet|found|noted|here|for (this|now|the))\b.*)?[.!]?$/i,
];

export function isFiller(text: string): boolean {
  const line = body(text);
  return line === "" || FILLER.some((pattern) => pattern.test(line));
}

/** A line in a section that is, or starts with, what the agent quoted - where it came from aside. */
function find(lines: string[], quoted: string): number {
  const wanted = body(quoted);
  const exact = lines.findIndex((line) => body(line) === wanted);
  return exact !== -1 ? exact : lines.findIndex((line) => body(line).startsWith(wanted));
}

/** A note about running the project's testing scripts by hand. */
const RUNS_TESTING_SCRIPTS = /test_scripts\/|\brun_(unittests|unit_tests|conformance_tests)\w*\.sh\b/;

/**
 * Apply the changes; the notes that result, or what could not be applied. A line added or
 * changed is stamped with `stamp` - when, and which step wrote it.
 */
export function applyNotesChanges(notes: Notes, changes: NotesChange[], stamp?: string): { notes: Notes; problems: string[] } {
  const next: Notes = { where: [...notes.where], run: [...notes.run], assumptions: [...notes.assumptions], pitfalls: [...notes.pitfalls] };
  const problems: string[] = [];
  for (const change of changes) {
    const lines = next[change.section];
    const said = body(change.text.replace(/\s*\n\s*/g, " "));
    const text = stamp ? `[${stamp}] ${said}` : said;
    // How the tests are run is the harness's: a note telling the next agent to run the project's
    // testing scripts itself sends it looking for files it cannot reach, and writing its own.
    if (change.action !== "remove" && RUNS_TESTING_SCRIPTS.test(said)) {
      problems.push(
        `"${change.text.trim()}" tells the next agent to run the testing scripts itself. It cannot: they are not in the ` +
          "codebase, and run_unit_tests and run_conformance_tests are how the tests are run. Leave that out.",
      );
      continue;
    }
    if (change.action !== "remove" && isFiller(said)) {
      problems.push(
        `"${change.text.trim()}" in ${SECTIONS[change.section]} is not a note. Leave a section with nothing new alone.`,
      );
      continue;
    }
    if (change.action === "add") {
      if (!lines.some((line) => body(line) === said)) lines.push(text);
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

/** The local time, to the minute: `2026-09-24 16:49`. */
function now(): string {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** `update_notes`: lines added, changed or removed, never the notes rewritten. */
export function createNotesTool(
  buildDir: string,
  onWrite: (text: string) => void,
  before: () => void = () => {},
  source?: string,
) {
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
          text: Type.String({
            description:
              "The line to add, the new line for a change, or the line to remove - one short line that stands on its " +
              "own. When and where it came from is added for you.",
          }),
          replaces: Type.Optional(Type.String({ description: "For a change: the line it replaces, as it reads now" })),
        }),
        { minItems: 1 },
      ),
    }),
    async execute(_id, params) {
      before();
      const { notes, problems } = applyNotesChanges(
        readNotes(buildDir),
        params.changes as NotesChange[],
        source === undefined ? undefined : `${now()} · ${source}`,
      );
      if (problems.length > 0) {
        throw new Error(`Nothing saved - fix these and call update_notes again:\n\n${problems.join("\n\n")}`);
      }
      const text = formatNotes(notes);
      writeFileSync(notesPath(buildDir), text);
      onWrite(text);
      return { content: [{ type: "text" as const, text: "Notes updated." }], details: { characters: text.length } };
    },
  });
}

/** How many times an agent that finishes without update_notes is asked to call it. */
export const NOTES_ASKS = 3;

function current(buildDir: string): string | undefined {
  const path = notesPath(buildDir);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/**
 * The notes tool for one agent's session, and the check that it was used. The notes as they
 * were when the agent started, or as update_notes last left them, are the only notes: a change
 * made to the file any other way is undone. An agent that finishes without calling update_notes
 * is asked to, until it has. `source` is the step it is - `backend 3`, `backend 3 conformance` -
 * and every line it writes says so, with the time.
 */
export function notesForSession(buildDir: string, source?: string) {
  let written = false;
  let known = current(buildDir);

  /** Put back what update_notes did not write; whether there was anything to put back. */
  const undoDirectWrites = (): boolean => {
    if (current(buildDir) === known) return false;
    if (known === undefined) rmSync(notesPath(buildDir), { force: true });
    else writeFileSync(notesPath(buildDir), known);
    return true;
  };

  return {
    tool: createNotesTool(
      buildDir,
      (text) => {
        written = true;
        known = text;
      },
      undoDirectWrites,
      source,
    ),
    /** Ask for the notes until this agent has updated them; whether it has. */
    async ensureWritten(ask: (prompt: string) => Promise<unknown>): Promise<boolean> {
      for (let round = 0; round < NOTES_ASKS && !written; round++) {
        const undone = undoDirectWrites();
        await ask(
          (undone
            ? `You changed ${NOTES_FILE} directly, and that was undone: the notes are written only through update_notes. `
            : "") +
            "Before you finish: call update_notes - add what you learned about this codebase, change what is no longer " +
            "true, and record the assumptions you made where the specification is silent. Call the tool itself; " +
            "writing the file does not count.",
        );
      }
      undoDirectWrites();
      if (!written) {
        reportActivity(`${basename(dirname(buildDir))}: its agent left no notes, though asked ${NOTES_ASKS} times`);
      }
      return written;
    },
  };
}
