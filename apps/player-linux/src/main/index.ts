/**
 * Tilecast Player for Linux — Electron main process.
 *
 * The main process is a thin host: it owns the kiosk window, the tcmedia://
 * protocol, renderer crash recovery, and process relaunch. All protocol and
 * reliability logic lives in the core runtime. Under systemd (see
 * /install/tilecast-player.service) a crashed or deliberately restarted
 * process comes straight back, completing the zero-touch loop.
 */

import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  net,
  powerSaveBlocker,
  protocol,
  screen,
  session,
  type Session,
} from "electron";
import type { NativeImage, WebContents } from "electron";
import { promises as fs } from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { logger, setLogLevel } from "../core/log";
import { linuxKioskPolicy, type LinuxKioskPolicy } from "../core/linux-kiosk";
import { loadOutsideActiveHoursPresentation } from "../core/outside-hours";
import { PlayerRuntime, type Presentation } from "../core/player";
import type { ManifestPlugin } from "../core/types";
import { StateStore, defaultDataDir } from "../core/storage";
import { normalizeServerUrl } from "../core/server-url";
import { applyLowEndTuning } from "./hardware";
import { LanDiscovery, type DiscoveredServer } from "./discovery";
import { AirplayManager } from "./airplay";
import type { SupportedDecoder } from "./airplay";
import { PresentationNetworkManager } from "./presentation-network";
import {
  PresentationNetworkError,
  parsePresentationNetworkProvisioning,
  validIpv4,
} from "../core/presentation-network";
import { LinuxDisplayControl } from "./display-control";
import {
  loadRuntimeFiles,
  RUNTIME_ENTRY_URL,
  RUNTIME_SCHEME,
  RUNTIME_SCHEME_PRIVILEGES,
  serveRuntimeRequest,
} from "./runtime-protocol";
import { presentationMessage, type HostPresentation } from "./runtime-messages";
import type { HostMessageV1 } from "@tilecast/player-runtime/host-contract";
import type { StoredManifest } from "../core/manifest";

const log = logger("main");

const PLAYER_VERSION = app.getVersion() || "0.1.0";
const SERVER_URL_FILE = "server.json";
const OUTSIDE_HOURS_REFRESH_MS = 5_000;

if (process.env.TILECAST_LOG_LEVEL === "debug") {
  setLogLevel("debug");
}

// Must run before app is ready: sizes GPU/V8 memory and enables Intel VA-API
// video decode for the low-end reference hardware.
applyLowEndTuning(app);

// A second instance must never fight the first over the display or state.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: "tcmedia",
    privileges: { standard: true, stream: true, supportFetchAPI: true },
  },
  RUNTIME_SCHEME_PRIVILEGES,
]);
// The sandboxed preload reports this in the runtime's host diagnostics.
process.env.TILECAST_PLAYER_VERSION = PLAYER_VERSION;

let window: BrowserWindow | null = null;
let runtime: PlayerRuntime | null = null;
let store: StateStore;
let discovery: LanDiscovery | null = null;
let lastPresentation: HostPresentation = { state: "setup" };
let lastPlugins: { plugins: ManifestPlugin[]; clockOffsetMs: number } = {
  plugins: [],
  clockOffsetMs: 0,
};
let quitting = false;
let shutdownPromise: Promise<void> | null = null;
let activeLinuxKioskPolicy = linuxKioskPolicy(null);
let displaySleepBlockerId: number | null = null;
const configuredWebsiteSessions = new WeakSet<Session>();

function stopRuntime(): Promise<void> {
  if (!shutdownPromise) {
    const stop = runtime?.stop();
    shutdownPromise =
      stop?.catch((error) => {
        log.warn("player shutdown cleanup failed", { error: String(error) });
      }) ?? Promise.resolve();
  }
  return shutdownPromise;
}

function exitAfterRuntimeStop(code: number, relaunch: boolean): void {
  quitting = true;
  if (relaunch) app.relaunch();
  void stopRuntime().finally(() => app.exit(code));
}

