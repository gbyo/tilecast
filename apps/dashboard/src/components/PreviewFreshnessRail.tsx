import type { CSSProperties } from "react";
import { previewRailPhase, type PreviewRailState } from "./livePreviewState";

/**
 * A 2px visual reinforcement of preview freshness, laid over the seam between
 * a Screens grid preview and its details. It carries no information the card
 * text does not (the capture age badge, the capture-error label), so it is
 * hidden from assistive technology. Styles live in styles/screens.css.
 */
export function PreviewFreshnessRail({
  state,
  screenId,
}: {
  state: PreviewRailState;
  screenId: string;
}) {
  return (
    <span
      aria-hidden="true"
      className="screen-preview-rail"
      data-state={state}
      style={{ "--rail-phase": previewRailPhase(screenId) } as CSSProperties}
    >
      <span className="screen-preview-rail__sweep" />
    </span>
  );
}
