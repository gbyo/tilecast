import { describe, expect, it } from "vitest";
import type { FormSummary } from "../api/types";
import {
  canSeeApprovals,
  selectedStudioNavigationRoute,
} from "./Dashboard";

const summary = (
  capabilities: FormSummary["grantedCapabilities"],
): FormSummary => ({
  id: "form-1",
  name: "Announcements",
  description: "",
  grantedCapabilities: capabilities,
  submissionCounts: { draft: 0, submitted: 0, changesRequested: 0, total: 0 },
});

describe("Studio navigation state", () => {
  it("selects the matching workspace route for a detail URL", () => {
    expect(selectedStudioNavigationRoute("/widgets/widget-1")).toBe("/widgets");
    expect(selectedStudioNavigationRoute("/screens/screen-1")).toBe("/screens");
    expect(selectedStudioNavigationRoute("/screens/archive")).toBe(
      "/screens/archive",
    );
    expect(selectedStudioNavigationRoute("/settings/users")).toBe(
      "/settings/general",
    );
  });

  it("limits Approvals navigation to users with review capability", () => {
    expect(canSeeApprovals([summary(["submit"])])).toBe(false);
    expect(canSeeApprovals([summary(["review"])])).toBe(true);
  });
});