function websiteHost(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function crossSiteRequest(url: string, referer: string | undefined): boolean {
  const sourceHost = referer ? websiteHost(referer) : null;
  const targetHost = websiteHost(url);
  return (
    sourceHost !== null && targetHost !== null && sourceHost !== targetHost
  );
}

function configureWebsiteSession(
  websiteSession: Session,
  policy: "disabled" | "first_party" | "first_and_third_party",
): void {
  if (configuredWebsiteSessions.has(websiteSession)) return;
  configuredWebsiteSessions.add(websiteSession);
  // Website content never captures. Everything else keeps the behavior it had
  // before a handler existed here.
  websiteSession.setPermissionRequestHandler(
    (_contents, permission, callback) => callback(permission !== "media"),
  );
  websiteSession.setPermissionCheckHandler(
    (_contents, permission) => permission !== "media",
  );
  const stripsThirdParty = policy === "first_party";
  websiteSession.webRequest.onBeforeSendHeaders(
    { urls: ["*://*/*"] },
    (details, callback) => {
      const headers = { ...details.requestHeaders };
      if (
        policy === "disabled" ||
        (stripsThirdParty && crossSiteRequest(details.url, details.referrer))
      ) {
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === "cookie") delete headers[key];
        }
      }
      callback({ requestHeaders: headers });
    },
  );
  websiteSession.webRequest.onHeadersReceived(
    { urls: ["*://*/*"] },
    (details, callback) => {
      const responseHeaders = details.responseHeaders
        ? { ...details.responseHeaders }
        : undefined;
      if (
        responseHeaders &&
        (policy === "disabled" ||
          (stripsThirdParty && crossSiteRequest(details.url, details.referrer)))
      ) {
        for (const key of Object.keys(responseHeaders)) {
          if (key.toLowerCase() === "set-cookie") delete responseHeaders[key];
        }
      }
      callback({ responseHeaders });
    },
  );
}

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

async function resolveServerUrl(): Promise<string | null> {
  const fromArg = argValue("--server-url");
  const fromEnv = process.env.TILECAST_SERVER_URL;
  const configured = fromArg ?? fromEnv ?? null;
  if (configured) {
    const result = normalizeServerUrl(configured);
    if (!result.ok || !result.url) {
      log.error("configured server url rejected by policy", {
        error: result.error,
      });
      return null;
    }
    await store.writeJson(SERVER_URL_FILE, { serverUrl: result.url });
    return result.url;
  }
  const persisted = await store.readJson<{ serverUrl: string }>(
    SERVER_URL_FILE,
  );
  return persisted?.serverUrl ?? null;
}

