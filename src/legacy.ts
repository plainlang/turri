import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * turri was called plainwright. What that name left behind is carried over, so nothing set up under it is lost:
 *
 * - `PLAINWRIGHT_*` environment variables, read as the `TURRI_*` they are now - when those are not set;
 * - `~/.plainwright`, the person's own files (their VM image recipe), moved to `~/.turri`;
 * - VM images built under the old tags, booted until the new ones are built;
 * - a project's files under the old names - see `migrateProject` in grow/migrate.ts.
 *
 * Imported first by every entry point: modules read their environment as they load.
 */
export const LEGACY_NAME = "plainwright";

for (const [key, value] of Object.entries(process.env)) {
  const now = key.replace(/^PLAINWRIGHT_/, "TURRI_");
  if (now !== key && process.env[now] === undefined && value !== undefined) process.env[now] = value;
}

/** Where the person's own files are: `~/.turri` - the old `~/.plainwright` moved there the first time. */
export function turriHome(): string {
  const now = join(homedir(), ".turri");
  const before = join(homedir(), `.${LEGACY_NAME}`);
  if (!existsSync(now) && existsSync(before)) {
    try {
      renameSync(before, now);
    } catch {
      return before;
    }
  }
  return now;
}

/** An image tag as it was before: `turri:latest` was `plainwright:latest`, `turri-<project>-…` was `plainwright-<project>-…`. */
export function legacyImageTag(tag: string): string {
  return tag.replace(/^turri/, LEGACY_NAME);
}
