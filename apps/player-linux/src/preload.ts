/**
 * The Electron host adapter for the shared Tilecast Player Runtime.
 *
 * Implements TilecastRuntimeHostV1 (packages/player-runtime/src/host/
 * contract.ts) over a fixed set of typed IPC channels, and nothing else: no
 * generic invoke, no Node access, no state or filesystem reads. Everything the
 * runtime needs is prepared in the main process, so this preload runs in the
 * OS sandbox and requires only "electron".
 */
import { contextBridge, ipcRenderer } from "electron";
import type {
  DiscoveredServerV1,
  EvidenceReportV1,
  HostMessageV1,
  NoiseMeterReportV1,
  PlaybackErrorReportV1,
  PresentationResultV1,
  RuntimeReadyV1,
  SetupResultV1,
  TilecastRuntimeHostV1,
} from "@tilecast/player-runtime/host-contract";

// A sandboxed preload cannot require the runtime package, so the contract's
// two constants are restated here; the type import above keeps them honest.
const CONTRACT_VERSION: TilecastRuntimeHostV1["contractVersion"] = 1;
/** The evidence vocabulary the player's supervisor understands. */
const PLAYER_EVIDENCE = new Set<string>([
  "item-started",
  "item-transition",
  "image-shown",
  "video-progress",
  "widget-shown",
  "widget-alive",
  "widget-empty",
  "layout-shown",
  "layout-alive",
  "layout-zone-rendered",
  "website-loaded",
  "website-alive",
]);

const listeners = new Set<(message: HostMessageV1) => void>();
// The latest presentation and plugin state, replayed to a new subscriber so a
// reloaded runtime resumes where the player left off.
let lastPresentation: HostMessageV1 | null = null;
let lastPlugins: HostMessageV1 | null = null;

function emit(message: HostMessageV1): void {
  if (message.type === "presentation") lastPresentation = message;
  if (message.type === "plugins") lastPlugins = message;
  for (const listener of listeners) {
    try {
      listener(message);
    } catch (error) {
      console.error("tilecast host listener failed", error);
    }
  }
}

ipcRenderer.on("runtime-message", (_event, message: HostMessageV1) => {
  emit(message);
});

const text = (value: unknown, max: number) => String(value ?? "").slice(0, max);

const host: TilecastRuntimeHostV1 = {
  contractVersion: CONTRACT_VERSION,
  info: {
    host: "electron",
    hostVersion: text(process.env["TILECAST_PLAYER_VERSION"], 32) || "unknown",
    engine: "chromium",
    engineVersion: text(process.versions["chrome"], 32),
  },
  capabilities: {
    remoteWeb: "electron-webview",
    synchronizedPlayback: true,
    setup: true,
    discovery: true,
    noiseMeter: "renderer-microphone",
  },
  subscribe(listener) {
    listeners.add(listener);
    if (lastPresentation) listener(lastPresentation);
    if (lastPlugins) listener(lastPlugins);
    return () => {
      listeners.delete(listener);
    };
  },
  ready(ready: RuntimeReadyV1) {
    ipcRenderer.send("runtime-ready", {
      contractVersion: Number(ready.contractVersion),
      runtimeVersion: text(ready.runtimeVersion, 32),
    });
  },
  // The Electron player accepts every presentation it sends; the result is
  // informational only.
  presentationResult(result: PresentationResultV1) {
    if (result.outcome === "rejected") {
      ipcRenderer.send("playback-error", {
        itemId: null,
        message: text(`presentation rejected: ${result.message ?? ""}`, 240),
      });
    }
  },
  reportEvidence(report: EvidenceReportV1) {
    if (!PLAYER_EVIDENCE.has(report.kind)) return;
    ipcRenderer.send("progress", {
      itemId: report.itemId === null ? null : text(report.itemId, 160),
      kind: report.kind,
      zoneId:
        report.zoneId === undefined ? undefined : text(report.zoneId, 160),
    });
  },
  reportPlaybackError(report: PlaybackErrorReportV1) {
    ipcRenderer.send("playback-error", {
      itemId: report.itemId === null ? null : text(report.itemId, 160),
      message: text(report.message, 240),
    });
  },
  setup: {
    submitServerUrl(url: string): Promise<SetupResultV1> {
      return ipcRenderer.invoke("setup-server-url", text(url, 512));
    },
  },
  discovery: {
    list(): Promise<DiscoveredServerV1[]> {
      return ipcRenderer.invoke("list-discovered-servers");
    },
  },
  // The Noise Meter's whole outbound surface: derived numbers and a bounded
  // diagnostic. The microphone stream and every sample stay in the renderer.
  noiseMeter: {
    report(report: NoiseMeterReportV1) {
      ipcRenderer.send("noise-meter-report", {
        status: text(report.status, 32),
        level: typeof report.level === "number" ? report.level : null,
        bucket: report.bucket ?? null,
      });
    },
    diagnostic(message: string, detail?: Record<string, unknown>) {
      ipcRenderer.send("noise-meter-diagnostic", { message, detail });
    },
  },
  remoteWeb: {
    reportRecovered() {
      ipcRenderer.send("website-recovered");
    },
  },
};

contextBridge.exposeInMainWorld("tilecastRuntimeHost", host);
