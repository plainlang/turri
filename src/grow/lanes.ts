import { basename, dirname, resolve } from "node:path";
import { buildDirUnder, modulesRoot, projectDirOf } from "./paths.ts";
import { resolveRequiresChain } from "./requires.ts";

/**
 * What a job on this spec may write, as lanes for the job registry.
 *
 * A module's directory holds its code and its conformance tests, and building a module can
 * build everything it requires first - so the lanes are every module in the requires chain.
 * That is more than a single functionality touches, and deliberately so: two jobs that
 * might write the same directory wait for each other, and a wait costs minutes where a
 * collision costs the build.
 *
 * The module's own folder is a lane whatever the spec says at the moment it is read. A spec with
 * no functional specs yet - the scaffold a new project starts with - or one that does not parse
 * names no chain, and a job queued then must still wait for, and be waited for by, every other
 * job on that module: two that claimed different lanes for the same folder ran side by side and
 * wrote over each other.
 */
export function moduleLanes(plainFile: string, buildRoot?: string): string[] {
  const extra = buildRoot !== undefined ? [resolve(buildRoot)] : [];
  // The folder the module builds in, by its name - the file's - as every chain names it too.
  const own = dirname(buildDirUnder(resolve(buildRoot ?? modulesRoot(projectDirOf(plainFile))), basename(plainFile, ".plain")));
  try {
    const chain = resolveRequiresChain(plainFile, [], buildRoot, { allowNoFunctionalities: true });
    return [...new Set([own, ...chain.map((entry) => dirname(entry.buildDir)), ...extra])];
  } catch {
    // A spec that does not parse fails inside the job with a proper error. Until then it
    // still must not run alongside another job on the same module, or on the same file.
    return [...new Set([own, resolve(plainFile), ...extra])];
  }
}
