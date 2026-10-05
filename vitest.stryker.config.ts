import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.ts";

// The suite for mutation testing (stryker.config.mjs): Stryker runs it in one worker, so the files that boot sandbox VMs -
// about the sandbox, not the logic mutated - are left out. A mutant only they reach is reported as not covered.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      exclude: [
        "tests/grow/confine-*.test.ts",
        "tests/grow/vm-*.test.ts",
        "tests/grow/services.test.ts",
        "tests/grow/self-check.test.ts",
        "tests/grow/gates.test.ts",
        "tests/grow/host-scripts.test.ts",
        "**/node_modules/**",
      ],
    },
  }),
);
