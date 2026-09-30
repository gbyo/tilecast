// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { ApiError } from "../api/errors";
import type { Asset } from "../api/types";
import { BrandingAssets } from "./BrandingAssets";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ status: { csrfToken: "test-csrf" } }),
}));

vi.mock("../api/loginBackground", () => ({
  clearLoginBackground: vi.fn(),
  getLoginBackground: vi.fn().mockResolvedValue({
    imageUrl: "/api/v1/auth/background",
  }),
  setLoginBackground: vi.fn(),
}));

const logo = {
  id: "logo-asset",
  name: "Community logo",
  originalFilename: "community-logo.png",
  thumbnailUrl: "/api/v1/assets/logo-asset/thumbnail",
} as unknown as Asset;

function renderBranding() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BrandingAssets
        values={{ "branding.logo_asset_id": logo.id }}
        editable
        onChange={() => undefined}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BrandingAssets", () => {
  it("shows a retry for lookup failures instead of marking the asset unavailable", async () => {
    const user = userEvent.setup();
    const lookup = vi
      .spyOn(api, "asset")
      .mockRejectedValueOnce(
        new ApiError("Server error.", 500, "internal_error"),
      )
      .mockResolvedValue(logo);

    renderBranding();

    expect(
      await screen.findByText("Could not load the selected image."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "The selected image is unavailable. Upload a replacement.",
      ),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Community logo")).toBeInTheDocument();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByText("Could not load the selected image."),
    ).not.toBeInTheDocument();
  });

  it("keeps the unavailable message for an asset confirmed missing by the server", async () => {
    vi.spyOn(api, "asset").mockRejectedValue(
      new ApiError("Not found.", 404, "not_found"),
    );

    renderBranding();

    expect(
      await screen.findByText(
        "The selected image is unavailable. Upload a replacement.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Could not load the selected image."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
  });
});
