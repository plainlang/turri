import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The parser resolves linked resources relative to the process cwd, exactly as the
    // Python implementation does, and the fixtures carry repo-relative targets.
    root: ".",
  },
});
