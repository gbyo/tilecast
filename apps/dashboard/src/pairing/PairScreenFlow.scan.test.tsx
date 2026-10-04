// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { PairingRequest } from "../api/types";
import { NativeHostProvider } from "../native-host/NativeHostProvider";
import { PairScreenFlow } from "./PairScreenFlow";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: { csrfToken: "csrf", user: { role: "owner" } },
  }),
}));

type Sent = { version: number; type: string; payload: Record<string, unknown> };

const INSTALLATION_ID = "11111111-2222-4333-8444-555555555555";

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
          context: "presentation",
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
    deliver(type: string, payload: Record<string, unknown>) {
      act(() => {
        window.tilecastNativeReceiver?.({ version: 1, type, payload });
      });
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  delete window.webkit;
  delete window.tilecastNativeReceiver;
  vi.spyOn(api, "systemIdentity").mockResolvedValue({
    product: "tilecast",
    installationId: INSTALLATION_ID,
    organizationName: "Greenwood Schools",
    apiVersion: "v1",
    pairingEnabled: true,
  });
  vi.spyOn(api, "locations").mockResolvedValue({ items: [], total: 0 });
});

afterEach(() => {
  cleanup();
});

function pairingRequest(): PairingRequest {
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
  };
}

function renderFlow() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <NativeHostProvider>
        <MemoryRouter>
          <PairScreenFlow
            canManage
            onClose={() => {}}
            onOpenScreen={() => {}}
          />
        </MemoryRouter>
      </NativeHostProvider>
    </QueryClientProvider>,
  );
}

