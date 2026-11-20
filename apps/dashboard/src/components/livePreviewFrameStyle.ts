import type { CSSProperties } from "react";

/**
 * Give previews their real aspect ratio while limiting their height to a
 * fraction of the viewport. The width is capped by the parent, so a portrait
 * stream does not create an excessively tall dialog or crop the image.
 */
export function livePreviewFrameStyle(
  width?: number | null,
  height?: number | null,
  maxViewportHeight = 70,
): CSSProperties {
  const valid =
    typeof width === "number" &&
    Number.isFinite(width) &&
    width > 0 &&
    typeof height === "number" &&
    Number.isFinite(height) &&
    height > 0;
  const frameWidth = valid ? width : 16;
  const frameHeight = valid ? height : 9;
  const viewportWidth =
    Math.round((frameWidth / frameHeight) * maxViewportHeight * 100) / 100;

  return {
    aspectRatio: `${frameWidth} / ${frameHeight}`,
    width: `min(100%, ${viewportWidth}dvh)`,
  };
}
