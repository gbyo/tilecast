// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/errors";
import type { PairingRequest } from "../api/types";
import { i18n } from "../i18n";
import {
  defaultPairingDestination,
  deviceLabel,
  hardwareApprovalInput,
  pairingApprovalLabel,
  pairingApprovalPayload,
  repairApprovalInput,
  resolvePairingErrorMessage,
} from "./pairingFlow";

const t = i18n.getFixedT("en", "screens");

function pairingRequest(
  overrides: Partial<PairingRequest> = {},
): PairingRequest {
  return {
    id: "pairing",
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    previouslyPaired: false,
    hasActiveCredential: false,
    credentialReplacementAuthorized: false,
    metadata: {
      playerInstallationId: "installation",
      platform: "android-tv",
      manufacturer: "Amazon",
      model: "Fire TV",
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

describe("pairing approval payload", () => {
  it("uses an explicit credential-replacement payload for known players", () => {
    const request = pairingRequest({
      previouslyPaired: true,
      existingScreenId: "screen-1",
      existingScreenName: "Cafeteria Display",
      hasActiveCredential: true,
    });
    expect(pairingApprovalLabel(request, t)).toBe(
      "Repair and replace credential",
    );
    expect(
      pairingApprovalPayload(request, {
        name: "Cafeteria Display",
        locationId: undefined,
        roomName: "Cafeteria",
        roomNumber: "",
        description: "",
      }),
    ).toEqual({
      name: "Cafeteria Display",
      locationId: undefined,
      roomName: "Cafeteria",
      roomNumber: "",
      description: "",
      replaceExistingCredential: true,
    });
  });

  it("uses a separate hardware replacement payload", () => {
    const request = pairingRequest({
      metadata: {
        playerInstallationId: "new-installation",
        platform: "linux",
        manufacturer: "Intel",
        model: "NUC",
        androidVersion: "none",
        playerVersion: "0.10.1",
        screenWidth: 1920,
        screenHeight: 1080,
        density: 1,
        locale: "en-US",
        timezone: "America/New_York",
      },
    });
    expect(pairingApprovalLabel(request, t, "replace_hardware")).toBe(
      "Replace hardware",
    );
    expect(
      pairingApprovalPayload(
        request,
        {
          name: "Ignored logical name",
          locationId: undefined,
          roomName: "",
          roomNumber: "",
          description: "",
        },
        "replace_hardware",
        "screen-1",
      ),
    ).toMatchObject({
      replaceExistingCredential: false,
      replaceHardware: true,
      replacementScreenId: "screen-1",
    });
  });
});

describe("pairing destination", () => {
  it("leads a fresh player to a new screen", () => {
    expect(defaultPairingDestination(pairingRequest())).toBe("new_screen");
  });

  it("leads a recognized player to credential repair", () => {
    const request = pairingRequest({
      previouslyPaired: true,
      existingScreenId: "screen-1",
      existingScreenName: "Lobby Display",
      hasActiveCredential: true,
    });
    expect(defaultPairingDestination(request)).toBe("credential_repair");
    expect(pairingApprovalLabel(request, t, "credential_repair")).toBe(
      "Repair and replace credential",
    );
  });
});

describe("repair approval input", () => {
  it("carries the existing screen name instead of blank metadata", () => {
    const request = pairingRequest({
      previouslyPaired: true,
      existingScreenId: "screen-1",
      existingScreenName: "Lobby Display",
      hasActiveCredential: true,
    });
    expect(repairApprovalInput(request)).toEqual({
      name: "Lobby Display",
      locationId: undefined,
      roomName: "",
      roomNumber: "",
      description: "",
    });
    const payload = pairingApprovalPayload(
      request,
      repairApprovalInput(request),
      "credential_repair",
    );
    expect(payload.replaceExistingCredential).toBe(true);
    expect(payload.name).toBe("Lobby Display");
  });

  it("falls back to the device description when the screen name is missing", () => {
    const request = pairingRequest({
      previouslyPaired: true,
      hasActiveCredential: true,
    });
    expect(repairApprovalInput(request).name).toBe("Amazon Fire TV");
  });

  it("describes the physical device from reported metadata", () => {
    expect(deviceLabel(pairingRequest())).toBe("Amazon Fire TV");
  });
});

describe("hardware approval input", () => {
  it("sends no logical metadata for hardware replacement", () => {
    expect(hardwareApprovalInput()).toEqual({
      name: "",
      locationId: undefined,
      roomName: "",
      roomNumber: "",
      description: "",
    });
  });
});

describe("resolve pairing errors", () => {
  it("distinguishes unknown codes from expired ones", () => {
    expect(
      resolvePairingErrorMessage(new ApiError("gone", 404, "not_found"), t),
    ).toBe("No waiting player matches this code.");
    expect(
      resolvePairingErrorMessage(
        new ApiError("gone", 410, "pairing_expired"),
        t,
      ),
    ).toBe("This pairing code has expired.");
  });

  it("shares one generic message for network and server failures", () => {
    expect(resolvePairingErrorMessage(new TypeError("fetch failed"), t)).toBe(
      "Pairing code could not be resolved.",
    );
    expect(
      resolvePairingErrorMessage(
        new ApiError("boom", 500, "internal_error"),
        t,
      ),
    ).toBe("Pairing code could not be resolved.");
  });
});
