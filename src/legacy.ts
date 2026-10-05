/**
 * turri was called plainwright. What that name left behind is carried over, so nothing set up under it is lost:
 *
 * - `PLAINWRIGHT_*` environment variables, read as the `TURRI_*` they are now - when those are not set;
 * - a project's files under the old names - see `migrateProject` in grow/migrate.ts.
 *
 * Imported first by every entry point: modules read their environment as they load.
 */
export const LEGACY_NAME = "plainwright";

for (const [key, value] of Object.entries(process.env)) {
  const now = key.replace(/^PLAINWRIGHT_/, "TURRI_");
  if (now !== key && process.env[now] === undefined && value !== undefined) process.env[now] = value;
}
