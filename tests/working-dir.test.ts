import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromWorkingDir } from "../src/extension.ts";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "plainwright-working-dir-")));
  mkdirSync(join(root, "plain"));
  writeFileSync(join(root, "plain", "hubspot.plain"), "");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("a render tool's working_dir", () => {
  it("renders as if plainwright had been started there: the file and build folder are relative to it", () => {
    expect(fromWorkingDir(root, { working_dir: "plain", plain_file: "hubspot.plain", build_dir: "plain_modules/hubspot/code" })).toEqual({
      working_dir: "plain",
      base: join(root, "plain"),
      plain_file: join(root, "plain", "hubspot.plain"),
      build_dir: join(root, "plain", "plain_modules", "hubspot", "code"),
    });
  });

  it("takes a plain_file that names the folder twice from where it is, and names a missing one in full", () => {
    expect(fromWorkingDir(root, { working_dir: "plain", plain_file: "plain/hubspot.plain" }).plain_file).toBe(join(root, "plain", "hubspot.plain"));
    expect(() => fromWorkingDir(root, { working_dir: "plain", plain_file: "zoho.plain" })).toThrow(
      `There is no .plain file at ${join(root, "plain", "zoho.plain")} - plain_file is relative to working_dir (plain)`,
    );
  });

  it("changes nothing when it is not given", () => {
    expect(fromWorkingDir(root, { plain_file: "plain/hubspot.plain" })).toEqual({ base: root, plain_file: join(root, "plain", "hubspot.plain") });
    expect(fromWorkingDir(root, { working_dir: " ", plain_file: "plain/hubspot.plain" }).base).toBe(root);
  });
});
