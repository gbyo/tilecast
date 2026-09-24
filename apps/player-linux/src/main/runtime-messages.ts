/**
 * Builds the host messages the Electron player sends to the shared Player
 * Runtime (TilecastRuntimeHostV1).
 *
 * The shared-timeline enrichment used to run in the renderer's preload, which
 * is why that preload needed Node and could not be sandboxed. It now runs
 * here, in the main process, with the same inputs: the presentation and the
 * active manifest on disk. The runtime anchors and advances the timeline.
 */
import type {
  PresentationMessage,
  RuntimePresentation,
} from "@tilecast/player-runtime/host-contract";
import type { StoredManifest } from "../core/manifest";
import type { Presentation } from "../core/player";
import type { OutsideActiveHoursPresentation } from "../core/outside-hours";
import { enrichSynchronizedPresentation } from "../core/synchronized-playback";

export type HostPresentation = Presentation | OutsideActiveHoursPresentation;

export function presentationMessage(
  presentation: HostPresentation,
  stored: StoredManifest | null,
  nowMs = Date.now(),
): PresentationMessage {
  if (presentation.state !== "playing") {
    return {
      type: "presentation",
      presentation: presentation as unknown as RuntimePresentation,
    };
  }
  const enriched = enrichSynchronizedPresentation(presentation, stored, nowMs);
  if (!("synchronizedPlayback" in enriched)) {
    return {
      type: "presentation",
      presentation: presentation as unknown as RuntimePresentation,
    };
  }
  const { synchronizedPlayback, ...rest } = enriched;
  return {
    type: "presentation",
    presentation: {
      ...(rest as unknown as Extract<
        RuntimePresentation,
        { state: "playing" }
      >),
      synchronized: true,
    },
    timing: {
      groupId: synchronizedPlayback.groupId,
      anchorMs: synchronizedPlayback.anchorMs,
      durationsMs: synchronizedPlayback.durationsMs,
      // The Electron player has always placed a group on its local wall
      // clock (host time synchronization keeps the group together).
      clockOffsetMs: 0,
    },
  };
}