function createWindow(): BrowserWindow {
  const kiosk =
    activeLinuxKioskPolicy.fullscreenEnabled &&
    process.env.TILECAST_WINDOWED !== "1";
  const win = new BrowserWindow({
    fullscreen: kiosk,
    kiosk,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: "#000000",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload is a thin TilecastRuntimeHostV1 adapter that requires only
      // "electron"; everything Node-backed runs here in the main process, so
      // the renderer keeps the OS sandbox.
      sandbox: true,
      webviewTag: true,
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.once("ready-to-show", () => win.show());
  // The shared Player Runtime, from the same trusted origin every host uses.
  void win.loadURL(RUNTIME_ENTRY_URL);

  win.webContents.on("render-process-gone", (_event, details) => {
    log.error("renderer process gone; recreating window", {
      reason: details.reason,
    });
    recreateWindow();
  });
  win.webContents.on("did-finish-load", () => {
    // (Re)send state after any load or reload so a recreated renderer
    // resumes exactly where the player left off.
    sendPresentation(lastPresentation);
    sendRuntimeMessage(win, { type: "plugins", ...lastPlugins });
  });
  win.on("unresponsive", () => {
    log.error("window unresponsive; recreating");
    recreateWindow();
  });
  win.on("closed", () => {
    if (!quitting && window === win) {
      log.warn("window closed unexpectedly; recreating");
      window = null;
      recreateWindow();
    }
  });
  return win;
}

function applyLinuxKioskPolicy(policy: LinuxKioskPolicy): void {
  activeLinuxKioskPolicy = policy;
  const kiosk =
    policy.fullscreenEnabled && process.env.TILECAST_WINDOWED !== "1";
  if (window && !window.isDestroyed()) {
    window.setKiosk(kiosk);
    window.setFullScreen(kiosk);
  }
  if (policy.preventDisplaySleep && displaySleepBlockerId === null) {
    displaySleepBlockerId = powerSaveBlocker.start("prevent-display-sleep");
  } else if (!policy.preventDisplaySleep && displaySleepBlockerId !== null) {
    if (powerSaveBlocker.isStarted(displaySleepBlockerId)) {
      powerSaveBlocker.stop(displaySleepBlockerId);
    }
    displaySleepBlockerId = null;
  }
}

function recreateWindow(): void {
  if (quitting) {
    return;
  }
  const old = window;
  window = createWindow();
  if (old && !old.isDestroyed()) {
    old.removeAllListeners("closed");
    old.destroy();
  }
}

function sendRuntimeMessage(
  target: BrowserWindow | null,
  message: HostMessageV1,
): void {
  if (target && !target.isDestroyed()) {
    target.webContents.send("runtime-message", message);
  }
}

let presentationRequest = 0;

/**
 * A playing presentation is sent with its shared-timeline anchor when the
 * screen belongs to a synchronized group. The anchor comes from the active
 * manifest on disk; a newer presentation supersedes a read still in flight.
 */
function sendPresentation(presentation: HostPresentation): void {
  const request = ++presentationRequest;
  void (async () => {
    let stored: StoredManifest | null = null;
    if (presentation.state === "playing") {
      stored = await store
        .readJson<StoredManifest>("manifest-active.json")
        .catch(() => null);
    }
    if (request !== presentationRequest) return;
    sendRuntimeMessage(window, presentationMessage(presentation, stored));
  })();
}

async function refreshOutsideActiveHoursPresentation(): Promise<void> {
  if (lastPresentation.state !== "sleep") {
    return;
  }

  try {
    const presentation = await loadOutsideActiveHoursPresentation(store);
    // Playback may have resumed while the configuration was being read.
    if (lastPresentation.state !== "sleep") {
      return;
    }
    if (JSON.stringify(presentation) === JSON.stringify(lastPresentation)) {
      return;
    }
    lastPresentation = presentation;
    sendPresentation(presentation);
  } catch (error) {
    log.warn("failed to refresh outside-hours presentation", {
      error: String(error),
    });
  }
}

function present(presentation: Presentation): void {
  lastPresentation = presentation;
  sendPresentation(presentation);
  if (presentation.state === "sleep") {
    void refreshOutsideActiveHoursPresentation();
  }
}

function presentPlugins(
  plugins: ManifestPlugin[],
  clockOffsetMs: number,
): void {
  lastPlugins = { plugins, clockOffsetMs };
  sendRuntimeMessage(window, {
    type: "plugins",
    plugins,
    clockOffsetMs,
  });
}

/**
 * Encode a captured frame to a downscaled JPEG within the given limits.
 * Preserves aspect ratio, never upscales, and steps quality down until the
 * result fits the byte budget. Returns null for an empty frame or one that
 * cannot be squeezed under the limit.
 */
function encodePreview(
  image: NativeImage,
  max: { width: number; height: number; bytes: number },
): { jpeg: Buffer; width: number; height: number } | null {
  const size = image.getSize();
  if (size.width === 0 || size.height === 0) {
    return null;
  }
  const ratio = Math.min(max.width / size.width, max.height / size.height, 1);
  const resized =
    ratio < 1
      ? image.resize({
          width: Math.round(size.width * ratio),
          height: Math.round(size.height * ratio),
          quality: "good",
        })
      : image;
  const finalSize = resized.getSize();
  let quality = 75;
  let jpeg = resized.toJPEG(quality);
  while (jpeg.byteLength > max.bytes && quality > 25) {
    quality -= 15;
    jpeg = resized.toJPEG(quality);
  }
  if (jpeg.byteLength > max.bytes) {
    return null;
  }
  return { jpeg, width: finalSize.width, height: finalSize.height };
}

/**
 * Whether to capture the live preview from the real display framebuffer
 * (desktopCapturer) rather than the window's own paint (capturePage).
 *
 * capturePage cannot read hardware-overlay video (enable-hardware-overlays),
 * VA-API-decoded frames, or <webview> content, so it returns an empty/black
 * frame for most signage content on Linux. desktopCapturer reads the actual
 * screen. On X11 this needs no permission and shows no prompt; on Wayland it
 * requires the screen-share portal, which can block on an input-less kiosk, so
 * default to off there. TILECAST_PREVIEW_SCREEN_CAPTURE=0/1 overrides.
 */
function screenCaptureAllowed(): boolean {
  const override = process.env.TILECAST_PREVIEW_SCREEN_CAPTURE;
  if (override !== undefined) {
    return override === "1" || override.toLowerCase() === "true";
  }
  return !process.env.WAYLAND_DISPLAY;
}

async function availableStorageBytes(): Promise<number | null> {
  try {
    const stats = await fs.statfs(store.dataDir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

/**
 * tilecast://runtime/ serves the built shared Player Runtime and nothing else.
 * A missing or incomplete artifact is fatal: there is no older renderer to
 * fall back to, and a relaunch loop is visible in the logs.
 */
async function setupRuntimeProtocol(): Promise<void> {
  const directory = require("@tilecast/player-runtime/runtime-dir") as string;
  const files = await loadRuntimeFiles(directory);
  log.info("player runtime", { version: files.version });
  protocol.handle(RUNTIME_SCHEME, (request) =>
    serveRuntimeRequest(files, request.url),
  );
}

function setupMediaProtocol(): void {
  protocol.handle("tcmedia", async (request) => {
    // tcmedia://variant/<assetId>/<variantId>
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const assetId = url.hostname === "variant" ? parts[0] : parts[1];
    const variantId = url.hostname === "variant" ? parts[1] : parts[2];
    if (!assetId || !variantId || !runtime) {
      return new Response("not found", { status: 404 });
    }
    const resolved = await runtime.resolveMedia(assetId, variantId);
    if (!resolved) {
      return new Response("not found", { status: 404 });
    }
    if (resolved.kind === "file") {
      // net.fetch on a file URL supports Range for video seeking.
      const headers = new Headers();
      const range = request.headers.get("Range");
      if (range) {
        headers.set("Range", range);
      }
      const response = await net.fetch(
        pathToFileURL(resolved.path).toString(),
        {
          headers,
        },
      );
      const out = new Headers(response.headers);
      out.set("Content-Type", resolved.mimeType);
      return new Response(response.body, {
        status: response.status,
        headers: out,
      });
    }
    // Stream-policy media proxies to the server with device auth attached.
    const headers = new Headers(resolved.headers);
    const range = request.headers.get("Range");
    if (range) {
      headers.set("Range", range);
    }
    return net.fetch(resolved.url, { headers });
  });
}

/**
 * Media capture policy.
 *
 * Exactly one surface may open a microphone: the trusted player renderer, which
 * loads the shared runtime from tilecast://runtime/ and is the only place the
 * Noise Meter runs.
 * Everything else is refused — including camera capture for that same renderer,
 * which nothing in Tilecast asks for and which a permission granted by media
 * type rather than by name would otherwise hand over with the microphone.
 *
 * Website items render in <webview> under their own partitioned sessions and
 * are denied capture outright. A site can ask; it never gets a room's audio.
 * Non-capture permissions keep the behavior they had before this handler
 * existed, because setting a handler replaces the default for every permission
 * rather than only for the one being tightened.
 */
function isPlayerRenderer(contents: WebContents | null | undefined): boolean {
  return Boolean(
    contents &&
    window &&
    !window.isDestroyed() &&
    contents.id === window.webContents.id,
  );
}

function microphoneOnly(mediaTypes: string[] | undefined): boolean {
  return (
    Array.isArray(mediaTypes) &&
    mediaTypes.length > 0 &&
    mediaTypes.every((type) => type === "audio")
  );
}

function applyMediaPermissionPolicy(): void {
  session.defaultSession.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      const audioOnly = microphoneOnly(
        (details as { mediaTypes?: string[] }).mediaTypes,
      );
      callback(
        permission === "media" && isPlayerRenderer(contents) && audioOnly,
      );
    },
  );
  session.defaultSession.setPermissionCheckHandler(
    (contents, permission, _origin, details) => {
      const mediaType = (details as { mediaType?: string }).mediaType;
      return (
        permission === "media" &&
        isPlayerRenderer(contents) &&
        mediaType === "audio"
      );
    },
  );
}

function guardWebContents(): void {
  app.on("web-contents-created", (_event, contents) => {
    // Website items render in <webview>; nothing may open new windows or
    // navigate the shell away from the player.
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-attach-webview", (event, webPreferences, params) => {
      const partition = String(params.partition ?? "");
      const policy = partition.includes("disabled")
        ? "disabled"
        : partition.includes("all")
          ? "first_and_third_party"
          : partition.includes("first-party")
            ? "first_party"
            : null;
      if (!policy) {
        event.preventDefault();
        return;
      }
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      configureWebsiteSession(
        session.fromPartition(partition, { cache: true }),
        policy,
      );
    });
    if (contents.getType() === "webview") {
      contents.on("will-navigate", (event, targetUrl) => {
        if (!/^https?:/.test(targetUrl)) {
          event.preventDefault();
        }
      });
    }
  });
}

async function startRuntime(serverUrl: string): Promise<void> {
  // The Presentation Network manager is constructed before the AirPlay manager
  // because AirPlay depends on it: a session with an assigned network must have
  // the Wi-Fi connection up before UxPlay can advertise.
  //
  // fetchProvisioning goes through the runtime's own authenticated client, so the
  // credential travels on the existing device-credential channel and nowhere
  // else. It is never cached, persisted, or logged.
  const presentationNetwork = new PresentationNetworkManager({
    store,
    fetchProvisioning: async () => {
      if (!runtime) {
        throw new PresentationNetworkError(
          "credential_unavailable",
          "The player is not connected to Tilecast yet.",
        );
      }
      return parsePresentationNetworkProvisioning(
        await runtime.fetchPresentationNetworkProvisioning(),
      );
    },
    onStatus: (status) => airplay.onPresentationNetworkStatus(status),
  });
  const airplay = new AirplayManager({
    store,
    presentationNetwork,
    onStatus: (status) => runtime?.onExternalPresentationStatus(status),
  });
  const displayControl = new LinuxDisplayControl();
  runtime = new PlayerRuntime(
    store,
    {
      present,
      presentPlugins,
      applyPlayerConfiguration: (config) =>
        applyLinuxKioskPolicy(linuxKioskPolicy(config)),
      identify: (name, durationSeconds) => {
        sendRuntimeMessage(window, {
          type: "identify",
          name,
          durationSeconds,
        });
      },
      recreateRenderer: () => {
        if (window && !window.isDestroyed()) {
          window.webContents.reloadIgnoringCache();
        } else {
          recreateWindow();
        }
      },
      recreateWindow,
      restartProcess: () => {
        log.info("relaunching player process");
        exitAfterRuntimeStop(0, true);
      },
      exitForUpdate: () => {
        log.info("exiting after AppImage update for systemd restart");
        exitAfterRuntimeStop(0, false);
      },
      clearWebsiteData: async () => {
        // Website playback uses one persistent partition per cookie policy.
        // Clear every persistent website partition, including the legacy
        // name from pre-policy builds, so clearOnRestart actually reaches the
        // data that the renderer uses.
        await Promise.all(
          [
            "persist:tilecast-websites-first-party",
            "persist:tilecast-websites-all",
            "persist:websites",
          ].map((partition) =>
            session
              .fromPartition(partition)
              .clearStorageData()
              .catch(() => {}),
          ),
        );
      },
      retryCurrentItem: () =>
        sendRuntimeMessage(window, { type: "command", command: "retry-item" }),
      skipCurrentItem: () =>
        sendRuntimeMessage(window, { type: "command", command: "skip-item" }),
      prepareExternalPresentation: async (config) => {
        const capabilities = await airplay.probeCapabilities();
        const decoder = capabilities.decoder as SupportedDecoder | null;
        const roleReady =
          config.role === "receiver"
            ? capabilities.groupAirplaySupported
            : capabilities.airplaySupported;
        if (!decoder || !roleReady) {
          throw new Error(
            capabilities.limitation ??
              (config.role === "receiver"
                ? "A GStreamer H.264 receiver is required for group AirPlay."
                : "UxPlay, Avahi, and a supported H.264 GStreamer decoder are required."),
          );
        }
        if (config.role !== "single" && !capabilities.groupAirplaySupported) {
          throw new Error(
            "Group AirPlay requires the GStreamer RTP receiver health/sink plugins.",
          );
        }
        if (
          config.role !== "receiver" &&
          config.audioMode === "gateway_only" &&
          !capabilities.audioAvailable
        ) {
          throw new Error(
            "This player has no verified audio sink; choose no audio for this AirPlay session.",
          );
        }
        if (
          config.profile === "1080p30" &&
          (!capabilities.hardwareH264Decode ||
            capabilities.maxProfile !== "1080p30")
        ) {
          throw new Error(
            "This player cannot safely decode the requested 1080p30 AirPlay profile.",
          );
        }
        return airplay.prepareSession(config, decoder);
      },
      startExternalPresentation: async () => {
        const capabilities = await airplay.probeCapabilities();
        const decoder = capabilities.decoder as SupportedDecoder | null;
        if (!decoder) throw new Error("No H.264 decoder is available.");
        return airplay.startGateway(decoder);
      },
      stopExternalPresentation: (reason) => airplay.stopSession(reason),
      recoverExternalPresentation: async () => {
        const capabilities = await airplay.probeCapabilities();
        const decoder = capabilities.decoder as SupportedDecoder | null;
        const status = await airplay.recoverSession(decoder);
        const config = airplay.getConfig();
        return status && config ? { config, status } : null;
      },
      getExternalPresentationStatus: () => airplay.getStatus(),
      probeAirplayCapabilities: () => airplay.probeCapabilities(),
      probePresentationNetwork: () => presentationNetwork.probe(),
      applyPresentationNetworkAssignment: (assignment) =>
        presentationNetwork.applyAssignment(assignment),
      reconcilePresentationNetwork: () => presentationNetwork.reconcile(),
      getPresentationNetworkState: () => {
        const status = presentationNetwork.getStatus();
        return {
          state: status.state,
          networkId: status.networkId,
          activeNetworkId: status.activeNetworkId,
          installedNetworkId: status.installedNetworkId,
          installedRevision: status.installedRevision,
          ...(status.failureCode ? { failureCode: status.failureCode } : {}),
          ...(status.lastConnectedAt
            ? { lastConnectedAt: status.lastConnectedAt }
            : {}),
          ...(status.lastFailureAt
            ? { lastFailureAt: status.lastFailureAt }
            : {}),
        };
      },
      // The bounded Test connection action. It joins, confirms an address, confirms
      // Ethernet is still the default route, then disconnects and restores the prior
      // radio state. It deliberately does not start UxPlay, create an AirPlay
      // session, or interrupt signage beyond the system-level network work itself.
      testPresentationNetwork: async (networkId, timeoutSeconds) => {
        const assignment = presentationNetwork.getAssignment();
        if (!assignment || assignment.presentationNetworkId !== networkId) {
          return {
            success: false,
            code: "presentation_network_not_assigned",
            message:
              "This player has not received that Presentation Network assignment yet.",
          };
        }
        try {
          const status = await presentationNetwork.connect("connection_test");
          const capability = presentationNetwork.getCapability();
          if (status.state !== "connected") {
            return {
              success: false,
              code: status.failureCode ?? "presentation_network_failed",
              message:
                status.failureMessage ??
                `Tilecast could not join ${assignment.name}.`,
            };
          }
          // A precise result, not raw nmcli output: the operator needs to know that
          // authentication worked, an address arrived, and Ethernet stayed in
          // charge.
          const ethernetOk =
            capability?.wiredInterfaceAvailable === true &&
            validIpv4(capability.wiredIpv4);
          return {
            success: ethernetOk,
            code: ethernetOk
              ? "presentation_network_test_passed"
              : "ethernet_default_route_lost",
            message: ethernetOk
              ? `Joined ${assignment.name}: authentication succeeded, an IPv4 address was obtained, and Ethernet remains this player's primary connection.`
              : `Joined ${assignment.name}, but Ethernet is no longer usable as this player's primary connection.`,
          };
        } catch (error) {
          const status = presentationNetwork.getStatus();
          return {
            success: false,
            code: status.failureCode ?? "presentation_network_failed",
            message:
              status.failureMessage ??
              (error instanceof Error ? error.message : "The test failed."),
          };
        } finally {
          // Always leave the player as it was found, whichever way the test went.
          await presentationNetwork
            .disconnect("connection_test_complete")
            .catch(() => undefined);
        }
      },
      probeDisplayControl: () => displayControl.probe(),
      executeDisplayControl: (command) => displayControl.execute(command),
      screenSize: () => {
        // The server rejects any heartbeat whose screen size is < 1, which
        // silently freezes the screen's presence ("online" but never updating
        // "last contacted"). Some Linux setups report 0x0 from the primary
        // display (e.g. before the compositor publishes geometry), so fall
        // back through the display size and the window's own content size, and
        // never return a non-positive dimension.
        const candidates: Array<{ width: number; height: number }> = [];
        try {
          const display = screen.getPrimaryDisplay();
          candidates.push(display.bounds, display.size, display.workAreaSize);
        } catch {
          /* no display available yet */
        }
        if (window && !window.isDestroyed()) {
          const size = window.getContentSize();
          candidates.push({ width: size[0] ?? 0, height: size[1] ?? 0 });
        }
        for (const candidate of candidates) {
          if (candidate && candidate.width >= 1 && candidate.height >= 1) {
            return {
              width: Math.round(candidate.width),
              height: Math.round(candidate.height),
            };
          }
        }
        return { width: 1920, height: 1080 };
      },
      // Deliberately not the fallback chain above. `screenSize` must always
      // return something usable because a heartbeat is rejected without it;
      // this reports what the panel actually says, including "nothing", because
      // a screen with no display attached is precisely the fault being looked
      // for. The two disagreeing is the signal.
      displayInfo: () => {
        try {
          const displays = screen.getAllDisplays();
          const display = screen.getPrimaryDisplay();
          const size = display.size;
          return {
            connected:
              displays.length > 0 && size.width >= 1 && size.height >= 1,
            width: Math.round(size.width),
            height: Math.round(size.height),
            // Electron reports 0 when the compositor does not publish a rate.
            refreshHz:
              display.displayFrequency > 0
                ? display.displayFrequency
                : undefined,
          };
        } catch {
          // No display server answered at all, which is not the same as a panel
          // reporting itself absent — so it is reported as unknown, not as a
          // disconnected display.
          return null;
        }
      },
      availableStorageBytes,
      capturePreview: async (max) => {
        if (!window || window.isDestroyed()) {
          return null;
        }
        // Primary path: capture the real display framebuffer. This is the only
        // method that includes hardware-overlay video, VA-API-decoded frames,
        // and <webview> content — everything webContents.capturePage() misses
        // on this GPU pipeline, which is why previews came back "unavailable".
        if (screenCaptureAllowed()) {
          try {
            const display = screen.getDisplayMatching(window.getBounds());
            // Ask for the thumbnail already scaled to the upload cap so the old
            // GPU/CPU never encodes a full-resolution frame. desktopCapturer
            // preserves aspect ratio within these bounds.
            const sources = await desktopCapturer.getSources({
              types: ["screen"],
              thumbnailSize: { width: max.width, height: max.height },
            });
            const source =
              sources.find(
                (s) => String(s.display_id) === String(display.id),
              ) ?? sources[0];
            if (source && !source.thumbnail.isEmpty()) {
              const encoded = encodePreview(source.thumbnail, max);
              if (encoded) {
                return encoded;
              }
            }
            log.debug("preview: screen capture yielded no usable frame", {
              sources: sources.length,
            });
          } catch (err) {
            log.warn("preview: screen capture failed; trying capturePage", {
              error: String(err),
            });
          }
        }
        // Fallback: the window's own paint. Works for pure-DOM (image) content
        // and when screen capture is unavailable (e.g. Wayland without the
        // screen-share portal). Overlay video / webview frames stay black here.
        try {
          const image = await window.webContents.capturePage();
          return encodePreview(image, max);
        } catch (err) {
          log.warn("preview: capturePage failed", { error: String(err) });
          return null;
        }
      },
    },
    { serverUrl, playerVersion: PLAYER_VERSION },
  );
  await runtime.start();
}

app.whenReady().then(async () => {
  store = new StateStore(process.env.TILECAST_DATA_DIR ?? defaultDataDir());
  await store.init();

  // Keep the off-hours overlay in sync even when a policy changes while the
  // runtime remains in the same deduplicated sleep state.
  setInterval(
    () => void refreshOutsideActiveHoursPresentation(),
    OUTSIDE_HOURS_REFRESH_MS,
  );

  // Start with hardened defaults; cached configuration can adjust this as soon
  // as the runtime loads.
  applyLinuxKioskPolicy(activeLinuxKioskPolicy);

  setupMediaProtocol();
  await setupRuntimeProtocol();
  applyMediaPermissionPolicy();
  guardWebContents();

  ipcMain.on(
    "progress",
    (
      _event,
      data: { itemId: string | null; kind: string; zoneId?: string },
    ) => {
      runtime?.onPlaybackProgress(data.itemId, data.kind, data.zoneId);
    },
  );
  ipcMain.on(
    "playback-error",
    (_event, data: { itemId: string | null; message: string }) => {
      runtime?.onPlaybackError(data.itemId, data.message);
    },
  );
  ipcMain.on("website-recovered", () => runtime?.onWebsiteRecovered());
  ipcMain.on(
    "runtime-ready",
    (_event, data: { contractVersion?: unknown; runtimeVersion?: unknown }) => {
      log.info("player runtime ready", {
        contractVersion: Number(data?.contractVersion),
        runtimeVersion: String(data?.runtimeVersion ?? "").slice(0, 32),
      });
    },
  );
  // Noise Meter state and completed history buckets. The renderer measures;
  // the runtime owns the durable queue and the heartbeat that drains it.
  ipcMain.on(
    "noise-meter-report",
    (_event, data: { status?: string; level?: number; bucket?: unknown }) => {
      void runtime?.onNoiseMeterReport({
        status: typeof data?.status === "string" ? data.status : undefined,
        level: typeof data?.level === "number" ? data.level : null,
        bucket: (data?.bucket ?? null) as never,
      });
    },
  );
  // A Noise Meter that cannot open a microphone keeps signage running and says
  // so here. The payload is bounded because it crosses the renderer boundary,
  // and it carries a reason rather than anything measured.
  ipcMain.on(
    "noise-meter-diagnostic",
    (_event, data: { message?: unknown; detail?: unknown }) => {
      log.warn("noise meter", {
        message: String(data?.message ?? "").slice(0, 200),
        detail: JSON.stringify(data?.detail ?? {}).slice(0, 500),
      });
    },
  );
  ipcMain.handle("setup-server-url", async (_event, url: string) => {
    const result = normalizeServerUrl(String(url));
    if (!result.ok || !result.url) {
      return { ok: false, error: result.error ?? "Invalid address" };
    }
    await store.writeJson(SERVER_URL_FILE, { serverUrl: result.url });
    discovery?.stop();
    // Restart cleanly into the configured state.
    exitAfterRuntimeStop(0, true);
    return { ok: true };
  });

  window = createWindow();

  const serverUrl = await resolveServerUrl();
  if (!serverUrl) {
    present({ state: "setup" });
    // Offer LAN-discovered servers as one-tap choices on the setup screen.
    discovery = new LanDiscovery((server: DiscoveredServer) => {
      sendRuntimeMessage(window, { type: "discovered-server", server });
    });
    discovery.start();
    ipcMain.handle("list-discovered-servers", () => discovery?.list() ?? []);
    return;
  }

  try {
    await startRuntime(serverUrl);
  } catch (err) {
    log.error("runtime failed to start; relaunching in 15s", {
      error: String(err),
    });
    setTimeout(() => {
      exitAfterRuntimeStop(1, true);
    }, 15_000);
  }
});

app.on("window-all-closed", () => {
  // A signage player has no user-driven quit; recreate instead. The
  // per-window closed handler usually restores it first — only act when it
  // has not.
  if (!quitting && (!window || window.isDestroyed())) {
    recreateWindow();
  }
});

app.on("before-quit", (event) => {
  if (shutdownPromise) return;
  event.preventDefault();
  quitting = true;
  void stopRuntime().finally(() => app.exit(0));
});

process.on("uncaughtException", (err) => {
  log.error("uncaught exception; relaunching", { error: String(err.stack) });
  exitAfterRuntimeStop(1, true);
});
process.on("unhandledRejection", (reason) => {
  // Never let an unawaited promise take the player down silently.
  log.error("unhandled rejection", { error: String(reason) });
});
