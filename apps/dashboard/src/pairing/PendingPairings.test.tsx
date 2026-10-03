// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PairingRequest } from "../api/types";
import { NativeHostProvider } from "../native-host/NativeHostProvider";
import { PendingPairings } from "./PendingPairings";

type Sent = { version: number; type: string; payload: Record<string, unknown> };

function installNativeHost({
  capabilities = {},
  replies = {},
}: {
  capabilities?: Record<string, boolean>;
  replies?: Record<string, () => unknown>;
} = {}) {
  const sent: Sent[] = [];
  const postMessage = vi.fn((message: Sent) => {
    sent.push(structuredClone(message));
    if (message.type === "config/get") {
      return Promise.resolve({
        version: 1,
        ok: true,
        payload: {
          protocolVersion: 1,
          context: "main",
          capabilities: { nativeNavigation: false, ...capabilities },
        },
      });
    }
    const reply = replies[message.type];
    return Promise.resolve(
      reply ? reply() : { version: 1, ok: true, payload: {} },
    );
  });
  window.webkit = { messageHandlers: { tilecastNative: { postMessage } } };
  return {
    sent,
    ofType: (type: string) =>
      sent.filter((message) => message.type === type).map((m) => m.payload),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  // @ts-expect-error the harness replaces the native handler per test.
  delete window.webkit;
  // @ts-expect-error the harness replaces the native receiver per test.
  delete window.tilecastNativeReceiver;
});

afterEach(() => {
  cleanup();
});

function pairingRequest(overrides: Partial<PairingRequest> = {}): PairingRequest {
  return {
    id: "pairing-1",
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 60_000).toISOString(),
    previouslyPaired: false,
    hasActiveCredential: false,
    credentialReplacementAuthorized: false,
    metadata: {
      playerInstallationId: "installation",
      platform: "android-tv",
      manufacturer: "Google",
      model: "ADT-3",
      androidVersion: "11",
      playerVersion: "0.10.1",
      screenWidth: 1920,
      screenHeight: 1080,
      density: 1.5,
      locale: "en-US",
      timezone: "America/New_York",
    },
    ...overrides,
  };
}

function Pathname() {
  return <output>{useLocation().pathname}</output>;
}

function renderPending(requests: PairingRequest[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <NativeHostProvider>
        <MemoryRouter initialEntries={["/screens"]}>
          <Pathname />
          <Routes>
            <Route
              path="/screens"
              element={
                <PendingPairings requests={requests} canManage />
              }
            />
            <Route
              path="/screens/pair/request/:requestId"
              element={<p>Browser review</p>}
            />
          </Routes>
        </MemoryRouter>
      </NativeHostProvider>
    </QueryClientProvider>,
  );
}

describe("PendingPairings", () => {
  it("renders nothing without pending requests", () => {
    renderPending([]);
    expect(screen.queryByText("Waiting for approval")).not.toBeInTheDocument();
  });

  it("lists waiting players as an operational section, not an alert", () => {
    renderPending([
      pairingRequest(),
      pairingRequest({
        id: "pairing-2",
        metadata: {
          playerInstallationId: "installation-2",
          platform: "linux",
          manufacturer: "Raspberry Pi",
          model: "5",
          androidVersion: "none",
          playerVersion: "0.10.1",
          screenWidth: 1920,
          screenHeight: 1080,
          density: 1,
          locale: "en-US",
          timezone: "America/New_York",
        },
      }),
    ]);

    expect(
      screen.getByRole("heading", { name: "Waiting for approval" }),
    ).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("Google ADT-3")).toBeInTheDocument();
    expect(screen.getByText("Raspberry Pi 5")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reviews in the browser route without a native host", async () => {
    const user = userEvent.setup();
    renderPending([pairingRequest()]);

    const review = screen.getByRole("link", { name: "Review" });
    expect(review).toHaveAttribute(
      "href",
      "/screens/pair/request/pairing-1",
    );
    await user.click(review);

    expect(await screen.findByText("Browser review")).toBeInTheDocument();
    expect(screen.getByText("/screens/pair/request/pairing-1")).toBeInTheDocument();
  });

  it("opens review in a native presentation when accepted", async () => {
    const user = userEvent.setup();
    const host = installNativeHost({
      capabilities: { nativePresentations: true },
    });
    renderPending([pairingRequest()]);
    await waitFor(() =>
      expect(host.ofType("frontend/ready")).toHaveLength(1),
    );

    await user.click(screen.getByRole("link", { name: "Review" }));

    await waitFor(() =>
      expect(host.ofType("presentation/open")).toHaveLength(1),
    );
    expect(host.ofType("presentation/open")[0]).toMatchObject({
      path: "/__native/modal/pair-screen/pairing-1",
      title: "Pair a screen",
      size: "full",
      dismissible: true,
    });
    expect(screen.getByText("/screens")).toBeInTheDocument();
    expect(screen.queryByText("Browser review")).not.toBeInTheDocument();
  });

  it("falls back to the browser route when the host refuses", async () => {
    const user = userEvent.setup();
    const host = installNativeHost({
      capabilities: { nativePresentations: true },
      replies: {
        "presentation/open": () => ({
          version: 1,
          ok: false,
          error: { code: "unavailable" },
        }),
      },
    });
    renderPending([pairingRequest()]);
    await waitFor(() =>
      expect(host.ofType("frontend/ready")).toHaveLength(1),
    );

    await user.click(screen.getByRole("link", { name: "Review" }));

    expect(await screen.findByText("Browser review")).toBeInTheDocument();
  });
});
