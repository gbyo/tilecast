// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MyAccountPage } from "./MyAccountPage";
import { api } from "../api/client";
import type { SecurityStatus, SettingDefinition } from "../api/types";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: {
      authenticated: true,
      csrfToken: "token",
      user: {
        id: "user-1",
        name: "Ada Lovelace",
        username: "ada",
        role: "editor",
        active: true,
      },
    },
  }),
}));

const definition: SettingDefinition = {
  key: "preference.appearance",
  category: "preference",
  type: "enum",
  title: "Appearance",
  default: "system",
  allowed: ["system", "light", "dark"],
  scope: "preference",
  sensitive: false,
  restartRequired: false,
  immediate: true,
  futureOnly: false,
};

const security: SecurityStatus = {
  relyingPartyId: "localhost",
  userHandle: "",
  totpEnrolled: false,
  passkeys: [],
  recoveryCodesRemaining: 0,
  enrolled: false,
  passkeysAvailable: true,
  passkeysUnavailableReason: "",
  required: false,
  policy: "none",
  authMethod: "password",
};

function renderPage(initialEntry = "/account") {
  vi.spyOn(api, "preferences").mockResolvedValue({
    schemaVersion: 1,
    revision: 1,
    values: { "preference.appearance": "system" },
    definitions: [definition],
    updatedAt: "2026-07-01T00:00:00Z",
  });
  vi.spyOn(api, "security").mockResolvedValue(security);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <MyAccountPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MyAccountPage", () => {
  it("names the account being edited, with its role", async () => {
    renderPage();
    const identity = await screen.findByText("Ada Lovelace");
    expect(identity.parentElement).toHaveTextContent("Signed in as");
    expect(identity.parentElement).toHaveTextContent("ada · Editor");
  });

  it("keeps the anchors the retired /preferences and /security routes land on", async () => {
    const { container } = renderPage();
    await screen.findByRole("heading", { name: "Preferences" });
    expect(container.querySelector("#preferences")).not.toBeNull();
    expect(container.querySelector("#security")).not.toBeNull();
  });

  /**
   * The security panels sit under a group heading of their own, so they are a
   * level down. A flat run of h2s would read to a screen reader as six
   * unrelated page sections rather than two groups.
   */
  it("nests the security panels under the group heading", async () => {
    renderPage();
    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: "Sign-in security",
      }),
    ).toBeInTheDocument();
    await screen.findByRole("heading", { name: "Authenticator app" });
    for (const name of ["Authenticator app", "Passkeys", "Recovery codes"]) {
      expect(
        screen.getByRole("heading", { level: 3, name }),
      ).toBeInTheDocument();
    }
  });

  // Panels inside panels are the thing this page was rebuilt to stop doing.
  it("does not put a panel inside a panel", async () => {
    const { container } = renderPage();
    await screen.findByRole("heading", { name: "Recovery codes" });
    expect(container.querySelector(".panel .panel")).toBeNull();
  });

  it("marks the section matching the deep-link hash current", async () => {
    renderPage("/account#security");
    await screen.findByRole("heading", { name: "Sign-in security" });

    const nav = screen.getByRole("navigation", { name: "Account sections" });
    const security = nav.querySelector('a[href="#security"]');
    const preferences = nav.querySelector('a[href="#preferences"]');
    expect(security).toHaveAttribute("aria-current", "true");
    expect(preferences).not.toHaveAttribute("aria-current");
  });

  it("defaults the section nav to Preferences without a hash", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "Preferences" });

    const nav = screen.getByRole("navigation", { name: "Account sections" });
    expect(nav.querySelector('a[href="#preferences"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("offers Appearance as a single-select toggle group synced through save", async () => {
    const update = vi.spyOn(api, "updatePreferences").mockResolvedValue({
      schemaVersion: 1,
      revision: 2,
      values: { "preference.appearance": "dark" },
      definitions: [definition],
      updatedAt: "2026-07-01T00:00:00Z",
    });
    renderPage();
    const group = await screen.findByRole("group", { name: "Appearance" });
    expect(group).toBeInTheDocument();
    expect(group.querySelector('[aria-pressed="true"]')).toHaveAccessibleName(
      "System",
    );

    await userEvent.click(screen.getByRole("button", { name: "Dark" }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        1,
        { "preference.appearance": "dark" },
        "token",
      ),
    );
  });
});
