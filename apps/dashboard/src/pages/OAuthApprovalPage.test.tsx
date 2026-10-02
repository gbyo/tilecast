// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthApprovalPage } from "./OAuthApprovalPage";
import { ApiError, api } from "../api/client";
import { i18n } from "../i18n";

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

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await i18n.changeLanguage("en");
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

  it("presents approval load failures through the localized API error path", async () => {
    await i18n.changeLanguage("ru");
    vi.spyOn(api, "describeOAuthApproval").mockRejectedValue(
      new ApiError("Server-provided approval failure.", 429, "rate_limited"),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/oauth/approve?${params}`]}>
          <OAuthApprovalPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText(
        "Слишком много попыток. Подождите немного и повторите попытку.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Server-provided approval failure.")).toBe(null);
  });

  it("presents decision failures through the localized API error path", async () => {
    await i18n.changeLanguage("ru");
    vi.spyOn(api, "approveOAuth").mockRejectedValue(
      new ApiError("Server-provided decision failure.", 429, "rate_limited"),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Разрешить" }));

    expect(
      await screen.findByText(
        "Слишком много попыток. Подождите немного и повторите попытку.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Server-provided decision failure.")).toBe(null);
  });
});
