// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersonalAccessTokensBlock } from "./PersonalAccessTokensBlock";
import { api } from "../api/client";
import type { PersonalAccessToken } from "../api/types";
import { toast } from "../components/ui/toast";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: { authenticated: true, csrfToken: "token" },
  }),
}));

const live: PersonalAccessToken = {
  id: "pat-1",
  name: "ci-deploy",
  scopes: ["read"],
  createdAt: "2026-09-01T00:00:00Z",
  expiresAt: new Date(Date.now() + 29 * 86_400_000).toISOString(),
};

const expired: PersonalAccessToken = {
  id: "pat-2",
  name: "old-script",
  scopes: ["read", "write"],
  createdAt: "2026-01-01T00:00:00Z",
  expiresAt: "2026-01-08T00:00:00Z",
};

function renderBlock() {
  vi.spyOn(api, "listPersonalAccessTokens").mockResolvedValue({
    pats: [live, expired],
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PersonalAccessTokensBlock />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PersonalAccessTokensBlock", () => {
  it("lists tokens with a lifetime countdown and an expired badge", async () => {
    renderBlock();
    expect(await screen.findByText("ci-deploy")).toBeInTheDocument();
    expect(screen.getByText(/29d left/)).toBeInTheDocument();
    expect(screen.getByText(/old-script.*Expired/)).toBeInTheDocument();
  });

  it("names token scopes by their labels, not their identifiers", async () => {
    renderBlock();

    // The second fixture token carries read and write scopes.
    expect(await screen.findByText(/Read · Write/)).toBeInTheDocument();
    expect(screen.queryByText(/read · write/)).toBeNull();
  });

  it("shows the new secret once on a confirmation screen", async () => {
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValueOnce(new Error("Clipboard denied"))
      .mockResolvedValue(undefined);
    const feedback = vi.spyOn(toast, "add");
    const create = vi
      .spyOn(api, "createPersonalAccessToken")
      .mockResolvedValue({
        token: "tcp_new-secret",
        pat: { ...live, id: "pat-3", name: "fresh" },
      });
    renderBlock();
    await screen.findByText("ci-deploy");

    await user.type(screen.getByLabelText("Token name"), "fresh");
    await user.click(screen.getByRole("button", { name: "Create token" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        { name: "fresh", scopes: ["read"], expiresInDays: 30 },
        "token",
      ),
    );
    expect(
      await screen.findByDisplayValue("tcp_new-secret"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() =>
      expect(feedback).toHaveBeenCalledWith({
        title: "New personal access token could not be copied.",
        type: "error",
      }),
    );
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(
      await screen.findByRole("button", { name: "Copied" }),
    ).toBeInTheDocument();
    expect(writeText).toHaveBeenLastCalledWith("tcp_new-secret");
    expect(feedback).toHaveBeenCalledWith({
      title: "New personal access token copied.",
      type: "success",
    });

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText("ci-deploy")).toBeInTheDocument();
    expect(
      screen.queryByDisplayValue("tcp_new-secret"),
    ).not.toBeInTheDocument();
  });

  it("searches by name and revokes through the grant endpoint", async () => {
    const user = userEvent.setup();
    const list = vi
      .spyOn(api, "listPersonalAccessTokens")
      .mockResolvedValue({ pats: [live] });
    const revoke = vi
      .spyOn(api, "revokeOAuthGrant")
      .mockResolvedValue(undefined);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <PersonalAccessTokensBlock />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByText("ci-deploy");
    await user.type(screen.getByLabelText("Search tokens by name…"), "deploy");
    await waitFor(() => expect(list).toHaveBeenCalledWith("deploy"));
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("pat-1", "token"));
  });
});
