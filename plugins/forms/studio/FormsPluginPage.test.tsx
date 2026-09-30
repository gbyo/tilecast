// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@tilecast/studio";
import { i18n, renderPluginRoute } from "@tilecast/studio/testing";
import { formsApi } from "./api";
import { FormsPluginPage } from "./FormsPluginPage";

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await i18n.changeLanguage("en");
});

describe("Forms plugin", () => {
  it("lists accessible forms and links to canonical plugin routes", async () => {
    vi.spyOn(formsApi, "listForms").mockResolvedValue([
      {
        id: "form-1",
        name: "Staff announcements",
        description: "Collect announcements for review.",
        publishedRevisionNumber: 2,
        grantedCapabilities: ["manage"],
        submissionCounts: {
          draft: 0,
          submitted: 0,
          changesRequested: 0,
          total: 0,
        },
      },
    ]);

    renderPluginRoute(<FormsPluginPage />, {
      path: "/plugins/forms",
      patterns: ["/plugins/forms"],
      role: "owner",
    });

    expect(
      await screen.findByRole("link", { name: "Manage form" }),
    ).toHaveAttribute("href", "/plugins/forms/form-1");
    expect(screen.getByRole("link", { name: /Create form/ })).toHaveAttribute(
      "href",
      "/plugins/forms/new",
    );
  });

  it("presents library load failures through the localized API error path", async () => {
    await i18n.changeLanguage("ru");
    vi.spyOn(formsApi, "listForms").mockRejectedValue(
      new ApiError("Server-provided forms failure.", 429, "rate_limited"),
    );

    renderPluginRoute(<FormsPluginPage />, {
      path: "/plugins/forms",
      patterns: ["/plugins/forms"],
      role: "owner",
    });

    expect(
      await screen.findByText(
        "Слишком много попыток. Подождите немного и повторите попытку.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Server-provided forms failure.")).toBe(null);
  });
});
