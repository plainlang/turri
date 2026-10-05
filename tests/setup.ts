// No test waits out a provider that is failing: the harness retries at once.
process.env.TURRI_PROVIDER_RETRY_DELAY ??= "0";
import { afterAll } from "vitest";
import { killAllGroups } from "../src/grow/shell.ts";

// Whatever a test file's commands left running on this machine is killed when it finishes: a worker is ended by a
// signal, and what it started would otherwise outlive it.
afterAll(() => {
  killAllGroups();
});
