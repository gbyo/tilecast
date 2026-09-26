import { describe, expect, it } from "vitest";
import { confettiPieces } from "./confetti";

describe("confetti", () => {
  it("derives the same pieces from the same key on every engine", () => {
    expect(confettiPieces("cd-1:2026-09-01T16:10:00.000Z")).toEqual(
      confettiPieces("cd-1:2026-09-01T16:10:00.000Z"),
    );
    expect(confettiPieces("a")).not.toEqual(confettiPieces("b"));
    expect(confettiPieces("a")).toHaveLength(220);
  });
});
