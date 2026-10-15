import { describe, expect, it } from "vitest";
import { resumeLine } from "../src/resume-line.ts";

describe("the resume line", () => {
  it("names turri, not pi, as the command that resumes the session", () => {
    expect(resumeLine("\x1b[2mTo resume this session:\x1b[22m pi --session 01a13e52\n")).toBe("\x1b[2mTo resume this session:\x1b[22m turri --session 01a13e52\n");
    expect(resumeLine("To resume this session: pi --session-dir /tmp/s --session 01a13e52\n")).toBe("To resume this session: turri --session-dir /tmp/s --session 01a13e52\n");
  });

  it("leaves any other output as it is", () => {
    expect(resumeLine("pi --session 1\n")).toBe("pi --session 1\n");
  });
});
