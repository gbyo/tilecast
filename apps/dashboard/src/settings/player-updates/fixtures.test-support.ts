import type {
  PlayerRelease,
  Screen,
  ScreenGroup,
  UpdateDeployment,
  UpdateDeploymentDetail,
  UpdateDeploymentPreview,
} from "../../api/types";
export const release: PlayerRelease = {
  id: "r1",
  tag: "edge-v0.26.0-beta.6",
  platform: "linux",
  playerFamily: "edge",
  architecture: "x86_64",
  source: "github",
  channel: "beta",
  versionCode: 26006,
  versionName: "0.26.0-beta.6",
  minimumSdk: null,
  releaseNotes: "Verified update",
  publishedAt: "2026-10-11T10:00:00Z",
  apkSizeBytes: 50 * 1024 * 1024,
  downloadedBytes: 0,
  apkSha256: "a".repeat(64),
  signingCertificateSha256: "",
  manifestSignature: "signature",
  cacheStatus: "cached",
  verificationStatus: "verified",
  deploymentCount: 0,
  activeDeploymentCount: 0,
};
export const fleet: Screen[] = [
  {
    id: "s1",
    name: "Lobby",
    platform: "linux",
    playerFamily: "edge",
    playerArchitecture: "x86_64",
    playerVersion: "0.25.0",
    playerVersionCode: 25000,
    status: "online",
  },
  {
    id: "s2",
    name: "Library",
    platform: "linux",
    playerFamily: "edge",
    playerArchitecture: "x86_64",
    playerVersion: "0.25.0",
    playerVersionCode: 25000,
    status: "offline",
  },
  {
    id: "s3",
    name: "ARM Hall",
    platform: "linux",
    playerFamily: "edge",
    playerArchitecture: "aarch64",
    playerVersion: "0.25.0",
    playerVersionCode: 25000,
    status: "online",
  },
] as Screen[];
export const groups: ScreenGroup[] = [
  {
    id: "g1",
    name: "Main building",
    membershipCount: 2,
    screens: fleet
      .slice(0, 2)
      .map((s) => ({ id: s.id, name: s.name, location: "" })),
  } as ScreenGroup,
];
export function preview(ids: string[]): UpdateDeploymentPreview {
  const screens = fleet
    .filter((s) => ids.includes(s.id))
    .map((s) => ({
      screenId: s.id,
      screenName: s.name,
      currentVersionCode: s.playerVersionCode ?? null,
      playerFamily: "edge",
      playerArchitecture: s.playerArchitecture ?? "",
      recentlyContacted: s.status !== "offline",
      outcome:
        s.id === "s3"
          ? ("incompatible" as const)
          : s.id === "s2"
            ? ("offline" as const)
            : ("eligible" as const),
      reason:
        s.id === "s3"
          ? "This release requires x86_64 architecture, but this screen reports aarch64."
          : null,
    }));
  return {
    targetCount: screens.length,
    eligibleCount: screens.filter((s) => s.outcome !== "incompatible").length,
    blockedCount: screens.filter((s) => s.outcome === "incompatible").length,
    offlineCount: screens.filter((s) => s.outcome === "offline").length,
    alreadyCurrentCount: 0,
    screens,
  };
}
export const deployment: UpdateDeployment = {
  id: "d1",
  name: "Rollout",
  mode: "install_now",
  status: "active",
  createdAt: "2026-10-11T10:00:00Z",
  platform: "linux",
  playerFamily: "edge",
  architecture: "x86_64",
  versionCode: release.versionCode,
  versionName: release.versionName,
  targetCount: 3,
  succeededCount: 1,
  failedCount: 1,
  waitingForUserCount: 0,
};
export const detail: UpdateDeploymentDetail = {
  ...deployment,
  artifactSizeBytes: release.apkSizeBytes,
  rolloutMode: "canary",
  rolloutPhase: "canary",
  canarySize: 1,
  screens: [
    {
      screenId: "s1",
      screenName: "Lobby",
      previousVersionCode: 25000,
      expectedVersionCode: release.versionCode,
      downloadedBytes: 0,
      state: "succeeded",
      updatedAt: "2026-10-11T11:00:00Z",
      isCanary: true,
    },
    {
      screenId: "s2",
      screenName: "Library",
      previousVersionCode: 25000,
      expectedVersionCode: release.versionCode,
      downloadedBytes: 25 * 1024 * 1024,
      state: "downloading",
      updatedAt: "2026-10-11T11:00:00Z",
      isCanary: false,
    },
    {
      screenId: "s3",
      screenName: "ARM Hall",
      previousVersionCode: 25000,
      expectedVersionCode: release.versionCode,
      downloadedBytes: 0,
      state: "failed",
      safeError: "Not enough storage.",
      updatedAt: "2026-10-11T11:00:00Z",
      isCanary: false,
    },
  ],
};
