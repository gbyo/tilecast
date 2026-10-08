import type {
  TilecastRuntimeHostV1,
  HostMessageV1,
  RuntimeReadyV1,
  EvidenceReportV1,
  PlaybackErrorReportV1,
  PresentationResultV1,
} from "@tilecast/player-runtime/host-contract";
import { statusSurface } from "@tilecast/player-runtime/projection";

/** A typed boundary only. The exact production Runtime owns every display surface. */
export function runtimeHost(callbacks: {
  ready(value: RuntimeReadyV1): void;
  evidence(value: EvidenceReportV1): void;
  error(value: PlaybackErrorReportV1): void;
  result(value: PresentationResultV1): void;
  info: TilecastRuntimeHostV1["info"];
  remoteWeb?: TilecastRuntimeHostV1["remoteWeb"];
}) {
  const listeners = new Set<(message: HostMessageV1) => void>();
  let presentation: HostMessageV1 = {
    type: "presentation",
    presentation: statusSurface("connecting", undefined),
  };
  let plugins: HostMessageV1 = {
    type: "plugins",
    plugins: [],
    clockOffsetMs: 0,
    media: [],
  };
  const host: TilecastRuntimeHostV1 = {
    contractVersion: 1,
    info: callbacks.info,
    capabilities: {
      remoteWeb: callbacks.remoteWeb ? "host-view" : null,
      // Browser Player does not produce the shared timeline anchors, so it
      // does not claim synchronized playback.
      synchronizedPlayback: false,
      setup: false,
      discovery: false,
      // The frame route is served by the controlling service worker,
      // which boot guarantees before the Runtime reads this. Read live:
      // without a controller there is no verified frame store to serve.
      get externalFrames(): boolean {
        return (
          typeof navigator !== "undefined" &&
          !!navigator.serviceWorker?.controller
        );
      },
      // Sandbox frames navigate bare so the worker sees them: a service
      // worker never sees a sandboxed iframe's navigation, so the
      // attribute would bypass the verified store. The served frame
      // response carries the sandbox directive instead. See
      // docs/widget-sandbox-spike.md.
      externalFrameSandbox: "response",
    },
    ...(callbacks.remoteWeb ? { remoteWeb: callbacks.remoteWeb } : {}),
    subscribe(listener) {
      listeners.add(listener);
      listener(plugins);
      listener(presentation);
      return () => {
        listeners.delete(listener);
      };
    },
    ready: callbacks.ready,
    presentationResult: callbacks.result,
    reportEvidence: callbacks.evidence,
    reportPlaybackError: callbacks.error,
  };
  return {
    host,
    send(message: HostMessageV1) {
      if (message.type === "presentation") presentation = message;
      if (message.type === "plugins") plugins = message;
      for (const listener of listeners) listener(message);
    },
  };
}
