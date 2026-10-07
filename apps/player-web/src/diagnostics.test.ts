import { describe, expect, it } from "vitest";
import {
  browserStatus,
  describeBrowser,
  serviceWorkerStatus,
} from "./diagnostics";
import type { DisplayFacts } from "./display";

const brands = (...entries: [string, string][]) => ({
  userAgent: "",
  userAgentData: {
    brands: entries.map(([brand, version]) => ({ brand, version })),
  },
});

describe("browser identity", () => {
  it("reports the family and the major version only", () => {
    expect(
      describeBrowser(
        brands(
          ["Not.A/Brand", "99"],
          ["Chromium", "154"],
          ["Microsoft Edge", "154"],
        ),
      ),
    ).toEqual({ browserName: "edge", browserMajorVersion: 154 });
    expect(
      describeBrowser(brands(["Chromium", "154"], ["Google Chrome", "154"])),
    ).toEqual({ browserName: "chrome", browserMajorVersion: 154 });
    expect(describeBrowser(brands(["Chromium", "130"]))).toEqual({
      browserName: "chromium",
      browserMajorVersion: 130,
    });
  });

  it("falls back to the user agent when the browser offers no brands", () => {
    expect(
      describeBrowser({
        userAgent: "Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0",
      }),
    ).toEqual({ browserName: "edge", browserMajorVersion: 150 });
    expect(
      describeBrowser({
        userAgent: "Mozilla/5.0 Chrome/149.0.1.2 Safari/537.36",
      }),
    ).toEqual({ browserName: "chrome", browserMajorVersion: 149 });
    expect(
      describeBrowser({ userAgent: "Mozilla/5.0 Gecko Firefox/140.0" }),
    ).toEqual({ browserName: "other", browserMajorVersion: 0 });
  });
});

describe("service worker status", () => {
  it("shows an update that is waiting instead of taking it", () => {
    expect(
      serviceWorkerStatus(
        { installing: null, waiting: {} as ServiceWorker },
        true,
      ),
    ).toBe("update_waiting");
    expect(
      serviceWorkerStatus(
        { installing: {} as ServiceWorker, waiting: null },
        true,
      ),
    ).toBe("installing");
    expect(serviceWorkerStatus({ installing: null, waiting: null }, true)).toBe(
      "controlling",
    );
    expect(
      serviceWorkerStatus({ installing: null, waiting: null }, false),
    ).toBe("unavailable");
    expect(serviceWorkerStatus(undefined, true)).toBe("unavailable");
  });
});

const display: DisplayFacts = {
  displayMode: "standalone_pwa",
  fullscreenActive: false,
  wakeLock: "active",
  audioUnlocked: true,
  unattendedPresentation: true,
};
const base = {
  browser: { browserName: "chrome" as const, browserMajorVersion: 154 },
  display,
  offlineContent: "ready" as const,
  serviceWorker: "controlling" as const,
  hostVersion: "0.1.0",
  wasDiscarded: false,
};

describe("browser status", () => {
  it("claims persistent storage only when the browser granted it", () => {
    expect(
      browserStatus({
        ...base,
        storage: {
          persistenceRequested: true,
          persistenceGranted: true,
          usageBytes: 3,
          quotaBytes: 9,
        },
      }),
    ).toMatchObject({
      storagePersistence: "persistent",
      storageUsageBytes: 3,
      storageQuotaBytes: 9,
    });
    expect(
      browserStatus({
        ...base,
        storage: { persistenceRequested: true, persistenceGranted: false },
      }).storagePersistence,
    ).toBe("best_effort");
    expect(
      browserStatus({ ...base, storage: undefined }).storagePersistence,
    ).toBe("unknown");
  });

  it("omits a measurement the browser did not give", () => {
    const status = browserStatus({
      ...base,
      storage: { persistenceRequested: false, persistenceGranted: false },
    });
    expect(status).not.toHaveProperty("storageUsageBytes");
    expect(status).not.toHaveProperty("storageQuotaBytes");
  });

  it("carries no identifier that could single out one browser", () => {
    const status = browserStatus({ ...base, storage: undefined });
    expect(Object.keys(status).sort()).toEqual([
      "audioUnlocked",
      "browserMajorVersion",
      "browserName",
      "displayMode",
      "fullscreenActive",
      "offlineContent",
      "serviceWorker",
      "serviceWorkerVersion",
      "storagePersistence",
      "wakeLock",
      "wasDiscarded",
    ]);
  });
});
