// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n, renderPluginRoute } from "@tilecast/studio/testing";
import { formsApi } from "./api";
import { ApprovalsPage } from "./ApprovalsPage";

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await i18n.changeLanguage("en");
});

describe("Forms approvals", () => {
  it("formats submitted dates in the selected Studio locale", async () => {
    await i18n.changeLanguage("es");
    const submittedAt = "2026-03-04T12:00:00Z";
    vi.spyOn(formsApi, "listApprovals").mockResolvedValue({
      items: [
        {
          recordId: "rec-1",
          dataSourceId: "ds-1",
          formName: "Contact",
          title: "Website feedback",
          submitterName: "Dana",
          state: "pending",
          stateLabel: "Pending",
          submittedAt,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 25,
    });

    renderPluginRoute(<ApprovalsPage />, {
      path: "/plugins/forms/approvals",
      patterns: ["/plugins/forms/approvals"],
      role: "owner",
    });

    const expected = new Date(submittedAt).toLocaleString("es");
    await screen.findAllByText("Website feedback");
    expect(document.body.textContent).toContain(expected);
  });

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
