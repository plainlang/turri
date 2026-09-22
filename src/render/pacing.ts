import { basename, resolve } from "node:path";
import { plainFileParser } from "../plain/parser.ts";
import { getFrids } from "../plain/spec.ts";
import { resolveTemplateDirs } from "./render.ts";

/**
 * One functional spec at a time.
 *
 * The interview writes a spec, queues it for building, and asks the next question. Writing
 * several before queueing any of them breaks that: the user never saw the ones in the
 * middle, and each is built on top of specs they were never asked about. The instruction
 * to go one at a time is easy to drift from, so the count is checked rather than trusted.
 */

export interface PacingObservation {
  /** Functional specs in the file now. */
  count: number;
  /** How many appeared since the last observation. */
  added: number;
  /** More than one appeared: the interview got ahead of the user. */
  bulk: boolean;
}

export interface SpecPacing {
  observe(plainFile: string, templateDirs?: string[]): PacingObservation;
}

export function createSpecPacing(cwd: string): SpecPacing {
  const seen = new Map<string, number>();

  return {
    observe(plainFile, templateDirs) {
      const file = resolve(cwd, plainFile);

      let count: number;
      try {
        const dirs = resolveTemplateDirs(file, templateDirs);
        const [, tree] = plainFileParser(basename(file), dirs);
        count = [...getFrids(tree)].length;
      } catch {
        // A spec that does not parse cannot be counted; say nothing rather than accuse.
        return { count: 0, added: 0, bulk: false };
      }

      const previous = seen.get(file);
      seen.set(file, count);

      // The first observation has nothing to compare against - a file may already hold
      // functionalities from an earlier session.
      const added = previous === undefined ? 0 : Math.max(0, count - previous);
      return { count, added, bulk: added > 1 };
    },
  };
}

export function bulkWriteWarning(observation: PacingObservation): string {
  return (
    `${observation.added} functional specs have appeared since the last one was queued. ` +
    "Only one may be written at a time: each is built on the ones before it, and the user " +
    "has not been asked about the ones in between. Go back to the first of them, walk the " +
    "user through each in turn, and queue them one at a time."
  );
}
