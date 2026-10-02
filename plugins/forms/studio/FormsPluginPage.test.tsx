// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPluginRoute } from "@tilecast/studio/testing";
import { formsApi } from "./api";
import { FormsPluginPage } from "./FormsPluginPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

  it("renders only the load error when the initial forms query fails", async () => {
    vi.spyOn(formsApi, "listForms").mockRejectedValue(new Error("offline"));

    renderPluginRoute(<FormsPluginPage />, {
      path: "/plugins/forms",
      patterns: ["/plugins/forms"],
      role: "owner",
    });

    expect(await screen.findByText("Could not load forms")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByText("No forms yet")).not.toBeInTheDocument();
  });
});
