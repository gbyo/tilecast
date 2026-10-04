// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { PairingRequest, Screen } from "../api/types";
import {
  NativePresentationContext,
  type NativePresentation,
} from "../native-presentation/presentationContext";
import { NativeHostProvider } from "../native-host/NativeHostProvider";
import { PairScreenPresentation } from "./PairScreenPresentation";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: { csrfToken: "csrf", user: { role: "owner" } },
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

function testScreen(): Screen {
  return {
    id: "screen-9",
    name: "Lobby Display",
    description: "",
    location: "",
    platform: "android-tv",
    deviceManufacturer: "Google",
    deviceModel: "ADT-3",
    androidVersion: "11",
    playerVersion: "0.10.1",
    screenWidth: 1920,
    screenHeight: 1080,
    density: 1.5,
    locale: "en-US",
    timezone: "America/New_York",
    enabled: true,
    pairedAt: new Date().toISOString(),
    lastContactAt: new Date().toISOString(),
    status: "online",
    hasActiveCredential: true,
  };
}

function renderPresentation(
  presentation: NativePresentation,
  initialPath = "/__native/modal/pair-screen",
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <NativeHostProvider>
        <NativePresentationContext.Provider value={presentation}>
          <MemoryRouter initialEntries={[initialPath]}>
            <Routes>
              <Route
                path="/__native/modal/pair-screen"
                element={<PairScreenPresentation />}
              />
              <Route
                path="/__native/modal/pair-screen/:requestId"
                element={<PairScreenPresentation />}
              />
            </Routes>
          </MemoryRouter>
        </NativePresentationContext.Provider>
      </NativeHostProvider>
    </QueryClientProvider>,
  );
}

function testPresentation(
  overrides: Partial<NativePresentation> = {},
): NativePresentation {
  return {
    presentationId: "p-1",
    update: vi.fn(),
    close: vi.fn(),
    navigate: vi.fn(),
    onAction: () => () => {},
    requestFullSize: vi.fn(),
    ...overrides,
  };
}

describe("PairScreenPresentation", () => {
  it("hosts the same pair flow with full native chrome", () => {
    const presentation = testPresentation();
    renderPresentation(presentation);

    expect(
      screen.getByRole("textbox", { name: "Pairing code" }),
    ).toBeInTheDocument();
    const update = vi.mocked(presentation.update);
    expect(update).toHaveBeenCalled();
    const chrome = update.mock.calls.at(-1)?.[0];
    expect(chrome).toMatchObject({
      size: "full",
      dismissible: true,
    });
    expect(chrome?.header?.title).toBe("Pair a screen");
  });

  it("opens a paired screen through the presentation and closes on done", async () => {
    const user = userEvent.setup();
    const presentation = testPresentation();
    vi.spyOn(api, "resolvePairing").mockResolvedValue(pairingRequest());
    vi.spyOn(api, "locations").mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(api, "approvePairing").mockResolvedValue(testScreen());
    renderPresentation(presentation);

    await user.type(
      screen.getByRole("textbox", { name: "Pairing code" }),
      "k7q2xd",
    );
    await user.click(screen.getByRole("button", { name: "Find player" }));
    await screen.findByRole("heading", { name: "Review this player" });
    await user.click(screen.getByRole("button", { name: "Approve and pair" }));
    await screen.findByRole("heading", { name: "“Lobby Display” paired" });

    await user.click(screen.getByRole("button", { name: "Open screen" }));
    expect(presentation.navigate).toHaveBeenCalledWith("/screens/screen-9");
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(presentation.close).toHaveBeenCalled();
  });

  it("opens a pending request directly from its id", async () => {
    const presentation = testPresentation();
    vi.spyOn(api, "pendingPairings").mockResolvedValue({
      items: [pairingRequest()],
      total: 1,
    });
    vi.spyOn(api, "locations").mockResolvedValue({ items: [], total: 0 });
    renderPresentation(presentation, "/__native/modal/pair-screen/pairing-1");

    expect(
      await screen.findByRole("heading", { name: "Review this player" }),
    ).toBeInTheDocument();
  });
});
