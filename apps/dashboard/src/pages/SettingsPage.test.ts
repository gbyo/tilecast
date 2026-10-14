import { describe, expect, it } from "vitest";
import { authStatusFor } from "../test/capabilities";
import { canDeployPlayerUpdates, playerUpdateStateLabel } from "./SettingsPage";

describe("Player Updates settings", () => {
  it("treats TV approval as a waiting state rather than a failure", () => {
    const label = playerUpdateStateLabel("waiting_for_user");
    expect(label).toContain("approve the installer on the TV");
    expect(label).toContain("not a failure");
  });

  it("restricts deployment mutations to owners and administrators", () => {
    expect(canDeployPlayerUpdates(authStatusFor("owner"))).toBe(true);
    expect(canDeployPlayerUpdates(authStatusFor("administrator"))).toBe(true);
    expect(canDeployPlayerUpdates(authStatusFor("editor"))).toBe(false);
    expect(canDeployPlayerUpdates(authStatusFor("viewer"))).toBe(false);
  });
});