describe("PairScreenFlow scanner", () => {
  it("offers no scan action without the scanner capability", () => {
    installNativeHost({ capabilities: {} });
    renderFlow();

    expect(
      screen.queryByRole("button", { name: "Scan QR code" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Enter the six-character code displayed by Tilecast Player.",
      ),
    ).toBeInTheDocument();
  });

  it("resolves a scanned code against the active server", async () => {
    const user = userEvent.setup();
    const host = installNativeHost({
      capabilities: { systemQrScanner: true },
    });
    const resolve = vi
      .spyOn(api, "resolvePairing")
      .mockResolvedValue(pairingRequest());
    renderFlow();
    await screen.findByRole("button", { name: "Scan QR code" });

    await user.click(screen.getByRole("button", { name: "Scan QR code" }));
    await waitFor(() => expect(host.ofType("system/scan-qr")).toHaveLength(1));
    // A new-server QR names the same installation behind another origin; the
    // scanned host never becomes trusted and no navigation happens.
    host.deliver("system/qr-scan-result", {
      requestId: host.ofType("system/scan-qr")[0]?.requestId,
      outcome: "scanned",
      value: `https://signage.example.org/screens/pair/K7Q2XD?installation=${INSTALLATION_ID}`,
    });

    expect(
      await screen.findByRole("heading", { name: "Review this player" }),
    ).toBeInTheDocument();
    expect(resolve).toHaveBeenCalledWith("K7Q2XD");
  });

  it("accepts an old-server QR only from the connected origin", async () => {
    const user = userEvent.setup();
    const host = installNativeHost({
      capabilities: { systemQrScanner: true },
    });
    const resolve = vi
      .spyOn(api, "resolvePairing")
      .mockResolvedValue(pairingRequest());
    renderFlow();
    await screen.findByRole("button", { name: "Scan QR code" });

    await user.click(screen.getByRole("button", { name: "Scan QR code" }));
    await waitFor(() => expect(host.ofType("system/scan-qr")).toHaveLength(1));
    host.deliver("system/qr-scan-result", {
      requestId: host.ofType("system/scan-qr")[0]?.requestId,
      outcome: "scanned",
      value: `${window.location.origin}/screens/pair/K7Q2XD`,
    });

    expect(
      await screen.findByRole("heading", { name: "Review this player" }),
    ).toBeInTheDocument();
    expect(resolve).toHaveBeenCalledWith("K7Q2XD");
  });

  it("refuses a QR from another installation without a lookup", async () => {
    const user = userEvent.setup();
    const host = installNativeHost({
      capabilities: { systemQrScanner: true },
    });
    const resolve = vi.spyOn(api, "resolvePairing");
    renderFlow();
    await screen.findByRole("button", { name: "Scan QR code" });

    await user.click(screen.getByRole("button", { name: "Scan QR code" }));
    await waitFor(() => expect(host.ofType("system/scan-qr")).toHaveLength(1));
    host.deliver("system/qr-scan-result", {
      requestId: host.ofType("system/scan-qr")[0]?.requestId,
      outcome: "scanned",
      value:
        "https://signage.example.org/screens/pair/K7Q2XD?installation=99999999-2222-4333-8444-555555555555",
    });

    expect(
      await screen.findByText(
        "This QR code belongs to another Tilecast installation.",
      ),
    ).toBeInTheDocument();
    expect(resolve).not.toHaveBeenCalled();
    expect(
      screen.getByRole("textbox", { name: "Pairing code" }),
    ).toBeInTheDocument();
  });

  it("refuses an old-server QR from another origin", async () => {
    const user = userEvent.setup();
    const host = installNativeHost({
      capabilities: { systemQrScanner: true },
    });
    const resolve = vi.spyOn(api, "resolvePairing");
    renderFlow();
    await screen.findByRole("button", { name: "Scan QR code" });

    await user.click(screen.getByRole("button", { name: "Scan QR code" }));
    await waitFor(() => expect(host.ofType("system/scan-qr")).toHaveLength(1));
    host.deliver("system/qr-scan-result", {
      requestId: host.ofType("system/scan-qr")[0]?.requestId,
      outcome: "scanned",
      value: "https://other.example.org/screens/pair/K7Q2XD",
    });

    expect(
      await screen.findByText(
        "This QR code belongs to another Tilecast server.",
      ),
    ).toBeInTheDocument();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects a non-pairing QR payload", async () => {
    const user = userEvent.setup();
    const host = installNativeHost({
      capabilities: { systemQrScanner: true },
    });
    const resolve = vi.spyOn(api, "resolvePairing");
    renderFlow();
    await screen.findByRole("button", { name: "Scan QR code" });

    await user.click(screen.getByRole("button", { name: "Scan QR code" }));
    await waitFor(() => expect(host.ofType("system/scan-qr")).toHaveLength(1));
    host.deliver("system/qr-scan-result", {
      requestId: host.ofType("system/scan-qr")[0]?.requestId,
      outcome: "scanned",
      value: "https://example.com/not-tilecast",
    });

    expect(
      await screen.findByText("This QR code is not a Tilecast pairing code."),
    ).toBeInTheDocument();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("leaves manual entry intact when the scan is cancelled", async () => {
    const user = userEvent.setup();
    const host = installNativeHost({
      capabilities: { systemQrScanner: true },
    });
    const resolve = vi.spyOn(api, "resolvePairing");
    renderFlow();
    await screen.findByRole("button", { name: "Scan QR code" });

    await user.click(screen.getByRole("button", { name: "Scan QR code" }));
    await waitFor(() => expect(host.ofType("system/scan-qr")).toHaveLength(1));
    host.deliver("system/qr-scan-result", {
      requestId: host.ofType("system/scan-qr")[0]?.requestId,
      outcome: "cancelled",
    });

    expect(resolve).not.toHaveBeenCalled();
    expect(
      screen.getByRole("textbox", { name: "Pairing code" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Scan QR code" }),
      ).toBeEnabled(),
    );
  });

  it("keeps manual entry when the host refuses the scan", async () => {
    const user = userEvent.setup();
    installNativeHost({
      capabilities: { systemQrScanner: true },
      replies: {
        "system/scan-qr": () => ({
          version: 1,
          ok: false,
          error: { code: "unavailable" },
        }),
      },
    });
    const resolve = vi.spyOn(api, "resolvePairing");
    renderFlow();

    await user.click(
      await screen.findByRole("button", { name: "Scan QR code" }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Scan QR code" }),
      ).toBeEnabled(),
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(
      screen.getByRole("textbox", { name: "Pairing code" }),
    ).toBeInTheDocument();
  });
});
