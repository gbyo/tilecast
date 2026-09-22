// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider as SpectrumProvider } from "@react-spectrum/s2/Provider";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthProvider";
import { AuthPage } from "./AuthPage";

const status = {
  setupRequired: false,
  authenticated: false,
  passkeysAvailable: true,
  passkeysUnavailableReason: "",
};

function renderLogin() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/login"]}>
        <AuthProvider>
          <SpectrumProvider>
            <AuthPage mode="login" />
          </SpectrumProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function jsonResponse(data: unknown, ok = true, statusCode = 200) {
  return {
    ok,
    status: statusCode,
    json: () => Promise.resolve(ok ? { data } : data),
  } as Response;
}

async function signIn() {
  await userEvent.type(
    await screen.findByLabelText("Email or username"),
    "owner@example.org",
  );
  await userEvent.type(screen.getByLabelText("Password"), "a long password");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("sign-in with a second factor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(cleanup);

  it("asks for a code instead of signing in when the account is enrolled", async () => {
    const fetchMock = vi.fn((input: string) => {
      const url = input;
      if (url.endsWith("/auth/status"))
        return Promise.resolve(jsonResponse(status));
      if (url.endsWith("/auth/login"))
        return Promise.resolve(
          jsonResponse({
            mfaRequired: true,
            challengeToken: "challenge-token",
            methods: ["totp", "recovery_code"],
          }),
        );
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderLogin();
    await signIn();

    expect(
      await screen.findByRole("heading", { name: "Two-step verification" }),
    ).toBeTruthy();
    // The password step must not have produced a session.
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("sends the challenge token with the verification code", async () => {
    const verify = vi.fn();
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      const url = input;
      if (url.endsWith("/auth/status"))
        return Promise.resolve(jsonResponse(status));
      if (url.endsWith("/auth/login"))
        return Promise.resolve(
          jsonResponse({
            mfaRequired: true,
            challengeToken: "challenge-token",
            methods: ["totp"],
          }),
        );
      if (url.endsWith("/auth/mfa/verify")) {
        verify(JSON.parse(init?.body as string));
        return Promise.resolve(
          jsonResponse({
            user: {
              id: "user-1",
              name: "Owner",
              username: "owner@example.org",
              role: "owner",
              active: true,
              createdAt: "2026-01-01T00:00:00Z",
            },
            csrfToken: "csrf",
            authMethod: "totp",
            mfaEnrollmentRequired: false,
          }),
        );
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderLogin();
    await signIn();
    await userEvent.type(
      await screen.findByLabelText("Verification code"),
      "123456",
    );
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() =>
      expect(verify).toHaveBeenCalledWith({
        challengeToken: "challenge-token",
        code: "123456",
      }),
    );
  });

  // A wrong code must leave the attempt open rather than dropping the user
  // back to the password form, which would waste the challenge.
  it("keeps the challenge open after an incorrect code", async () => {
    const fetchMock = vi.fn((input: string) => {
      const url = input;
      if (url.endsWith("/auth/status"))
        return Promise.resolve(jsonResponse(status));
      if (url.endsWith("/auth/login"))
        return Promise.resolve(
          jsonResponse({
            mfaRequired: true,
            challengeToken: "challenge-token",
            methods: ["totp"],
          }),
        );
      if (url.endsWith("/auth/mfa/verify"))
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: "invalid_code",
                message: "That code is not correct.",
              },
            },
            false,
            401,
          ),
        );
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderLogin();
    await signIn();
    await userEvent.type(
      await screen.findByLabelText("Verification code"),
      "000000",
    );
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That code is not correct.",
    );
    expect(screen.getByLabelText("Verification code")).toBeTruthy();
  });

  it("offers a passwordless passkey button only when the server supports it", async () => {
    const fetchMock = vi.fn((input: string) => {
      const url = input;
      if (url.endsWith("/auth/status"))
        return Promise.resolve(
          jsonResponse({
            ...status,
            passkeysAvailable: false,
            passkeysUnavailableReason: "Passkeys require HTTPS.",
          }),
        );
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderLogin();
    await screen.findByLabelText("Email or username");
    expect(
      screen.queryByRole("button", { name: "Sign in with a passkey" }),
    ).toBeNull();
  });
});
