import type { TFunction } from "i18next";

type CaptureT = TFunction<"content"> | undefined;

const WIDGET_SNAPSHOT_WIDTH = 960;
const WIDGET_SNAPSHOT_HEIGHT = 540;

/**
 * The one canonical library thumbnail frame. Saved Widget artwork is always
 * rendered AT this geometry — never a stretched, cropped, or letterboxed
 * reinterpretation of whatever preview size the author had selected.
 */
export const WIDGET_THUMBNAIL_FRAME = {
  width: WIDGET_SNAPSHOT_WIDTH,
  height: WIDGET_SNAPSHOT_HEIGHT,
} as const;

// Persisted alongside stored Widget previews. Bump this whenever the capture
// representation changes in a way that requires existing thumbnails to be
// regenerated. Keep in sync with WidgetPreviewCaptureVersion in
// apps/server/internal/media/widgets.go.
export const WIDGET_PREVIEW_CAPTURE_VERSION = 4;

// The current Layout thumbnail pipeline: lifecycle-aware capture that waits
// for embedded V2 Widgets to settle. Persisted beside each stored Layout
// preview; a missing or older version counts as stale. Keep in sync with
// LayoutPreviewCaptureVersion in apps/server/internal/layouts/service.go.
export const LAYOUT_PREVIEW_CAPTURE_VERSION = 1;

function blobToDataURL(blob: Blob, t: CaptureT) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else
        reject(
          new Error(
            t?.("preview.capture.encodeFailed") ??
              "Image could not be encoded.",
          ),
        );
    };
    reader.onerror = () =>
      reject(
        reader.error ??
          new Error(
            t?.("preview.capture.readFailed") ?? "Image could not be read.",
          ),
      );
    reader.readAsDataURL(blob);
  });
}

type CapturedImage = {
  source: HTMLImageElement;
  clone: HTMLImageElement;
};

async function inlineImages(images: CapturedImage[], t: CaptureT) {
  await Promise.all(
    images.map(async ({ source, clone }) => {
      const sourceURL = source.currentSrc || source.src;
      if (!sourceURL || sourceURL.startsWith("data:")) return;
      try {
        const response = await fetch(sourceURL, {
          credentials: "same-origin",
        });
        if (!response.ok) {
          clone.remove();
          return;
        }
        clone.src = await blobToDataURL(await response.blob(), t);
      } catch {
        clone.remove();
      }
    }),
  );
}

function inlineComputedStyle(source: Element, clone: Element) {
  const style = getComputedStyle(source);
  const target = (clone as HTMLElement | SVGElement).style;
  if (!target) return;
  for (const property of style)
    target.setProperty(
      property,
      style.getPropertyValue(property),
      style.getPropertyPriority(property),
    );
}

/**
 * Read the resolved string of a generated box, or null when there is no
 * visible box. `none` and `normal` generate nothing; anything that is not a
 * quoted string (a url(), an image, an unresolved counter) is skipped
 * rather than trusted as markup.
 */
function pseudoTextContent(style: CSSStyleDeclaration): string | null {
  const content = style.getPropertyValue("content");
  if (!content || content === "none" || content === "normal") return null;
  const quote = content[0];
  if (
    content.length < 2 ||
    (quote !== '"' && quote !== "'") ||
    !content.endsWith(quote)
  )
    return null;
  return content.slice(1, -1).replace(/\\(.)/g, "$1");
}

/**
 * Generated ::before/::after boxes have no DOM node for cloneNode to copy,
 * so Widgets that draw through them (Timeline's line and dots) lose those
 * pixels in thumbnails. Synthesize a real element carrying the resolved
 * text content and the pseudo box's computed style, so positioning,
 * dimensions, backgrounds, borders, transforms, and opacity survive the
 * capture. Only string content is reproduced, as a text node — generated
 * content is never executed or parsed as markup.
 */
function clonePseudoElement(
  source: Element,
  pseudo: "::before" | "::after",
): Element | null {
  const style = getComputedStyle(source, pseudo);
  const text = pseudoTextContent(style);
  if (text == null) return null;
  const surrogate = document.createElement("span");
  surrogate.setAttribute("data-tc-captured-pseudo", pseudo);
  if (text) surrogate.textContent = text;
  const target = surrogate.style;
  for (const property of style) {
    if (property === "content") continue;
    target.setProperty(
      property,
      style.getPropertyValue(property),
      style.getPropertyPriority(property),
    );
  }
  return surrogate;
}

