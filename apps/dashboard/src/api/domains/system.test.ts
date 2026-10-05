import { describe, expect, it } from "vitest";
import {
  normalizePlayerRelease,
  normalizeSettingsExport,
  normalizeTakeover,
  normalizeUpdateDeployment,
  normalizeUpdateDeploymentDetail,
} from "./system";
import type {
  PlayerRelease,
  SettingsExportDocument,
  Takeover,
  UpdateDeployment,
  UpdateDeploymentDetail,
} from "../types";

function wireTakeover(): Parameters<typeof normalizeTakeover>[0] {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Evening takeover",
    description: "",
    playlistId: "22222222-2222-4222-8222-222222222222",
    playlistName: "Lobby loop",
    status: "active",
    activatedAt: "2026-09-28T19:00:00.000Z",
    expiresAt: "2026-09-28T23:00:00.000Z",
    cancelledAt: null,
    cancellationReason: "",
    affectedCount: 3,
    activeCount: 2,
    preparingCount: 1,
    failedCount: 0,
  };
}

describe("normalizeTakeover", () => {
  it("maps wire nulls to absent optionals", () => {
    const normalized: Takeover = normalizeTakeover({
      ...wireTakeover(),
      activatedAt: null,
    });
    expect(normalized.activatedAt).toBeUndefined();
    expect(normalized.cancelledAt).toBeUndefined();
    expect(normalized.expiresAt).toBe("2026-09-28T23:00:00.000Z");
  });

  it("preserves populated timestamps and counts", () => {
    const normalized: Takeover = normalizeTakeover(wireTakeover());
    expect(normalized.activatedAt).toBe("2026-09-28T19:00:00.000Z");
    expect(normalized.affectedCount).toBe(3);
    expect(normalized.activeCount).toBe(2);
  });
});

describe("normalizeSettingsExport", () => {
  it("fills the stripped definitions with an empty list", () => {
    const normalized: SettingsExportDocument = normalizeSettingsExport({
      schemaVersion: 1,
      exportedAt: "2026-09-28T20:00:00.000Z",
      tilecastVersion: "0.8.0",
      organization: {
        schemaVersion: 1,
        revision: 7,
        values: {},
        updatedAt: "2026-09-28T20:00:00.000Z",
      },
      groupPolicies: [],
    });
    expect(normalized.organization.definitions).toEqual([]);
    expect(normalized.organization.revision).toBe(7);
  });
});

function wireRelease(): Parameters<typeof normalizePlayerRelease>[0] {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    tag: "",
    platform: "windows",
    playerFamily: "windows",
    architecture: "x86_64",
    source: "upload",
    channel: "stable",
    versionCode: 2000,
    versionName: "0.2.0",
    minimumSdk: null,
    releaseNotes: "",
    publishedAt: "2026-09-25T11:00:00Z",
    apkSizeBytes: 2048,
    downloadedBytes: 2048,
    apkSha256: "b".repeat(64),
    signingCertificateSha256: "",
    manifestSignature: "signature",
    cacheStatus: "cached",
    verificationStatus: "verified",
    deploymentCount: 0,
    activeDeploymentCount: 0,
  };
}

describe("normalizePlayerRelease", () => {
  it("keeps a known family and architecture", () => {
    const normalized: PlayerRelease | undefined =
      normalizePlayerRelease(wireRelease());
    expect(normalized?.platform).toBe("windows");
    expect(normalized?.playerFamily).toBe("windows");
    expect(normalized?.architecture).toBe("x86_64");
  });

  it("drops a release from a family Studio does not know", () => {
    expect(
      normalizePlayerRelease({
        ...wireRelease(),
        platform: "tizen",
        playerFamily: "tizen",
      }),
    ).toBeUndefined();
    expect(
      normalizePlayerRelease({ ...wireRelease(), playerFamily: "tizen" }),
    ).toBeUndefined();
  });
});

function wireDeployment(): Parameters<typeof normalizeUpdateDeployment>[0] {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    name: "Windows rollout",
    mode: "install_now",
    status: "active",
    createdAt: "2026-09-25T12:00:00Z",
    platform: "windows",
    playerFamily: "windows",
    architecture: "x86_64",
    versionCode: 2000,
    versionName: "0.2.0",
    targetCount: 2,
    succeededCount: 1,
    failedCount: 0,
    waitingForUserCount: 0,
    rolloutMode: "full",
    rolloutPhase: "full",
    canarySize: 0,
    pauseReason: null,
    lastFailure: null,
  };
}

describe("normalizeUpdateDeployment", () => {
  it("keeps a known family and narrows its platform", () => {
    const normalized: UpdateDeployment | undefined =
      normalizeUpdateDeployment(wireDeployment());
    expect(normalized?.platform).toBe("windows");
    expect(normalized?.playerFamily).toBe("windows");
  });

  it("drops a deployment Studio cannot place on a tab", () => {
    expect(
      normalizeUpdateDeployment({
        ...wireDeployment(),
        platform: "tizen",
        playerFamily: "tizen",
      }),
    ).toBeUndefined();
  });

  it("absents an unknown family on a known platform", () => {
    const normalized: UpdateDeployment | undefined = normalizeUpdateDeployment({
      ...wireDeployment(),
      platform: "linux",
      playerFamily: "tizen",
    });
    expect(normalized?.platform).toBe("linux");
    expect(normalized?.playerFamily).toBeUndefined();
  });
});

describe("normalizeUpdateDeploymentDetail", () => {
  it("drops a detail Studio cannot place on a tab", () => {
    const normalized: UpdateDeploymentDetail | undefined =
      normalizeUpdateDeploymentDetail({
        ...wireDeployment(),
        platform: "tizen",
        completedAt: null,
        rolloutMode: "full",
        rolloutPhase: "full",
        canarySize: 0,
        artifactSizeBytes: 2048,
        screens: [],
      });
    expect(normalized).toBeUndefined();
  });
});
