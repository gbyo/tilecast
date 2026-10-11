import { describe, expect, it } from "vitest";
import type { UpdateDeployment, UpdateDeploymentScreen } from "../api/types";
import {
  bucketCounts,
  deploymentHeadline,
  deploymentSegments,
  filterDeploymentScreens,
  releaseDisplayLabel,
  screenMatchesReleaseArchitecture,
  screenDownloadPercent,
  screenStateCounts,
  screenUpdateDetail,
  screenUpdateMeaning,
  sortedDeploymentScreens,
} from "./playerUpdateStates";

function target(
  state: UpdateDeploymentScreen["state"],
  overrides: Partial<UpdateDeploymentScreen> = {},
): UpdateDeploymentScreen {
  return {
    screenId: `${state}-${overrides.screenName ?? "screen"}`,
    screenName: overrides.screenName ?? "Library east",
    previousVersionCode: 41,
    expectedVersionCode: 42,
    downloadedBytes: 0,
    state,
    updatedAt: "2026-07-30T12:00:00Z",
    isCanary: false,
    ...overrides,
  };
}

function deployment(
  overrides: Partial<UpdateDeployment> = {},
): UpdateDeployment {
  return {
    id: "d1",
    name: "Tilecast Player 1.4.0",
    mode: "install_now",
    status: "active",
    createdAt: "2026-07-30T11:00:00Z",
    platform: "android",
    versionCode: 42,
    versionName: "1.4.0",
    targetCount: 10,
    succeededCount: 4,
    failedCount: 0,
    waitingForUserCount: 0,
    ...overrides,
  };
}

describe("screen update vocabulary", () => {
  it("keeps TV approval out of the failure bucket", () => {
    const waiting = screenUpdateMeaning("waiting_for_user");
    expect(waiting.bucket).toBe("attention");
    expect(waiting.tone).toBe("warning");
    expect(waiting.actionable).toBe(true);
    expect(screenUpdateMeaning("failed").tone).toBe("danger");
  });

  it("gives an unrecognized player state a neutral fallback", () => {
    expect(screenUpdateMeaning("teleporting").label).toBe("Unknown");
  });

  it("denies a stage to states that stopped moving", () => {
    expect(screenUpdateMeaning("failed").stage).toBe(-1);
    expect(screenUpdateMeaning("cancelled").stage).toBe(-1);
    expect(screenUpdateMeaning("succeeded").stage).toBe(3);
  });

  it("prefers the server's own failure text over the generic sentence", () => {
    expect(
      screenUpdateDetail(target("failed", { safeError: "Not enough storage" })),
    ).toBe("Not enough storage");
    expect(screenUpdateDetail(target("failed"))).toContain("Retry");
    expect(
      screenUpdateDetail(target("incompatible", {
        safeError: "Requires x86_64 architecture; this screen reports aarch64.",
      })),
    ).toContain("x86_64");
    expect(screenUpdateDetail(target("incompatible"))).not.toContain("Android version");
  });

  it("reports a percentage only while a download is running", () => {
    expect(
      screenDownloadPercent(
        target("downloading", { downloadedBytes: 500 }),
        1000,
      ),
    ).toBe(50);
    expect(screenDownloadPercent(target("installing"), 1000)).toBeNull();
    expect(screenDownloadPercent(target("downloading"), 0)).toBeNull();
  });
});

describe("deployment progress", () => {
  it("accounts for every target exactly once", () => {
    const segments = deploymentSegments({
      targetCount: 10,
      succeededCount: 4,
      failedCount: 2,
      waitingForUserCount: 1,
    });
    expect(segments.map((segment) => segment.count)).toEqual([4, 1, 2, 3]);
    expect(segments.reduce((total, segment) => total + segment.count, 0)).toBe(
      10,
    );
  });

  it("never reports a negative remainder when counts exceed the target", () => {
    const segments = deploymentSegments({
      targetCount: 2,
      succeededCount: 2,
      failedCount: 1,
      waitingForUserCount: 0,
    });
    expect(segments.at(-1)?.count).toBe(0);
  });

  it("counts already-current screens as updated and incompatible ones as failed", () => {
    expect(
      screenStateCounts([
        target("succeeded"),
        target("already_current"),
        target("incompatible"),
        target("waiting_for_permission"),
        target("downloading"),
      ]),
    ).toEqual({
      targetCount: 5,
      succeededCount: 2,
      failedCount: 1,
      waitingForUserCount: 1,
    });
  });

  it("says what a deployment needs instead of listing four counts", () => {
    expect(deploymentHeadline(deployment({ failedCount: 2 }))).toContain(
      "2 screens need a retry",
    );
    expect(
      deploymentHeadline(deployment({ waitingForUserCount: 1 })),
    ).toContain("1 screen is waiting");
    expect(deploymentHeadline(deployment({ succeededCount: 10 }))).toBe(
      "Every screen is on this release.",
    );
    expect(
      deploymentHeadline(
        deployment({ status: "paused", pauseReason: "A canary failed." }),
      ),
    ).toBe("A canary failed.");
  });
});

describe("screen list ordering and filters", () => {
  const screens = [
    target("succeeded", { screenName: "Atrium" }),
    target("failed", { screenName: "Zebra hall" }),
    target("downloading", { screenName: "Gym" }),
    target("waiting_for_user", { screenName: "Cafeteria" }),
  ];

  it("puts rows a person can act on above everything else", () => {
    expect(
      sortedDeploymentScreens(screens).map((item) => item.screenName),
    ).toEqual(["Cafeteria", "Zebra hall", "Gym", "Atrium"]);
  });

  it("filters to one bucket while keeping that order", () => {
    expect(
      filterDeploymentScreens(screens, "attention").map(
        (item) => item.screenName,
      ),
    ).toEqual(["Cafeteria", "Zebra hall"]);
    expect(bucketCounts(screens)).toEqual({
      attention: 2,
      progress: 1,
      done: 1,
    });
  });
});

describe("release selection architecture", () => {
  it("distinguishes releases that share a version and channel", () => {
    const intel = { versionName: "0.26.0-beta.6", architecture: "x86_64" };
    const arm = { ...intel, architecture: "aarch64" };
    const android = { ...intel, architecture: "" };

    const intelLabel = releaseDisplayLabel(intel, "Beta");
    const armLabel = releaseDisplayLabel(arm, "Beta");
    expect(intelLabel).toBe("0.26.0-beta.6 · x86_64 · Beta");
    expect(armLabel).toBe("0.26.0-beta.6 · aarch64 · Beta");
    expect(intelLabel).not.toBe(armLabel);
    expect(releaseDisplayLabel(android, "Beta")).toBe("0.26.0-beta.6 · Beta");
  });

  it("rejects mismatched and unknown architectures", () => {
    const intel = { playerArchitecture: "x86_64" };
    const arm = { playerArchitecture: "aarch64" };
    const unknown = { playerArchitecture: undefined };
    const edge = { playerFamily: "edge", architecture: "x86_64" } as const;
    const windows = { ...edge, playerFamily: "windows" } as const;
    const android = { ...edge, playerFamily: "android" } as const;

    expect(screenMatchesReleaseArchitecture(intel, edge)).toBe(true);
    expect(screenMatchesReleaseArchitecture(arm, edge)).toBe(false);
    expect(screenMatchesReleaseArchitecture(unknown, edge)).toBe(false);
    expect(screenMatchesReleaseArchitecture(arm, windows)).toBe(false);
    expect(screenMatchesReleaseArchitecture(arm, android)).toBe(true);
    expect(screenMatchesReleaseArchitecture(unknown, undefined)).toBe(true);
  });
});
