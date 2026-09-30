// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthGrantsBlock } from "./OAuthGrantsBlock";
import { api } from "../api/client";
import type { OAuthGrant } from "../api/types";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: { authenticated: true, csrfToken: "token" },
  }),
}));

const grants: OAuthGrant[] = [
  {
    id: "grant-1",
    client: "tilecast-cli",
    scopes: ["read", "write"],
    createdAt: "2026-09-01T00:00:00Z",
  },
];

function renderBlock() {
  vi.spyOn(api, "listOAuthGrants").mockResolvedValue({ grants });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OAuthGrantsBlock />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("OAuthGrantsBlock", () => {
  it("lists grants with scopes and revokes one", async () => {
    const user = userEvent.setup();
    const revoke = vi
      .spyOn(api, "revokeOAuthGrant")
      .mockResolvedValue(undefined);
    renderBlock();
    expect(await screen.findByText("tilecast-cli")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(revoke).toHaveBeenCalledWith("grant-1", "token"),
    );
  });

  it("names an empty grant list", async () => {
    vi.spyOn(api, "listOAuthGrants").mockResolvedValueOnce({ grants: [] });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <OAuthGrantsBlock />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(
      await screen.findByText("No operators are authorized."),
    ).toBeInTheDocument();
  });

  it("shows a failed query without an empty grant list", async () => {
    const listGrants = vi
      .spyOn(api, "listOAuthGrants")
      .mockRejectedValueOnce(new Error("offline"));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <OAuthGrantsBlock />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(listGrants).toHaveBeenCalled(), {
      timeout: 1000,
    });
    expect(
      await screen.findByText(
        "Authorization grants could not be loaded.",
        {},
        { timeout: 1000 },
      ),
    ).toHaveAttribute("role", "alert");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});
