import { describe, expect, it } from "vitest";
import { isYouTubeEndedMessage } from "./spec";

describe("YouTube completion messages", () => {
  it("accepts only numeric ended states in the bounded IFrame API vocabulary", () => {
    expect(isYouTubeEndedMessage({ event: "onStateChange", data: 0 })).toBe(
      true,
    );
    expect(
      isYouTubeEndedMessage(
        JSON.stringify({ event: "infoDelivery", info: { playerState: 0 } }),
      ),
    ).toBe(true);
    for (const value of [
      null,
      0,
      "invalid JSON",
      "x".repeat(65_537),
      { event: "onStateChange", data: "0" },
      { event: "infoDelivery", info: { playerState: 1 } },
      { event: "other", data: 0 },
    ])
      expect(isYouTubeEndedMessage(value)).toBe(false);
  });
});
