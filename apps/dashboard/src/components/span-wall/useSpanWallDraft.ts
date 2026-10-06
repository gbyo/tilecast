import { useEffect, useState } from "react";
import type { ScreenGroup, SpanPanel, SpanStatus } from "../../api/types";
import {
  buildPanels,
  DEFAULT_CANVAS,
  type SpanCanvas,
  type SpanPreset,
} from "./spanWallModel";

/**
 * The editable wall. An unsaved wall starts as a draft and is dirty from its
 * first frame, so choosing Span never changes the server until it is saved.
 * A saved wall follows the server until the person edits it, and a refetch
 * never marks it dirty.
 */
export function useSpanWallDraft(
  group: Pick<ScreenGroup, "displayMode" | "screens">,
  server: SpanStatus | undefined,
) {
  const saved = group.displayMode === "span";
  const [canvas, setCanvas] = useState<SpanCanvas>(DEFAULT_CANVAS);
  const [panels, setPanels] = useState<SpanPanel[]>(() =>
    saved ? [] : buildPanels(group.screens, 3840, 1080, 2),
  );
  const [dirty, setDirty] = useState(!saved);

  useEffect(() => {
    if (dirty || !server) return;
    setCanvas(server.geometry.canvas);
    setPanels(server.geometry.panels);
  }, [dirty, server]);

  return {
    saved,
    canvas,
    panels,
    dirty,
    setCanvasSize: (key: keyof SpanCanvas, value: number) => {
      setDirty(true);
      setCanvas((current) => ({ ...current, [key]: value }));
    },
    setPanel: (screenId: string, key: keyof SpanPanel, value: number) => {
      setDirty(true);
      setPanels((current) =>
        current.map((panel) =>
          panel.screenId === screenId ? { ...panel, [key]: value } : panel,
        ),
      );
    },
    applyPreset: (preset: SpanPreset) => {
      setCanvas({ ...preset.canvas });
      setPanels(
        buildPanels(
          group.screens,
          preset.canvas.width,
          preset.canvas.height,
          preset.columns,
        ),
      );
      setDirty(true);
    },
    /** Back to the server's wall. */
    reset: () => {
      if (server) {
        setCanvas(server.geometry.canvas);
        setPanels(server.geometry.panels);
      }
      setDirty(false);
    },
    markSaved: () => {
      setDirty(false);
    },
  };
}
