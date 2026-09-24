import type { TFunction } from "i18next";

type CaptureT = TFunction<"content"> | undefined;

const WIDGET_SNAPSHOT_WIDTH = 960;
const WIDGET_SNAPSHOT_HEIGHT = 540;

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

async function inlineImages(
  source: HTMLElement,
  clone: HTMLElement,
  t: CaptureT,
) {
  const originals = Array.from(source.querySelectorAll("img"));
  const copies = Array.from(clone.querySelectorAll("img"));
  await Promise.all(
    originals.map(async (image, index) => {
      const copy = copies[index];
      const sourceURL = image.currentSrc || image.src;
      if (!copy || !sourceURL || sourceURL.startsWith("data:")) return;
      try {
        const response = await fetch(sourceURL, {
          credentials: "same-origin",
        });
        if (response.ok)
          copy.src = await blobToDataURL(await response.blob(), t);
      } catch {
        copy.remove();
      }
    }),
  );
}

function inlineComputedStyles(source: Element, clone: Element) {
  const style = getComputedStyle(source);
  const target = (clone as HTMLElement).style;
  for (const property of style)
    target.setProperty(
      property,
      style.getPropertyValue(property),
      style.getPropertyPriority(property),
    );
  const sourceChildren = Array.from(source.children);
  const cloneChildren = Array.from(clone.children);
  sourceChildren.forEach((child, index) => {
    const copy = cloneChildren[index];
    if (copy) inlineComputedStyles(child, copy);
  });
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

async function captureRenderPreview(
  element: HTMLElement,
  snapshotWidth: number,
  snapshotHeight: number,
  exclude: string[] = [],
  t: CaptureT,
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
  const clone = element.cloneNode(true) as HTMLElement;
  inlineComputedStyles(element, clone);
  await inlineImages(element, clone, t);
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
  // `preserveAspectRatio="none"` keeps the frame mapped edge to edge onto the
  // snapshot. Rounding up above shifts the aspect ratio by well under a pixel,
  // so nothing visibly stretches, but letterbox bars can no longer appear.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${snapshotWidth}" height="${snapshotHeight}" viewBox="0 0 ${frameWidth} ${frameHeight}" preserveAspectRatio="none"><foreignObject width="${frameWidth}" height="${frameHeight}">${markup}</foreignObject></svg>`;
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
  context.fillStyle = background || "#000";
  context.fillRect(0, 0, snapshotWidth, snapshotHeight);
  context.drawImage(image, 0, 0, snapshotWidth, snapshotHeight);
  for (const quality of [0.82, 0.68, 0.52]) {
    const snapshot = await encodeJPEG(canvas, quality, t);
    if (snapshot.size <= 500 * 1024) return snapshot;
  }
  throw new Error(
    t?.("preview.capture.tooDetailed") ??
      "Preview image is too detailed to store.",
  );
}

export function captureWidgetPreview(
  element: HTMLElement,
  t?: TFunction<"content">,
): Promise<Blob> {
  return captureRenderPreview(
    element,
    WIDGET_SNAPSHOT_WIDTH,
    WIDGET_SNAPSHOT_HEIGHT,
    [],
    t,
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
