// No test waits out a provider that is failing: the harness retries at once.
process.env.TURRI_PROVIDER_RETRY_DELAY ??= "0";
// Test files run side by side, and several boot VMs at once: at the four cores a module's VM gets, they would ask for more
// than the machine has, and the tests that time how fast a VM answers would measure the crowding. Two each, here.
process.env.TURRI_VM_CPUS ??= "2";
// A job warms its agent's VM as it begins; the scripted agents of the tests run no command that needs one there.
process.env.TURRI_VM_WARM ??= "0";
// The testing scripts run on this machine, not in a VM booted for every temp project - which was most of the suite's time.
// The tests about running them in the VM ask for it: TURRI_TESTING_SCRIPTS_IN=vm, or run-testing-scripts-in: vm.
process.env.TURRI_TESTING_SCRIPTS_IN ??= "host";
import { afterAll } from "vitest";
import { killAllGroups } from "../src/grow/shell.ts";
import { closeAllVms } from "../src/grow/vm.ts";

// Every test file's VMs are closed when it finishes: a worker is ended by a signal, and the
// VMs it started would otherwise outlive it.
// And whatever a test's commands left running on this machine is killed with it.
afterAll(async () => {
  await closeAllVms();
  killAllGroups();
});
