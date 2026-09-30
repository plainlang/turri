import { relative } from "node:path";

/**
 * How a job that lands code ends: the person can try what is built, by asking - `deploy` sets it up
 * from what is built.
 */

function shortPath(buildDir: string): string {
  const fromHere = relative(process.cwd(), buildDir);
  return fromHere === "" || fromHere.startsWith("..") ? buildDir : fromHere;
}

/** What every job that lands code ends with: the person can try it now, by asking. */
export const TRY_IT_LINE = "Want to try it? Just ask me - I'll set it up from what's built so far.";

/** The same for a command-line run, which has no one to ask: the command that does it. */
export function tryItCommand(plainFile: string): string {
  return `To try it: plainwright deploy ${shortPath(plainFile)}`;
}

/** A job's report, ending with how to try what it built when it landed. */
export function withTryItLine(report: string, landed: boolean): string {
  return landed ? `${report}\n\n${TRY_IT_LINE}` : report;
}
