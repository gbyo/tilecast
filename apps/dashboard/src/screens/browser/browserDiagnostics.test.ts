import { describe, expect, it } from "vitest";
import type { ReliabilityStatus } from "../../api/types";
import {
  browserFacts,
  browserFindings,
  type BrowserDiagnosticsInput,
} from "./browserDiagnostics";

const GIB = 1024 ** 3;
const bytes = (value: number) => `${(value / GIB).toFixed(1)} GiB`;

const healthy: ReliabilityStatus = {
  foregroundState: "foreground",
  activeHoursState: "active",
  immersiveModeActive: true,
  keepScreenOn: true,
  cachedFallbackAvailable: true,
  lastHealthyPlaybackAt: new Date().toISOString(),
  browser: {
    browserName: "edge",
    browserMajorVersion: 154,
    displayMode: "standalone_pwa",
    fullscreenActive: false,
    audioUnlocked: true,
    wakeLock: "active",
    storagePersistence: "persistent",
    storageUsageBytes: 3.8 * GIB,
    storageQuotaBytes: 12 * GIB,
    offlineContent: "ready",
    serviceWorker: "controlling",
  },
  powerAssist: {
    deviceSleep: "untested",
    tvStandby: "untested",
    deviceWake: "untested",
    tvWake: "untested",
    inputSelection: "untested",
    tilecastStartup: "untested",
  },
};
const input = (
  overrides: Partial<BrowserDiagnosticsInput> = {},
  browser: Partial<NonNullable<ReliabilityStatus["browser"]>> = {},
  reliability: Partial<ReliabilityStatus> = {},
): BrowserDiagnosticsInput => ({
  reliability: {
    ...healthy,
    ...reliability,
    browser: { ...healthy.browser, ...browser },
  },
  screenStatus: "online",
  playbackState: "playing",
  recoveryEnabled: true,
  ...overrides,
});
const fact = (source: BrowserDiagnosticsInput, id: string) =>
  browserFacts(source, { bytes }).find((entry) => entry.id === id)!;
const severities = (source: BrowserDiagnosticsInput) =>
  Object.fromEntries(
    browserFindings(source).map((entry) => [entry.id, entry.severity]),
  );

describe("Browser Player facts", () => {
  it("states each fact an operator needs, in the words of the design", () => {
    const source = input();
    expect(fact(source, "browser")).toMatchObject({
      value: "names.edge",
      params: { version: 154 },
    });
    expect(fact(source, "display").value).toBe("displayMode.standalone_pwa");
    expect(fact(source, "playerState").value).toBe("playerState.foreground");
    expect(fact(source, "fullscreen").value).toBe("fullscreen.notRequired");
    expect(fact(source, "awake").value).toBe("awake.active");
    expect(fact(source, "storage")).toMatchObject({
      value: "storage.persistentMeasured",
      params: { used: "3.8 GiB", quota: "12.0 GiB" },
      tone: "ok",
    });
    expect(fact(source, "offline").value).toBe("offline.ready");
    expect(fact(source, "recovery").value).toBe("recovery.enabled");
    expect(fact(source, "updates").value).toBe("updates.managed");
  });

  it("distinguishes persistent storage from best effort", () => {
    const best = input({}, { storagePersistence: "best_effort" });
    expect(fact(best, "storage")).toMatchObject({
      value: "storage.bestEffortMeasured",
      tone: "attention",
    });
    const unmeasured = input(
      {},
      { storageUsageBytes: undefined, storageQuotaBytes: undefined },
    );
    expect(fact(unmeasured, "storage").value).toBe("storage.persistent");
  });

  it("asks for fullscreen only in a browser tab", () => {
    const tab = input(
      {},
      { displayMode: "browser_tab", fullscreenActive: false },
    );
    expect(fact(tab, "fullscreen")).toMatchObject({
      value: "fullscreen.inactive",
      tone: "attention",
    });
    expect(
      fact(
        input({}, { displayMode: "browser_tab", fullscreenActive: true }),
        "fullscreen",
      ).value,
    ).toBe("fullscreen.active");
  });

  it("says a released wake lock is expected while the screen rests", () => {
    const rest = input(
      { playbackState: "sleep" },
      { wakeLock: "released" },
      { activeHoursState: "off_hours" },
    );
    expect(fact(rest, "awake").value).toBe("awake.resting");
    expect(fact(input({}, { wakeLock: "released" }), "awake").value).toBe(
      "awake.needsAttention",
    );
    expect(fact(input({}, { wakeLock: "unsupported" }), "awake").value).toBe(
      "awake.unsupported",
    );
  });

  it("reports nothing it was not told", () => {
    const empty: BrowserDiagnosticsInput = {
      reliability: undefined,
      screenStatus: "online",
    };
    for (const id of [
      "browser",
      "display",
      "playerState",
      "fullscreen",
      "awake",
      "sound",
      "storage",
      "offline",
      "worker",
      "recovery",
    ])
      expect(fact(empty, id).value, id).toBe("notReported");
    expect(browserFindings(empty)).toEqual([]);
  });
});

