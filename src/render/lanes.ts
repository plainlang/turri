import { dirname, resolve } from "node:path";
import { resolveRequiresChain } from "./requires.ts";

/**
 * What a job on this spec may write, as lanes for the job registry.
 *
 * A module's directory holds its code and its conformance tests, and building a module can
 * build everything it requires first - so the lanes are every module in the requires chain.
 * That is more than a single functionality touches, and deliberately so: two jobs that
 * might write the same directory wait for each other, and a wait costs minutes where a
 * collision costs the build.
 */
export function moduleLanes(plainFile: string, buildRoot?: string): string[] {
  const extra = buildRoot !== undefined ? [resolve(buildRoot)] : [];
  try {
    const chain = resolveRequiresChain(plainFile, [], buildRoot);
    return [...chain.map((entry) => dirname(entry.buildDir)), ...extra];
  } catch {
    // A spec that does not parse fails inside the job with a proper error. Until then it
    // still must not run alongside another job on the same file.
    return [resolve(plainFile), ...extra];
  }
}
