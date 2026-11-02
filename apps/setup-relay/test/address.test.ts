import { describe, expect, it } from "vitest";
import corpus from "../../../packages/player-contracts/fixtures/server-url-policy.json";
import {
  normalizeServerUrl,
  setupFragment,
  studioSetupUrl,
} from "../public/address.js";

const KEY = `B${"x".repeat(86)}`;
const ID = "a".repeat(22);

describe("server address policy", () => {
  it.each(corpus.cases)("$name", (testCase) => {
    const result = normalizeServerUrl(testCase.input);
    expect(result.ok).toBe(testCase.accepted);
    if (result.ok) expect(result.url).toBe(testCase.normalized);
  });
});

describe("setup fragment", () => {
  it("returns the canonical fragment", () => {
    expect(setupFragment(`#k=${KEY}&r=${ID}&v=1&extra=1`)).toBe(
      `v=1&r=${ID}&k=${KEY}`,
    );
  });

  it.each([
    ["no fragment", ""],
    ["another version", `#v=2&r=${ID}&k=${KEY}`],
    ["a short code", `#v=1&r=${ID.slice(1)}&k=${KEY}`],
    ["a compressed key", `#v=1&r=${ID}&k=A${"x".repeat(43)}`],
    ["a missing key", `#v=1&r=${ID}`],
  ])("rejects %s", (_, hash) => {
    expect(setupFragment(hash)).toBeNull();
  });

  it("builds the Studio setup URL", () => {
    expect(studioSetupUrl("https://signage.example.org", `v=1&r=${ID}`)).toBe(
      `https://signage.example.org/screens/setup#v=1&r=${ID}`,
    );
  });
});
