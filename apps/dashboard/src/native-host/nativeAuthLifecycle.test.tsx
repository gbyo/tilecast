// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "@/auth/AuthProvider";
import { NativeHostProvider } from "./NativeHostProvider";
import { NativeAuthLifecycle } from "./useNativeAuthLifecycle";

const csrfToken = "csrf-for-this-session-only";

function authStatus(authenticated: boolean) {
  return {
    setupRequired: false,
    authenticated,
    ...(authenticated
      ? {
          csrfToken,
          user: {
            id: "user-1",
            name: "Tilecast User",
            username: "tilecast",
            role: "owner",
            active: true,
            createdAt: "2026-01-01T00:00:00Z",
          },
        }
      : {}),
  };
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify({ data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The server: signed in until a logout with the session's CSRF token. */
function stubServer({ logoutFails = false } = {}) {
  const state = { authenticated: true, logouts: [] as (string | null)[] };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | Request, init?: RequestInit) => {
      const request =
        input instanceof Request
          ? input
          : new Request(new URL(input, "http://studio.test"), init);
      if (request.url.endsWith("/auth/status")) {
        return Promise.resolve(jsonResponse(authStatus(state.authenticated)));
      }
      if (request.url.endsWith("/auth/logout")) {
        state.logouts.push(request.headers.get("X-CSRF-Token"));
        if (logoutFails) return Promise.reject(new TypeError("offline"));
        state.authenticated = false;
        return Promise.resolve(jsonResponse(null, 204));
      }
      return Promise.resolve(jsonResponse({}));
    }),
  );
  return state;
}

type Sent = { version: number; type: string; payload: unknown };

/**
 * The iOS app's handler. At each auth/signed-out it records what Studio
 * shows, to prove the host hears about the sign-out first.
 */
function installNativeHost({ authLifecycle = true } = {}) {
  const sent: Sent[] = [];
  const shownAtSignOut: string[] = [];
  const postMessage = vi.fn((message: Sent) => {
    sent.push(structuredClone(message));
    if (message.type === "auth/signed-out") {
      shownAtSignOut.push(screen.getByTestId("session").textContent ?? "");
    }
    if (message.type === "config/get") {
      return Promise.resolve({
        version: 1,
        ok: true,
        payload: {
          protocolVersion: 1,
          capabilities: { nativeNavigation: true, authLifecycle },
        },
      });
    }
    return Promise.resolve({ version: 1, ok: true, payload: {} });
  });
  window.webkit = { messageHandlers: { tilecastNative: { postMessage } } };
  return {
    sent,
    shownAtSignOut,
    types: () => sent.map((message) => message.type),
    requestSignOut() {
      let accepted: boolean | undefined;
      act(() => {
        accepted = window.tilecastNativeReceiver?.({
          version: 1,
          type: "auth/sign-out-request",
          payload: {},
        });
      });
      return accepted;
    },
  };
}

function SessionProbe() {
  const auth = useAuth();
  return (
    <>
      <p data-testid="session">
        {auth.status?.authenticated ? "Signed in" : "Signed out"}
      </p>
      <button type="button" onClick={() => void auth.logout()}>
        Sign out
      </button>
    </>
  );
}

function renderStudio() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <NativeHostProvider>
          <NativeAuthLifecycle />
          <SessionProbe />
        </NativeHostProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

async function signedIn() {
  expect(await screen.findByText("Signed in")).toBeInTheDocument();
}

describe("native auth lifecycle", () => {
  beforeEach(() => {
    delete window.webkit;
    delete window.tilecastNativeReceiver;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete window.webkit;
    delete window.tilecastNativeReceiver;
  });

  it("tells the host it supports the auth lifecycle and presentations", async () => {
    stubServer();
    const host = installNativeHost();
    renderStudio();
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));
    expect(host.sent.find((m) => m.type === "frontend/ready")?.payload).toEqual(
      {
        capabilities: {
          authLifecycle: true,
          nativePresentations: true,
          nativeMediaIntake: true,
          deepLinks: true,
        },
      },
    );
  });

  it("reports its own sign-out before it shows the signed-out state", async () => {
    stubServer();
    const host = installNativeHost();
    renderStudio();
    await signedIn();
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByText("Signed out")).toBeInTheDocument();
    expect(host.types().filter((t) => t === "auth/signed-out")).toHaveLength(1);
    expect(host.shownAtSignOut).toEqual(["Signed in"]);
  });

  it("signs out with its own CSRF token when the host asks", async () => {
    const server = stubServer();
    const host = installNativeHost();
    renderStudio();
    await signedIn();
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));

    expect(host.requestSignOut()).toBe(true);

    expect(await screen.findByText("Signed out")).toBeInTheDocument();
    expect(server.logouts).toEqual([csrfToken]);
    await waitFor(() => expect(host.types()).toContain("auth/signed-out"));
  });

  it("answers a sign-out request at once when already signed out", async () => {
    const server = stubServer();
    server.authenticated = false;
    const host = installNativeHost();
    renderStudio();
    expect(await screen.findByText("Signed out")).toBeInTheDocument();
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));

    expect(host.requestSignOut()).toBe(true);

    await waitFor(() => expect(host.types()).toContain("auth/signed-out"));
    expect(server.logouts).toEqual([]);
  });

  it("does not report a sign-out that failed", async () => {
    const server = stubServer({ logoutFails: true });
    const host = installNativeHost();
    renderStudio();
    await signedIn();
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));

    expect(host.requestSignOut()).toBe(true);

    await waitFor(() => expect(server.logouts).toHaveLength(1));
    expect(screen.getByText("Signed in")).toBeInTheDocument();
    expect(host.types()).not.toContain("auth/signed-out");
  });

  it("stays silent with a host that does not offer the lifecycle", async () => {
    stubServer();
    const host = installNativeHost({ authLifecycle: false });
    renderStudio();
    await signedIn();
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));

    expect(host.requestSignOut()).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByText("Signed out")).toBeInTheDocument();
    expect(host.types()).not.toContain("auth/signed-out");
  });

  it("signs out in a browser exactly as before", async () => {
    const server = stubServer();
    renderStudio();
    await signedIn();

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByText("Signed out")).toBeInTheDocument();
    expect(server.logouts).toEqual([csrfToken]);
    expect(window.tilecastNativeReceiver).toBeUndefined();
  });

  it("never gives the host a credential", async () => {
    stubServer();
    const host = installNativeHost();
    renderStudio();
    await signedIn();
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));
    host.requestSignOut();
    await waitFor(() => expect(host.types()).toContain("auth/signed-out"));

    const everything = JSON.stringify(host.sent);
    expect(everything).not.toContain(csrfToken);
    expect(everything).not.toMatch(/tilecast_session|tca_|tcr_|password/i);
  });
});