/**
 * Build the tree the browser is actually painting rather than merely cloning
 * the light DOM. Widgets V2 render inside open Shadow DOM with adopted
 * stylesheets; neither ShadowRoots nor their constructed stylesheets survive
 * cloneNode/XMLSerializer. Flattening the composed tree and copying computed
 * styles gives the foreignObject a self-contained representation of the same
 * pixels without introducing a second Widget renderer.
 */
function cloneRenderedNode(source: Node, images: CapturedImage[]): Node {
  if (!(source instanceof Element)) return source.cloneNode(true);

  const clone = source.cloneNode(false) as Element;
  inlineComputedStyle(source, clone);
  // The Layout editor draws selection handles and an outline with pseudo
  // elements. Do not synthesize those editor-only boxes into the saved image.
  const selectedPlacement =
    source.classList.contains("layout-placement") &&
    source.classList.contains("is-selected");
  if (source instanceof HTMLImageElement && clone instanceof HTMLImageElement)
    images.push({ source, clone });

  const before = selectedPlacement
    ? null
    : clonePseudoElement(source, "::before");
  if (before) clone.appendChild(before);
  let children: Node[];
  if (source instanceof HTMLSlotElement) {
    const assigned = source.assignedNodes({ flatten: true });
    children = assigned.length ? assigned : Array.from(source.childNodes);
  } else if (source.shadowRoot) {
    children = Array.from(source.shadowRoot.childNodes);
  } else {
    children = Array.from(source.childNodes);
  }
  for (const child of children)
    clone.appendChild(cloneRenderedNode(child, images));
  const after = selectedPlacement
    ? null
    : clonePseudoElement(source, "::after");
  if (after) clone.appendChild(after);
  return clone;
}

function loadImage(url: string, t: CaptureT) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(
        new Error(
          t?.("preview.capture.rasterFailed") ??
            "Preview could not be rasterized.",
        ),
      );
    image.src = url;
  });
}

function encodeJPEG(canvas: HTMLCanvasElement, quality: number, t: CaptureT) {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(
              new Error(
                t?.("preview.capture.createFailed") ??
                  "Preview image could not be created.",
              ),
            ),
      "image/jpeg",
      quality,
    ),
  );
}

/**
 * The neutral surface behind a Widget that is fitted into the canonical
 * thumbnail frame without filling it. Not the Widget's own color: a strip
 * with a colored background should read as a strip, not as a wall of color.
 */
export const THUMBNAIL_STAGE_COLOR = "#18181b";

/**
 * Where a rendered frame lands inside the snapshot. A frame whose shape
 * matches the snapshot fills it; any other shape is scaled to fit entirely
 * inside it and centered, so nothing is stretched or cropped.
 */
export function thumbnailPlacement(
  frame: { width: number; height: number },
  snapshot: { width: number; height: number },
) {
  const scale = Math.min(
    snapshot.width / frame.width,
    snapshot.height / frame.height,
  );
  const width = Math.round(frame.width * scale);
  const height = Math.round(frame.height * scale);
  const fills =
    Math.abs(width - snapshot.width) <= 1 &&
    Math.abs(height - snapshot.height) <= 1;
  if (fills) return { x: 0, y: 0, ...snapshot, fills: true as const };
  return {
    x: Math.round((snapshot.width - width) / 2),
    y: Math.round((snapshot.height - height) / 2),
    width,
    height,
    fills: false as const,
  };
}

