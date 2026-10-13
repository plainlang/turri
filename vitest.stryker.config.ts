import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.ts";

// The suite for mutation testing (stryker.config.mjs): Stryker runs it in one worker, so the files that run real commands
// behind the sandbox - about the sandbox, not the logic mutated - are left out. A mutant only they reach is reported as
// not covered.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      exclude: [
        "tests/regenerate/shell.test.ts",
        "tests/regenerate/os-sandbox.test.ts",
        "tests/regenerate/agent-shell.test.ts",
        "tests/regenerate/services.test.ts",
        "tests/regenerate/self-check.test.ts",
        "tests/regenerate/gates.test.ts",
        "tests/regenerate/host-scripts.test.ts",
        "**/node_modules/**",
      ],
    },
  }),
);