describe("Browser Player findings", () => {
  it("is informational only for a healthy installed app", () => {
    expect(severities(input())).toEqual({
      installed: "info",
      watchLive: "info",
    });
  });

  it("recommends setup without calling it a playback problem", () => {
    const found = severities(
      input(
        {},
        {
          displayMode: "browser_tab",
          fullscreenActive: false,
          storagePersistence: "best_effort",
          wakeLock: "denied",
          audioUnlocked: false,
          serviceWorker: "update_waiting",
        },
      ),
    );
    expect(found).toMatchObject({
      tab: "setup",
      bestEffort: "setup",
      fullscreen: "setup",
      wakeLock: "setup",
      sound: "setup",
      updateWaiting: "setup",
    });
    expect(Object.values(found)).not.toContain("degraded");
  });

  it("treats a hidden or frozen page as a playback degradation", () => {
    expect(
      severities(input({}, {}, { foregroundState: "background" })).background,
    ).toBe("degraded");
    expect(
      severities(input({}, {}, { foregroundState: "frozen" })).frozen,
    ).toBe("degraded");
  });

  it("flags content being repaired or never prepared, and a reported playback error", () => {
    expect(
      severities(input({}, { offlineContent: "repairing" })).repairing,
    ).toBe("degraded");
    expect(
      severities(input({}, { offlineContent: "not_prepared" })).notPrepared,
    ).toBe("degraded");
    expect(
      severities(input({ lastPlaybackError: "decoder failed" })).playbackError,
    ).toBe("degraded");
  });

  it("does not call a resting screen unprepared or its wake lock a problem", () => {
    const rest = input(
      { playbackState: "sleep" },
      { wakeLock: "released", offlineContent: "not_prepared" },
      { activeHoursState: "off_hours" },
    );
    const found = severities(rest);
    expect(found).not.toHaveProperty("notPrepared");
    expect(found).not.toHaveProperty("wakeLock");
  });

  it("flags a screen that is playing but has not confirmed playback for too long", () => {
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    expect(
      severities(input({}, {}, { lastHealthyPlaybackAt: old })).noProgress,
    ).toBe("degraded");
    const now = Date.now();
    expect(
      severities(
        input(
          { now },
          {},
          { lastHealthyPlaybackAt: new Date(now - 60_000).toISOString() },
        ),
      ),
    ).not.toHaveProperty("noProgress");
    // An offline screen is already reported as offline; it is not also stalled.
    expect(
      severities(
        input({ screenStatus: "offline" }, {}, { lastHealthyPlaybackAt: old }),
      ),
    ).not.toHaveProperty("noProgress");
  });

  it("lists what matters most first", () => {
    const ordered = browserFindings(
      input(
        {},
        { displayMode: "browser_tab", fullscreenActive: false },
        { foregroundState: "background" },
      ),
    ).map((entry) => entry.severity);
    expect(ordered).toEqual(
      [...ordered].sort(
        (a, b) =>
          ({ degraded: 0, setup: 1, info: 2 })[a] -
          { degraded: 0, setup: 1, info: 2 }[b],
      ),
    );
    expect(ordered[0]).toBe("degraded");
  });
});
