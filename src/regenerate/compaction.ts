/**
 * What an agent's work is summed up to when its session gets long - one set of instructions per role.
 *
 * An agent that keeps its session through a job is compacted between turns once its conversation - what it has
 * done, not its instructions - passes the project's compact-at (see pi.ts compactIfDue). Its task is its system
 * prompt and is never summed up, so these say only what of the work the summary must keep for it to go on.
 */

/** The coding agent, and the code fixer of a conformance run: what is done, what is not, and why. */
export const CODER_COMPACTION =
  "Keep what has been done - the files written or changed, and what each is for - what is still failing and why, the " +
  "last test run's result, every decision made and why, every review problem and what became of it (fixed, or declined " +
  "and why), and what was tried that did not work. Leave out file contents and full test output: they can be read or " +
  "run again.";

/** The conformance agent: the tests written, what they cover, and what is still open. */
export const CONFORMANCE_COMPACTION =
  "Keep the conformance tests written and what each covers, what is still failing and whose fault it was found to be " +
  "(the tests, the code or the spec), every review problem and what became of it, and what was tried that did not " +
  "work. Leave out file contents and full test output: they can be read or run again.";

/** A reviewer: what it raised, and where each problem stands. */
export const REVIEWER_COMPACTION =
  "Keep every problem you raised, review by review, and where each stands now: open, fixed and checked in the code, or " +
  "declined by the agent that did the work and whether you accepted why. Keep what you have already checked and found " +
  "right, so it is not checked again. Leave out the diffs and file contents themselves - they can be read again.";
