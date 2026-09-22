import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bulkWriteWarning, createSpecPacing } from "../../src/render/pacing.ts";

let dir: string;

const module = (count: number) =>
  `***implementation reqs***\n\n- A requirement.\n\n***functional specs***\n\n` +
  Array.from({ length: count }, (_, i) => `- Functionality ${i + 1}.\n`).join("\n");

function write(count: number): void {
  writeFileSync(join(dir, "demo.plain"), module(count));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plainwright-pacing-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createSpecPacing", () => {
  it("says nothing about the first observation", () => {
    write(3);
    const pacing = createSpecPacing(dir);
    expect(pacing.observe("demo.plain")).toEqual({ count: 3, added: 0, bulk: false });
  });

  it("accepts one new spec between renders", () => {
    write(1);
    const pacing = createSpecPacing(dir);
    pacing.observe("demo.plain");
    write(2);
    expect(pacing.observe("demo.plain")).toEqual({ count: 2, added: 1, bulk: false });
  });

  it("flags two or more specs written between renders", () => {
    write(1);
    const pacing = createSpecPacing(dir);
    pacing.observe("demo.plain");
    write(4);
    const observation = pacing.observe("demo.plain");
    expect(observation).toEqual({ count: 4, added: 3, bulk: true });
    expect(bulkWriteWarning(observation)).toContain("3 functional specs");
  });

  it("tracks each file separately", () => {
    write(1);
    writeFileSync(join(dir, "other.plain"), module(5));
    const pacing = createSpecPacing(dir);
    pacing.observe("demo.plain");
    expect(pacing.observe("other.plain").bulk).toBe(false);
  });

  it("stays quiet when the file does not parse", () => {
    const pacing = createSpecPacing(dir);
    expect(pacing.observe("missing.plain")).toEqual({ count: 0, added: 0, bulk: false });
  });

  it("does not complain when specs are removed", () => {
    write(3);
    const pacing = createSpecPacing(dir);
    pacing.observe("demo.plain");
    write(1);
    expect(pacing.observe("demo.plain")).toEqual({ count: 1, added: 0, bulk: false });
  });
});
