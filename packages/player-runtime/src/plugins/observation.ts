/**
 * The engine's view state, reduced to what `player.presentation.observe@1`
 * promises: what owns the screen and the item shown. A staged item that is
 * still preparing on the hidden layer is not yet observed.
 */
import type { PresentationObservation } from "@tilecast/plugin-sdk/player";
import type { RuntimeViewState } from "../engine/controller";

const SOUND_KINDS = new Set(["video", "website", "youtube"]);

export function observePresentation(
  state: RuntimeViewState,
): PresentationObservation {
  if (state.mode !== "playing") return { mode: state.mode, item: null };
  const stage = state.stage;
  if (!stage || stage.phase !== "shown") return { mode: "playing", item: null };
  const { item } = stage;
  return {
    mode: "playing",
    item: {
      id: item.id,
      kind: item.kind,
      occurrence: stage.mount * 1000 + stage.restarts,
      audible:
        SOUND_KINDS.has(item.kind) && item.audioEnabled && item.volume > 0,
    },
  };
}
