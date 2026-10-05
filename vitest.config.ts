import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The parser resolves linked resources relative to the process cwd, exactly as the
    // Python implementation does, and the fixtures carry repo-relative targets.
    root: ".",
    // A test that runs the testing scripts or real commands behind the sandbox can take a while.
    testTimeout: 60_000,
    setupFiles: ["tests/setup.ts"],
  },
});
