import type { components } from "@tilecast/api-schema/generated/openapi";
import type { DisplayFacts } from "./display";
import type { StorageFacts } from "./storage/persistence";

export type BrowserPlayerStatus = components["schemas"]["BrowserPlayerStatus"];
type BrowserName = NonNullable<BrowserPlayerStatus["browserName"]>;

interface BrowserBrands {
  userAgentData?: { brands?: readonly { brand: string; version: string }[] };
  userAgent: string;
}

/**
 * The browser family and its major version, and nothing more. The Player
 * sends no full version, no platform string and no identifier that could single
 * out one browser.
 */
export function describeBrowser(source: BrowserBrands): {
  browserName: BrowserName;
  browserMajorVersion: number;
} {
  const brands = source.userAgentData?.brands ?? [];
  const brand = (name: string) => brands.find((entry) => entry.brand === name);
  const major = (value: string | undefined) => {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 9999
      ? parsed
      : 0;
  };
  const edge = brand("Microsoft Edge");
  if (edge)
    return { browserName: "edge", browserMajorVersion: major(edge.version) };
  const chrome = brand("Google Chrome");
  if (chrome)
    return {
      browserName: "chrome",
      browserMajorVersion: major(chrome.version),
    };
  const chromium = brand("Chromium");
  if (chromium)
    return {
      browserName: "chromium",
      browserMajorVersion: major(chromium.version),
    };
  const agent = source.userAgent;
  const edgeAgent = /\bEdg\/(\d+)/.exec(agent);
  if (edgeAgent)
    return { browserName: "edge", browserMajorVersion: major(edgeAgent[1]) };
  const chromeAgent = /\bChrome\/(\d+)/.exec(agent);
  if (chromeAgent)
    return {
      browserName: "chrome",
      browserMajorVersion: major(chromeAgent[1]),
    };
  return { browserName: "other", browserMajorVersion: 0 };
}

export type ServiceWorkerStatus = NonNullable<
  BrowserPlayerStatus["serviceWorker"]
>;

/** What the page's worker is doing, in the terms an operator can act on. */
export function serviceWorkerStatus(
  registration:
    Pick<ServiceWorkerRegistration, "installing" | "waiting"> | undefined,
  controlled: boolean,
): ServiceWorkerStatus {
  if (!registration) return "unavailable";
  // A waiting worker is an update that has not taken over. The Host never
  // forces it to during playback.
  if (registration.waiting && controlled) return "update_waiting";
  if (registration.installing) return "installing";
  return controlled ? "controlling" : "unavailable";
}

export type OfflineContent = NonNullable<BrowserPlayerStatus["offlineContent"]>;

export interface BrowserStatusInput {
  browser: ReturnType<typeof describeBrowser>;
  display: DisplayFacts;
  /** Absent when the browser would not answer a storage question. */
  storage: StorageFacts | undefined;
  offlineContent: OfflineContent;
  serviceWorker: ServiceWorkerStatus;
  hostVersion: string;
  wasDiscarded: boolean;
}

/**
 * The bounded Browser section of the heartbeat. Every field is a measurement.
 * `persistent` is claimed only when the browser said so.
 */
export function browserStatus(input: BrowserStatusInput): BrowserPlayerStatus {
  const { storage } = input;
  return {
    browserName: input.browser.browserName,
    browserMajorVersion: input.browser.browserMajorVersion,
    displayMode: input.display.displayMode,
    fullscreenActive: input.display.fullscreenActive,
    audioUnlocked: input.display.audioUnlocked,
    wakeLock: input.display.wakeLock,
    storagePersistence: !storage
      ? "unknown"
      : storage.persistenceGranted
        ? "persistent"
        : "best_effort",
    ...(storage?.usageBytes !== undefined
      ? { storageUsageBytes: storage.usageBytes }
      : {}),
    ...(storage?.quotaBytes !== undefined
      ? { storageQuotaBytes: storage.quotaBytes }
      : {}),
    offlineContent: input.offlineContent,
    serviceWorker: input.serviceWorker,
    serviceWorkerVersion: input.hostVersion.slice(0, 64),
    wasDiscarded: input.wasDiscarded,
  };
}

/**
 * The build identifier of the worker that controls this page, or nothing. It
 * is the shell the page was served with, so an operator can tell whether a
 * Player runs the version the server now offers.
 */
export function controllingShellVersion(
  worker: Pick<ServiceWorker, "postMessage"> | null,
  timeoutMs = 2_000,
): Promise<string | undefined> {
  if (!worker) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    channel.port1.onmessage = (event: MessageEvent<{ shell?: unknown }>) => {
      clearTimeout(timer);
      const shell = event.data?.shell;
      resolve(
        typeof shell === "string" && /^[A-Za-z0-9._+-]{1,64}$/.test(shell)
          ? shell
          : undefined,
      );
    };
    worker.postMessage({ type: "version" }, [channel.port2]);
  });
}