async function captureRenderPreview(
  element: HTMLElement,
  snapshotWidth: number,
  snapshotHeight: number,
  exclude: string[] = [],
  t: CaptureT,
  /** Fit the element inside the snapshot instead of stretching it to fill. */
  fitInside = false,
): Promise<Blob> {
  await document.fonts.ready;
  const bounds = element.getBoundingClientRect();
  if (bounds.width < 1 || bounds.height < 1)
    throw new Error(
      t?.("preview.capture.notReady") ?? "Preview is not ready yet.",
    );
  // Chrome clips foreignObject content to whole user units, so a fractional
  // on-screen size leaves the last row/column of the raster transparent and the
  // canvas fill bleeds through as a border along the right and bottom edges.
  const frameWidth = Math.ceil(bounds.width);
  const frameHeight = Math.ceil(bounds.height);
  const background = getComputedStyle(element).backgroundColor;
  const images: CapturedImage[] = [];
  const clone = cloneRenderedNode(element, images) as HTMLElement;
  await inlineImages(images, t);
  exclude.forEach((selector) =>
    clone.querySelectorAll(selector).forEach((child) => child.remove()),
  );
  clone
    .querySelectorAll(".is-selected")
    .forEach((child) => child.classList.remove("is-selected"));
  clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  clone.style.width = `${frameWidth}px`;
  clone.style.height = `${frameHeight}px`;
  clone.style.border = "0";
  clone.style.borderRadius = "0";
  const markup = new XMLSerializer().serializeToString(clone);
  const placement = fitInside
    ? thumbnailPlacement(
        { width: frameWidth, height: frameHeight },
        { width: snapshotWidth, height: snapshotHeight },
      )
    : {
        x: 0,
        y: 0,
        width: snapshotWidth,
        height: snapshotHeight,
        fills: true as const,
      };
  // `preserveAspectRatio="none"` keeps the frame mapped edge to edge onto the
  // area it is drawn into. Rounding up above shifts the aspect ratio by well
  // under a pixel, so nothing visibly stretches, but letterbox bars can no
  // longer appear.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${placement.width}" height="${placement.height}" viewBox="0 0 ${frameWidth} ${frameHeight}" preserveAspectRatio="none"><foreignObject width="${frameWidth}" height="${frameHeight}">${markup}</foreignObject></svg>`;
  // Dashboard CSP intentionally excludes blob: images. An encoded data URL is
  // already permitted and keeps this temporary SVG local to the browser.
  const image = await loadImage(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    t,
  );
  const canvas = document.createElement("canvas");
  canvas.width = snapshotWidth;
  canvas.height = snapshotHeight;
  const context = canvas.getContext("2d");
  if (!context)
    throw new Error(
      t?.("preview.capture.noCanvas") ?? "Preview canvas is unavailable.",
    );
  context.fillStyle = placement.fills
    ? background || "#000"
    : THUMBNAIL_STAGE_COLOR;
  context.fillRect(0, 0, snapshotWidth, snapshotHeight);
  context.drawImage(
    image,
    placement.x,
    placement.y,
    placement.width,
    placement.height,
  );
  for (const quality of [0.82, 0.68, 0.52]) {
    const snapshot = await encodeJPEG(canvas, quality, t);
    if (snapshot.size <= 500 * 1024) return snapshot;
  }
  throw new Error(
    t?.("preview.capture.tooDetailed") ??
      "Preview image is too detailed to store.",
  );
}

/**
 * Capture a Widget that was rendered at `renderFrame` into the canonical
 * library thumbnail. The output is always the canonical size; a Widget whose
 * natural geometry has another shape is fitted inside it, centered on a
 * neutral stage, rather than rendered at the canonical frame or stretched.
 */
export function captureWidgetPreview(
  element: HTMLElement,
  t?: TFunction<"content">,
  renderFrame?: { width: number; height: number },
): Promise<Blob> {
  const fitInside =
    renderFrame !== undefined &&
    !thumbnailPlacement(renderFrame, WIDGET_THUMBNAIL_FRAME).fills;
  return captureRenderPreview(
    element,
    WIDGET_SNAPSHOT_WIDTH,
    WIDGET_SNAPSHOT_HEIGHT,
    [],
    t,
    fitInside,
  );
}

export function captureLayoutPreview(
  element: HTMLElement,
  canvasWidth: number,
  canvasHeight: number,
  t?: TFunction<"content">,
): Promise<Blob> {
  const scale = 960 / Math.max(canvasWidth, canvasHeight);
  return captureRenderPreview(
    element,
    Math.max(1, Math.round(canvasWidth * scale)),
    Math.max(1, Math.round(canvasHeight * scale)),
    [".layout-safe-area", ".layout-guide", ".layout-resize-handle"],
    t,
  );
}
