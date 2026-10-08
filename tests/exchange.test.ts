import { describe, expect, it } from "vitest";
import { exchangeLines } from "../src/extension.ts";

const plain = (_color: string, text: string) => text;

describe("a skill's question, as the transcript keeps it", () => {
  it("keeps what the skill said before asking - a brief to confirm - above the question and the answer", () => {
    const brief = "- **Problem:** Studying feels isolating.\n- **Primary user:** University and college students.";
    expect(exchangeLines({ skill: "brood", said: brief, question: "Does this brief accurately capture Cognio's initial intent?", answer: "Yes, confirm this brief." }, plain)).toEqual([
      "brood asked",
      "- **Problem:** Studying feels isolating.",
      "- **Primary user:** University and college students.",
      "",
      "Does this brief accurately capture Cognio's initial intent?",
      "> Yes, confirm this brief.",
    ]);
    // Nothing said first: the question and the answer alone, as before.
    expect(exchangeLines({ skill: "brood", question: "Which stack?", answer: "" }, plain)).toEqual(["brood asked", "Which stack?", "> (no answer)"]);
  });
});
