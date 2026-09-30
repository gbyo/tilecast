// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPluginRoute } from "@tilecast/studio/testing";
import { formsApi } from "./api";
import { ApprovalsPage } from "./ApprovalsPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Forms approvals", () => {
  it("renders only the error when the approvals query fails", async () => {
    vi.spyOn(formsApi, "listApprovals").mockRejectedValue(new Error("offline"));

    renderPluginRoute(<ApprovalsPage />, {
      path: "/plugins/forms/approvals",
      patterns: ["/plugins/forms/approvals"],
      role: "owner",
    });

    expect(
      await screen.findByText("Could not load approvals"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing to review")).not.toBeInTheDocument();
  });
});
