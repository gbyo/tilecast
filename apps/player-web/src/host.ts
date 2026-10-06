import type {
  TilecastRuntimeHostV1,
  HostMessageV1,
  RuntimeReadyV1,
  EvidenceReportV1,
  PlaybackErrorReportV1,
  PresentationResultV1,
} from "@tilecast/player-runtime/host-contract";

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
    presentation: {
      state: "idle",
      title: "Browser Player",
      message: "Connecting to Tilecast…",
    },
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
      synchronizedPlayback: true,
      setup: false,
      discovery: false,
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
