import type { RuntimeReadyV1 } from "@tilecast/player-runtime/host-contract";
import type { SelectionFacts } from "@tilecast/player-runtime/projection";

const UUID = /^[a-f0-9-]{36}$/;

export interface HeartbeatInputs {
  screenWidth: number;
  screenHeight: number;
  hostVersion: string;
  uptimeSeconds: number;
  currentItemId?: string;
  playing: boolean;
  support: RuntimeReadyV1["support"];
  selection?: SelectionFacts | null;
  manifestVersion?: number;
  configRevision?: number;
  lastPlaybackError?: string;
}

/**
 * The Browser Player heartbeat. Capability fields come from the live Runtime
 * report, never from this host's name, and selection fields repeat what the
 * server chose rather than anything this host derived.
 */
export function heartbeatPayload(input: HeartbeatInputs) {
  const selection = input.selection;
  return {
    screenWidth: Math.max(1, input.screenWidth),
    screenHeight: Math.max(1, input.screenHeight),
    playerVersion: input.hostVersion,
    playerFamily: "browser",
    ...(input.currentItemId && UUID.test(input.currentItemId)
      ? { currentItemId: input.currentItemId }
      : {}),
    playbackState: input.playing ? "playing" : "idle",
    presentationSchemaVersions: input.support?.presentationSchemas,
    // Both namespaces already use the contract's capability names, for example
    // `content.text` and `widget.tilecast.clock`. They are reported as given.
    nativePresentationCapabilities: {
      ...input.support?.declarativeCapabilities,
      ...input.support?.widgetComponents,
    },
    uptimeSeconds: Math.floor(input.uptimeSeconds),
    ...(input.manifestVersion !== undefined
      ? { activeManifestVersion: input.manifestVersion }
      : {}),
    ...(input.configRevision !== undefined
      ? { activeConfigRevision: input.configRevision }
      : {}),
    ...(selection
      ? {
          selectionSource: selection.source,
          ...(selection.playlistId && UUID.test(selection.playlistId)
            ? { currentPlaylistId: selection.playlistId }
            : {}),
          ...(selection.nextTransitionAt
            ? { nextTransitionAt: selection.nextTransitionAt }
            : {}),
        }
      : {}),
    ...(input.lastPlaybackError
      ? { lastPlaybackError: input.lastPlaybackError.slice(0, 500) }
      : {}),
  };
}
