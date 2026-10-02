// No test waits out a provider that is failing: the harness retries at once.
process.env.TURRI_PROVIDER_RETRY_DELAY ??= "0";
// Test files run side by side, and several boot VMs at once: at the four cores a module's VM gets, they would ask for more
// than the machine has, and the tests that time how fast a VM answers would measure the crowding. Two each, here.
process.env.TURRI_VM_CPUS ??= "2";
// A job warms its agent's VM as it begins; the scripted agents of the tests run no command that needs one there.
process.env.TURRI_VM_WARM ??= "0";
import { afterAll } from "vitest";
import { closeAllVms } from "../src/grow/vm.ts";

// Every test file's VMs are closed when it finishes: a worker is ended by a signal, and the
// VMs it started would otherwise outlive it.
afterAll(async () => {
  await closeAllVms();
});
