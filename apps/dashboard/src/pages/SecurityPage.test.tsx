// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { SecurityStatus } from "../api/types";
import { SecurityPanels } from "./SecurityPage";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ status: { csrfToken: "csrf" } }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const tabs = [
  "Authenticator app",
  "Passkeys",
  "Recovery codes",
  "Authorized operators",
  "Personal access tokens",
] as const;

function renderPanels(status?: Partial<SecurityStatus>) {
  vi.spyOn(api, "listOAuthGrants").mockResolvedValue({ grants: [] });
  vi.spyOn(api, "listPersonalAccessTokens").mockResolvedValue({ pats: [] });
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <SecurityPanels
          status={{
            relyingPartyId: "tilecast.test",
            userHandle: "",
            totpEnrolled: false,
            passkeys: [],
            recoveryCodesRemaining: 10,
            enrolled: false,
            passkeysAvailable: false,
            passkeysUnavailableReason: "unsupported",
            required: true,
            policy: "all",
            authMethod: "password",
            ...status,
          }}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function panel(name: string) {
  const heading = screen.getByRole("heading", { name, hidden: true });
  const tabpanel = heading.closest('[role="tabpanel"]');
  expect(tabpanel).not.toBeNull();
  return tabpanel!;
}

describe("SecurityPanels sections", () => {
  it("opens on the authenticator section with every area one tab away", () => {
    renderPanels();
    const tablist = screen.getByRole("tablist");
    expect(
      within(tablist)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual([...tabs]);
    expect(
      within(tablist).getByRole("tab", { name: "Authenticator app" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(panel("Authenticator app")).toBeVisible();
    expect(panel("Passkeys")).not.toBeVisible();
  });

  it("switches sections without unmounting the others", () => {
    renderPanels();
    fireEvent.click(screen.getByRole("tab", { name: "Passkeys" }));
    expect(screen.getByRole("tab", { name: "Passkeys" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(panel("Passkeys")).toBeVisible();
    expect(panel("Authenticator app")).not.toBeVisible();
    // Inactive panels stay mounted so in-progress flows survive switching.
    expect(
      screen.getByRole("heading", { name: "Authenticator app", hidden: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Recovery codes", hidden: true }),
    ).toBeInTheDocument();
  });

  it("reaches every section from its tab", async () => {
    renderPanels();
    // The grant and token sections render once their queries resolve.
    await screen.findByRole("heading", {
      name: "Authorized operators",
      hidden: true,
    });
    await screen.findByRole("heading", {
      name: "Personal access tokens",
      hidden: true,
    });
    for (const name of tabs) {
      fireEvent.click(screen.getByRole("tab", { name }));
      expect(panel(name)).toBeVisible();
    }
  });
});
