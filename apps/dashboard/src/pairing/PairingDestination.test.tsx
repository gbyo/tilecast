// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { PairingRequest, Screen } from "../api/types";
import {
  PairingDestination,
  type PairingOperation,
} from "./PairingDestination";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function pairingRequest(
  overrides: Partial<PairingRequest> = {},
): PairingRequest {
  return {
    id: "pairing",
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

function testScreen(overrides: Partial<Screen> = {}): Screen {
  return {
    id: "screen-1",
    name: "Lobby Display",
    description: "",
    location: "Main entrance",
    platform: "android-tv",
    deviceManufacturer: "Google",
    deviceModel: "ADT-3",
    androidVersion: "14",
    playerVersion: "0.10.1",
    screenWidth: 1920,
    screenHeight: 1080,
    density: 2,
    locale: "en-US",
    timezone: "UTC",
    enabled: true,
    pairedAt: new Date().toISOString(),
    lastContactAt: new Date().toISOString(),
    status: "online",
    hasActiveCredential: true,
    ...overrides,
  };
}

function renderDestination(
  request: PairingRequest,
  destination: PairingOperation,
  onChange: (destination: PairingOperation) => void = () => {},
  replacementScreenId = "",
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PairingDestination
        request={request}
        destination={destination}
        onChange={onChange}
        replacementScreenId={replacementScreenId}
        onReplacementScreenChange={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe("PairingDestination", () => {
  it("leads a fresh player to a new screen without a radio decision", () => {
    renderDestination(pairingRequest(), "new_screen");

    expect(screen.getByText("Create new screen")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Replacing an existing screen?" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("opens the hardware replacement path from the quiet secondary action", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderDestination(pairingRequest(), "new_screen", onChange);

    await user.click(
      screen.getByRole("button", { name: "Replacing an existing screen?" }),
    );

    expect(onChange).toHaveBeenCalledWith("replace_hardware");
  });

  it("asks only for the existing target during hardware replacement", async () => {
    vi.spyOn(api, "screens").mockResolvedValue({
      items: [
        testScreen({ id: "screen-1", name: "Lobby Display" }),
        testScreen({ id: "screen-2", name: "Cafeteria Display" }),
      ],
      total: 2,
    });
    renderDestination(pairingRequest(), "replace_hardware");

    expect(
      await screen.findByRole("combobox", { name: "Existing screen" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Screen name")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Location", { exact: false }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create a new screen instead" }),
    ).toBeInTheDocument();
  });

  it("leads a recognized player to reconnect with no alternate path", () => {
    renderDestination(
      pairingRequest({
        previouslyPaired: true,
        existingScreenId: "screen-1",
        existingScreenName: "Lobby Display",
        hasActiveCredential: true,
      }),
      "credential_repair",
    );

    expect(screen.getByText("Reconnect to Lobby Display")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Replacing an existing screen?" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});
