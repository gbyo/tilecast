import { describe, expect, it } from "vitest";
import { authReturnTo } from "./returnTo";

describe("authReturnTo", () => {
  it("preserves OAuth approval query parameters across login", () => {
    const search =
      "?client_id=tilecast-ios&redirect_uri=tilecast-ios%3A%2F%2Foauth%2Fcallback&scope=read+write+admin&state=state-123&code_challenge=challenge-123&code_challenge_method=S256";

    expect(
      authReturnTo({
        pathname: "/oauth/approve",
        search,
        hash: "",
      }),
    ).toBe(`/oauth/approve${search}`);
  });

  it("preserves a hash when returning to an authenticated route", () => {
    expect(
      authReturnTo({
        pathname: "/screens/screen-1",
        search: "?tab=activity",
        hash: "#event-42",
      }),
    ).toBe("/screens/screen-1?tab=activity#event-42");
  });
});
