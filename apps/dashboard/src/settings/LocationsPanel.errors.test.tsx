// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LocationsPanel } from "./LocationsPanel";
import { api, ApiError } from "../api/client";
import type { Location } from "../api/types";
import { i18n } from "../i18n";

const { confirm } = vi.hoisted(() => ({
  confirm: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ status: { csrfToken: "csrf" } }),
}));

vi.mock("../components/ConfirmDialog", () => ({
  useConfirm: () => ({ confirm, dialog: null }),
}));

const location: Location = {
  id: "location-1",
  name: "Main Hall",
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "",
  postalCode: "",
  country: "",
  screenCount: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LocationsPanel canManage />
    </QueryClientProvider>,
  );
}

describe("Locations panel errors", () => {
  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    confirm.mockClear();
    await i18n.changeLanguage("en");
  });

  it("uses localized fallback copy for location load failures", async () => {
    await i18n.changeLanguage("es");
    vi.spyOn(api, "locations").mockRejectedValue(
      new Error("raw transport details"),
    );
    renderPanel();

    expect(
      await screen.findByText(i18n.t("settings:locations.loadError")),
    ).toBeInTheDocument();
    expect(screen.queryByText("raw transport details")).not.toBeInTheDocument();
  });

  it("translates API error codes when saving a location", async () => {
    await i18n.changeLanguage("es");
    vi.spyOn(api, "locations").mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(api, "createLocation").mockRejectedValue(
      new ApiError("English server wording", 429, "rate_limited"),
    );
    renderPanel();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: i18n.t("settings:locations.add"),
      }),
    );
    await user.type(
      await screen.findByLabelText(i18n.t("settings:locations.fields.name")),
      "Main Hall",
    );
    await user.click(
      screen.getByRole("button", { name: i18n.t("settings:locations.save") }),
    );

    expect(
      await screen.findByText(i18n.t("errors:codes.rate_limited")),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("English server wording"),
    ).not.toBeInTheDocument();
  });

  it("keeps the localized conflict message after a 409 delete failure", async () => {
    await i18n.changeLanguage("es");
    vi.spyOn(api, "locations").mockResolvedValue({
      items: [location],
      total: 1,
    });
    vi.spyOn(api, "deleteLocation").mockRejectedValue(
      new ApiError("raw server conflict", 409, "location_in_use"),
    );
    renderPanel();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: i18n.t("settings:locations.deleteLocation", {
          name: location.name,
        }),
      }),
    );

    expect(
      await screen.findByText(i18n.t("settings:locations.deleteConflict")),
    ).toBeInTheDocument();
    expect(screen.queryByText("raw server conflict")).not.toBeInTheDocument();
  });
});
