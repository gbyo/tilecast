/**
 * The frames the preview can show a Widget in, and which one it starts at.
 * The choice is a way of looking at the Widget: it is viewing state and
 * never part of the draft.
 */
import type { PreviewFrame } from "@/content/WidgetPreviewHost";
import {
  DEFAULT_WIDGET_FRAME,
  FRAME_BOUNDS,
  sameFrame,
} from "@/content/widgetGeometry";

export const PREVIEW_FRAMES = [
  { key: "landscape", width: 960, height: 540 },
  { key: "portrait", width: 540, height: 960 },
  { key: "strip", width: 960, height: 240 },
  { key: "sidebar", width: 360, height: 960 },
  { key: "small", width: 320, height: 180 },
] as const;

type PresetKey = (typeof PREVIEW_FRAMES)[number]["key"];

/**
 * "recommended" is the Widget's own declared geometry when it is not one
 * of the named presets; it is never rounded into a preset it does not match.
 */
export type FrameKey = PresetKey | "recommended" | "custom";

export const CUSTOM_BOUNDS = FRAME_BOUNDS;

export function clampFrameSide(value: number) {
  if (!Number.isFinite(value)) return CUSTOM_BOUNDS.min;
  return Math.max(
    CUSTOM_BOUNDS.min,
    Math.min(CUSTOM_BOUNDS.max, Math.round(value)),
  );
}

function presetMatching(frame: PreviewFrame) {
  return PREVIEW_FRAMES.find((entry) => sameFrame(entry, frame));
}

/** Where the preview opens: the Widget's recommendation, else Landscape. */
export function initialFrameChoice(recommended: PreviewFrame | null): {
  key: FrameKey;
  custom: PreviewFrame;
} {
  if (!recommended) return { key: "landscape", custom: DEFAULT_WIDGET_FRAME };
  const preset = presetMatching(recommended);
  return { key: preset?.key ?? "recommended", custom: recommended };
}

/** The frame the preview renders for the current choice. */
export function resolveFrame(
  key: FrameKey,
  custom: PreviewFrame,
  recommended: PreviewFrame | null,
): PreviewFrame {
  if (key === "recommended") return recommended ?? custom;
  if (key === "custom") return custom;
  return PREVIEW_FRAMES.find((entry) => entry.key === key) ?? custom;
}

/** Whether the frame selector offers the Widget's own geometry as a choice. */
export function offersRecommendedFrame(recommended: PreviewFrame | null) {
  return recommended !== null && !presetMatching(recommended);
}
