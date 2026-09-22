import { describe, expect, it, vi } from "vitest";
import { captureConsole, describeCaptured } from "../src/quiet.ts";

describe("captureConsole", () => {
  it("collects console output instead of printing it", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const { result, output } = await captureConsole(async () => {
      console.warn("Both GOOGLE_API_KEY and GEMINI_API_KEY are set.");
      console.log("chatter");
      return 42;
    });
    spy.mockRestore();

    expect(result).toBe(42);
    expect(output).toEqual(["Both GOOGLE_API_KEY and GEMINI_API_KEY are set.", "chatter"]);
  });

  it("leaves process.stdout.write alone, because that is how the TUI draws", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    await captureConsole(async () => {
      process.stdout.write("a frame of the TUI");
    });
    spy.mockRestore();

    expect(writes).toEqual(["a frame of the TUI"]);
  });

  it("restores the console afterwards", async () => {
    const before = console.warn;
    await captureConsole(async () => {});
    expect(console.warn).toBe(before);
  });

  it("restores the console even when the work throws", async () => {
    const before = console.warn;
    await expect(captureConsole(async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(console.warn).toBe(before);
  });

  it("keeps capturing while concurrent work is still running", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const slow = captureConsole(async () => {
      await blocked;
      console.warn("late");
    });
    const quick = await captureConsole(async () => {
      console.warn("early");
    });

    // The quick one finished, but the slow one is still capturing.
    expect(quick.output).toEqual(["early"]);
    expect(console.warn).not.toBe(Object.getPrototypeOf(console).warn);

    release();
    expect((await slow).output).toContain("late");
  });

  it("summarises what it swallowed", () => {
    expect(describeCaptured([])).toBeNull();
    expect(describeCaptured(["a", "a", "b"])).toContain("3 lines of library output suppressed");
    expect(describeCaptured(["a", "a", "b"])).toContain("a | b");
  });
});
