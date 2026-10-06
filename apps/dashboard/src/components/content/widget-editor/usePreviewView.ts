/**
 * How the author is looking at the Widget: frame, zoom, and the preview
 * instant. All of it is viewing state; none of it reaches the draft.
 */
import { useLayoutEffect, useRef, useState } from "react";
import type { PreviewFrame } from "@/content/WidgetPreviewHost";
import { initialPreviewTime, type PreviewTime } from "@/content/previewTime";
import {
  initialFrameChoice,
  resolveFrame,
  type FrameKey,
} from "./previewFrames";

export const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2] as const;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;
export const STAGE_PADDING = 32;

/** The scale at which the frame fits the stage, tracking its size. */
function useStageFit(frame: PreviewFrame) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      const width = stage.clientWidth - STAGE_PADDING * 2;
      const height = stage.clientHeight - STAGE_PADDING * 2;
      if (width <= 0 || height <= 0) return;
      const next = Math.min(width / frame.width, height / frame.height, 2);
      setFit((current) => (Math.abs(current - next) < 0.001 ? current : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [frame.width, frame.height]);
  return { stageRef, fit };
}

export function usePreviewView(recommended: PreviewFrame | null) {
  const [frameKey, setFrameKey] = useState<FrameKey>(
    () => initialFrameChoice(recommended).key,
  );
  const [custom, setCustom] = useState<PreviewFrame>(
    () => initialFrameChoice(recommended).custom,
  );
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [previewTime, setPreviewTime] =
    useState<PreviewTime>(initialPreviewTime);
  const frame = resolveFrame(frameKey, custom, recommended);
  const { stageRef, fit } = useStageFit(frame);
  const scale = zoom === "fit" ? fit : zoom;

  const zoomBy = (direction: 1 | -1) => {
    const next =
      direction > 0
        ? ZOOM_STEPS.find((step) => step > scale + 0.001)
        : [...ZOOM_STEPS].reverse().find((step) => step < scale - 0.001);
    if (next !== undefined) setZoom(next);
  };
  const chooseFrame = (key: FrameKey) => {
    // Custom starts from the frame being looked at, not from nothing.
    if (key === "custom" && frameKey !== "custom") setCustom(frame);
    setFrameKey(key);
    setZoom("fit");
  };

  return {
    frameKey,
    chooseFrame,
    custom,
    setCustom,
    frame,
    zoom,
    setZoom,
    zoomBy,
    scale,
    stageRef,
    previewTime,
    setPreviewTime,
  };
}

export type PreviewView = ReturnType<typeof usePreviewView>;
