// No test waits out a provider that is failing: the harness retries at once.
process.env.PLAINWRIGHT_PROVIDER_RETRY_DELAY ??= "0";
import { afterAll } from "vitest";
import { closeAllVms } from "../src/render/vm.ts";

// Every test file's VMs are closed when it finishes: a worker is ended by a signal, and the
// VMs it started would otherwise outlive it.
afterAll(async () => {
  await closeAllVms();
});
