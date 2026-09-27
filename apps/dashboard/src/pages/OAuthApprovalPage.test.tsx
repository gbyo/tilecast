// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthApprovalPage } from "./OAuthApprovalPage";
import { api } from "../api/client";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: { authenticated: true, csrfToken: "token" },
  }),
}));

const params =
  "client_id=tilecast-cli&redirect_uri=http%3A%2F%2F127.0.0.1%3A8471%2Fcallback" +
  "&scope=read&state=s1&code_challenge=abc&code_challenge_method=S256";

function renderPage() {
  vi.spyOn(api, "describeOAuthApproval").mockResolvedValue({
    client: { name: "tilecast-cli", clientId: "tilecast-public" },
    scopes: [{ scope: "read", description: "View things." }],
    redirectUri: "http://127.0.0.1:8471/callback",
    state: "s1",
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/oauth/approve?${params}`]}>
        <OAuthApprovalPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("OAuthApprovalPage", () => {
  it("shows the client, scopes, and redirect before deciding", async () => {
    renderPage();
    expect(await screen.findByText("Authorize access")).toBeInTheDocument();
    expect(screen.getByText("read")).toBeInTheDocument();
    expect(
      screen.getByText("http://127.0.0.1:8471/callback"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Authorize" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
  });

  it("denies with the parameters it displayed", async () => {
    const user = userEvent.setup();
    const deny = vi.spyOn(api, "denyOAuth").mockResolvedValue({
      redirectUri: "http://127.0.0.1:8471/callback?error=access_denied",
    });
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Deny" }));
    expect(deny).toHaveBeenCalledWith(
      {
        client: "tilecast-cli",
        redirectUri: "http://127.0.0.1:8471/callback",
        scope: "read",
        state: "s1",
        challenge: "abc",
        method: "S256",
      },
      "token",
    );
  });
});
