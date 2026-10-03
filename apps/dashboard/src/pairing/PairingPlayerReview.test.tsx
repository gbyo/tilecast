// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PairingRequest } from "../api/types";
import { PairingPlayerReview } from "./PairingPlayerReview";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function pairingRequest(overrides: Partial<PairingRequest> = {}): PairingRequest {
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
      approximateAddress: "192.168.1.50",
    },
    ...overrides,
  };
}

describe("PairingPlayerReview", () => {
  it("leads with device identity and expiry", () => {
    render(<PairingPlayerReview request={pairingRequest()} />);

    expect(screen.getByText("Google ADT-3")).toBeInTheDocument();
    expect(screen.getByText(/Android TV/)).toBeInTheDocument();
    expect(screen.getByText(/Expires /)).toBeInTheDocument();
    expect(
      screen.getByText(
        "Compare these details with the physical display before approving.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Previously paired")).not.toBeInTheDocument();
  });

  it("marks a previously paired player", () => {
    render(
      <PairingPlayerReview
        request={pairingRequest({
          previouslyPaired: true,
          existingScreenId: "screen-1",
          existingScreenName: "Lobby Display",
          hasActiveCredential: true,
        })}
      />,
    );

    expect(screen.getByText("Previously paired")).toBeInTheDocument();
  });

  it("keeps verification metadata behind a disclosure", async () => {
    const user = userEvent.setup();
    render(<PairingPlayerReview request={pairingRequest()} />);

    expect(screen.queryByText("192.168.1.50")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Technical details" }),
    );

    expect(screen.getByText("192.168.1.50")).toBeInTheDocument();
    expect(screen.getByText("0.10.1")).toBeInTheDocument();
    expect(screen.getByText("en-US · America/New_York")).toBeInTheDocument();
  });

  it("omits the OS row when the player reports no Android version", async () => {
    const user = userEvent.setup();
    render(
      <PairingPlayerReview
        request={pairingRequest({
          metadata: {
            playerInstallationId: "installation",
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
        })}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Technical details" }),
    );

    expect(screen.queryByText("none")).not.toBeInTheDocument();
  });
});
