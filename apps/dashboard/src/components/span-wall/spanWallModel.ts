import type { TFunction } from "i18next";
import type { ScreenGroup, SpanPanel } from "../../api/types";

export type SpanCanvas = { width: number; height: number };

export const DEFAULT_CANVAS: SpanCanvas = { width: 3840, height: 1080 };

export const spanPresets = [
  { label: "2 × 1", columns: 2, canvas: { width: 3840, height: 1080 } },
  { label: "1 × 2", columns: 1, canvas: { width: 1920, height: 2160 } },
  { label: "2 × 2", columns: 2, canvas: { width: 3840, height: 2160 } },
] as const;

export type SpanPreset = (typeof spanPresets)[number];

/** Lays screens out in a grid of `columns` across the canvas. */
export function buildPanels(
  screens: ScreenGroup["screens"],
  width: number,
  height: number,
  columns: number,
): SpanPanel[] {
  const safeColumns = Math.max(1, Math.min(columns, screens.length || 1));
  const rows = Math.max(1, Math.ceil(screens.length / safeColumns));
  return screens.map((screen, index) => {
    const row = Math.floor(index / safeColumns);
    const column = index % safeColumns;
    const x = Math.floor((column * width) / safeColumns);
    const right = Math.floor(((column + 1) * width) / safeColumns);
    const y = Math.floor((row * height) / rows);
    const bottom = Math.floor(((row + 1) * height) / rows);
    return {
      screenId: screen.id,
      screenName: screen.name,
      order: index,
      x,
      y,
      width: right - x,
      height: bottom - y,
      rotation: 0,
      bezelLeft: 0,
      bezelTop: 0,
      bezelRight: 0,
      bezelBottom: 0,
    };
  });
}

export const rotationOptions = [0, 90, 180, 270].map((value) => ({
  value: String(value),
  label: `${value}°`,
}));

export const bezelKeys = [
  "bezelLeft",
  "bezelTop",
  "bezelRight",
  "bezelBottom",
] as const;

export const geometryKeys = ["x", "y", "width", "height"] as const;

export function preparationStatusLabel(
  status: string | undefined,
  t: TFunction<"layouts", undefined>,
): string {
  switch (status) {
    case "queued":
      return t("spanWall.preparationQueued");
    case "processing":
      return t("spanWall.preparationProcessing");
    case "ready":
      return t("spanWall.preparationReady");
    case "failed":
      return t("spanWall.preparationFailed");
    default:
      return t("spanWall.preparationIdle");
  }
}
