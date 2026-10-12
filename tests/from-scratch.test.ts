import { describe, expect, it } from "vitest";
import { asksFromScratch } from "../src/loop-tools.ts";

describe("a /regenerate that asks for its module from scratch", () => {
  it("is heard in the words people use for it", () => {
    for (const words of [
      "from scratch (delete the entire module)",
      "from scratch",
      "start over",
      "starting it over",
      "delete the entire module first",
      "wipe the code and build it again",
      "throw away everything",
      "afresh, one spec at a time",
      "from the ground up",
    ]) {
      expect(asksFromScratch(words), words).toBe(true);
    }
  });

  it("is not heard in guidance for how to cut the work", () => {
    for (const words of ["", "models first, then the API endpoints", "all in one pulse", "one functional spec at a time", "start with the models", "delete endpoints last"]) {
      expect(asksFromScratch(words), words).toBe(false);
    }
  });
});
