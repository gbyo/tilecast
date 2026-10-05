// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountIndexRedirect, MyAccountPage } from "./MyAccountPage";
import { PreferencesPage } from "./PreferencesPage";
import { SecurityPage } from "./SecurityPage";
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

const preferenceResponse = {
  schemaVersion: 1,
  revision: 1,
  values: { "preference.appearance": "system" },
  definitions: [definition],
  updatedAt: "2026-07-01T00:00:00Z",
};

function renderPage(
  initialEntry = "/account/preferences",
  loadPreferences: typeof api.preferences = () =>
    Promise.resolve(preferenceResponse),
) {
  const preferences = vi
    .spyOn(api, "preferences")
    .mockImplementation(loadPreferences);
  const securityStatus = vi.spyOn(api, "security").mockResolvedValue(security);
  vi.spyOn(api, "listOAuthGrants").mockResolvedValue({ grants: [] });
  vi.spyOn(api, "listPersonalAccessTokens").mockResolvedValue({ pats: [] });

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      {
        path: "account",
        element: <MyAccountPage />,
        children: [
          { index: true, element: <AccountIndexRedirect /> },
          { path: "preferences", element: <PreferencesPage /> },
          { path: "security", element: <SecurityPage /> },
        ],
      },
    ],
    { initialEntries: [initialEntry] },
  );

  const result = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...result, router, preferences, securityStatus };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MyAccountPage", () => {
  it("redirects the Account root to the real Preferences route", async () => {
    const { router } = renderPage("/account");
    await screen.findByRole("heading", { name: "Preferences" });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/account/preferences"),
    );
  });

  it("preserves the retired security hash as a real route", async () => {
    const { router } = renderPage("/account#security");
    await screen.findByRole("heading", { name: "Sign-in security" });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/account/security"),
    );
    expect(router.state.location.hash).toBe("");
  });

  it("names the account being edited, with its role", async () => {
    renderPage();
    const identity = await screen.findByText("Ada Lovelace");
    expect(identity.parentElement).toHaveTextContent("Signed in as");
    expect(identity.parentElement).toHaveTextContent("ada · Editor");
  });

  it("uses real account links and marks the current route", async () => {
    renderPage("/account/security");
    await screen.findByRole("heading", { name: "Sign-in security" });

    const nav = screen.getByRole("navigation", { name: "Account sections" });
    expect(
      nav.querySelector('a[href="/account/security"]'),
    ).toHaveAttribute("aria-current", "page");
    expect(
      nav.querySelector('a[href="/account/preferences"]'),
    ).not.toHaveAttribute("aria-current");
  });

  it("mounts only the selected account page", async () => {
    const preferencesView = renderPage("/account/preferences");
    await screen.findByRole("group", { name: "Appearance" });
    expect(preferencesView.preferences).toHaveBeenCalledTimes(1);
    expect(preferencesView.securityStatus).not.toHaveBeenCalled();
    cleanup();
    vi.restoreAllMocks();

    const securityView = renderPage("/account/security");
    await screen.findByRole("heading", { name: "Authenticator app" });
    expect(securityView.securityStatus).toHaveBeenCalledTimes(1);
    expect(securityView.preferences).not.toHaveBeenCalled();
  });

  it("nests the security panels under the route heading", async () => {
    renderPage("/account/security");
    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: "Sign-in security",
      }),
    ).toBeInTheDocument();
    await screen.findByRole("heading", { name: "Authenticator app" });
    for (const name of ["Authenticator app", "Passkeys", "Recovery codes"]) {
      expect(
        screen.getByRole("heading", { level: 3, name, hidden: true }),
      ).toBeInTheDocument();
    }
  });

  it("does not put a panel inside a panel", async () => {
    const { container } = renderPage("/account/security");
    await screen.findByRole("heading", {
      name: "Recovery codes",
      hidden: true,
    });
    expect(container.querySelector(".panel .panel")).toBeNull();
  });

  it("confirms before leaving an unsaved Preferences draft for Security", async () => {
    const { router } = renderPage("/account/preferences");
    await screen.findByRole("group", { name: "Appearance" });

    await userEvent.click(screen.getByRole("button", { name: "Dark" }));
    await userEvent.click(
      screen.getByRole("link", { name: "Sign-in security" }),
    );

    expect(router.state.location.pathname).toBe("/account/preferences");
    expect(
      await screen.findByText(
        "Leave My Account with unsaved preference changes?",
      ),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Discard changes" }),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/account/security"),
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

  it("shows a retry state when preferences fail to load", async () => {
    let calls = 0;
    const loadPreferences: typeof api.preferences = vi.fn(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("network failure"))
        : Promise.resolve(preferenceResponse);
    });
    renderPage("/account/preferences", loadPreferences);

    expect(
      await screen.findByText("Preferences could not be loaded."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Appearance" }),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(
      await screen.findByRole("group", { name: "Appearance" }),
    ).toBeInTheDocument();
    expect(loadPreferences).toHaveBeenCalledTimes(2);
  });
});
