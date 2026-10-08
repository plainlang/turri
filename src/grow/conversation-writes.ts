import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * What the conversation itself writes in the project, for the audit to leave alone.
 *
 * The audit puts back what changes in the project's own files while an agent's command runs, taking every change then
 * for the command's. But the conversation goes on beside the pulses: the person's model edits a spec, writes a spec
 * diff or runs a command of its own, and a change of its that lands while an agent's `ls` runs would be put back as the
 * agent's - the person's edit undone, silently. So the conversation's file tools, its shell and the spec diffs it applies
 * say here what they write and when, and the audit leaves a change the conversation made while the command ran.
 *
 * Only the conversation reaches this: the agents of a pulse are started without extensions, so its hooks never see
 * their tools, and their own writes are fenced to their folders.
 */

/** Anything still marked as in progress after this long is taken to have ended: a hook that never heard its end. */
const STALE_MS = 15 * 60 * 1000;

/** A write or a command of the conversation's in progress: when it started. */
interface Running {
  started: number;
}

/** Paths being written now, with each write in progress. */
const writing = new Map<string, Set<Running>>();
/** Paths written, with when the last write ended. */
const wrote = new Map<string, number>();
/** The conversation's commands running now - what they write cannot be known. */
const commands = new Set<Running>();
let lastCommandEnd = 0;

/** A path as the audit walks it: absolute, with its symlinks resolved where it exists. */
function canonical(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    try {
      return join(realpathSync(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

/** The conversation is about to write these files: call what it returns once it has. */
export function conversationWriting(paths: string[]): () => void {
  const write: Running = { started: Date.now() };
  const marked = paths.map(canonical);
  for (const path of marked) writing.set(path, (writing.get(path) ?? new Set()).add(write));
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const now = Date.now();
    for (const path of marked) {
      const left = writing.get(path);
      left?.delete(write);
      if (left?.size === 0) writing.delete(path);
      wrote.set(path, now);
    }
  };
}

/** The conversation starts a command of its own: call what it returns once it has ended. */
export function conversationCommand(): () => void {
  const command: Running = { started: Date.now() };
  commands.add(command);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    commands.delete(command);
    lastCommandEnd = Date.now();
  };
}

/** The conversation's turn is over: nothing of its is in progress any more. */
export function conversationSettled(): void {
  const now = Date.now();
  for (const path of writing.keys()) wrote.set(path, now);
  writing.clear();
  if (commands.size > 0) lastCommandEnd = now;
  commands.clear();
}

/** Whether the conversation may have written this file after `since` - a write of its to it, or a command of its own. */
export function writtenByConversation(path: string, since: number): boolean {
  const now = Date.now();
  const live = (running: Running) => now - running.started < STALE_MS;
  if ([...commands].some(live) || lastCommandEnd > since) return true;
  const key = canonical(path);
  if ([...(writing.get(key) ?? [])].some(live)) return true;
  return (wrote.get(key) ?? 0) > since;
}

/** For tests: forget everything. */
export function resetConversationWrites(): void {
  writing.clear();
  wrote.clear();
  commands.clear();
  lastCommandEnd = 0;
}
