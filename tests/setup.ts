import { afterAll } from "vitest";
import { closeAllVms } from "../src/render/vm.ts";

// Every test file's VMs are closed when it finishes: a worker is ended by a signal, and the
// VMs it started would otherwise outlive it.
afterAll(async () => {
  await closeAllVms();
});
