/**
 * The geometry a Widget is designed for, as its definition declares it
 * (`authoring.preview.recommendedFrame`, docs/widget-authoring.md). It is
 * an authoring hint: Studio opens the preview at it, renders library
 * thumbnails at it, and gives a new Layout placement its aspect ratio. The
 * Player never sees it and nothing validates against it.
 */
import type {
  Asset,
  ContentDefinitionCatalog,
  WidgetDefinition,
} from "@/api/types";

export interface WidgetFrame {
  readonly width: number;
  readonly height: number;
}

/** The Server enforces the same bounds (contentdefs.AuthoringProblem). */
export const FRAME_BOUNDS = { min: 32, max: 3840 } as const;

/** What a Widget without a recommendation previews at. */
export const DEFAULT_WIDGET_FRAME: WidgetFrame = { width: 960, height: 540 };

function validSide(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= FRAME_BOUNDS.min &&
    value <= FRAME_BOUNDS.max
  );
}

/** The definition's recommended frame, or null when it declares none or an invalid one. */
export function recommendedFrameOf(
  definition: Pick<WidgetDefinition, "authoring"> | undefined | null,
): WidgetFrame | null {
  const frame = definition?.authoring?.preview?.recommendedFrame;
  if (!frame || !validSide(frame.width) || !validSide(frame.height))
    return null;
  return { width: frame.width, height: frame.height };
}

/** The recommended frame of a Widget provider in the catalog. */
export function recommendedFrameForProvider(
  catalog: ContentDefinitionCatalog | undefined,
  provider: string | undefined,
): WidgetFrame | null {
  if (!provider) return null;
  return recommendedFrameOf(
    catalog?.widgets.find((definition) => definition.id === provider),
  );
}

/** The recommended frame of the Widget a library asset places, if it is one. */
export function recommendedFrameForAsset(
  catalog: ContentDefinitionCatalog | undefined,
  asset: Pick<Asset, "type" | "widget">,
): WidgetFrame | null {
  return asset.type === "widget"
    ? recommendedFrameForProvider(catalog, asset.widget?.provider)
    : null;
}

export function sameFrame(a: WidgetFrame, b: WidgetFrame) {
  return a.width === b.width && a.height === b.height;
}

/**
 * The size of a new placement for a Widget with a recommended frame.
 *
 * Without a recommendation a new placement covers 40% of the canvas in each
 * direction. A recommended frame keeps that same area, so a 16:9 Widget
 * lands exactly where it always did, but takes the frame's aspect ratio. A
 * very wide or tall shape would outgrow the canvas, so it is limited to 80%
 * of the canvas on each side with its aspect ratio kept: a 1920x160 strip on
 * a 1920x1080 canvas becomes 1536x128.
 */
export function placementSizeForFrame(
  frame: WidgetFrame,
  canvas: { width: number; height: number },
): { width: number; height: number } {
  const aspect = frame.width / frame.height;
  const area = canvas.width * 0.4 * (canvas.height * 0.4);
  let width = Math.sqrt(area * aspect);
  let height = width / aspect;
  const shrink = Math.min(
    1,
    (canvas.width * 0.8) / width,
    (canvas.height * 0.8) / height,
  );
  width *= shrink;
  height *= shrink;
  // The layout editor never draws a placement smaller than 16 pixels.
  return {
    width: Math.max(16, Math.round(width)),
    height: Math.max(16, Math.round(height)),
  };
}
