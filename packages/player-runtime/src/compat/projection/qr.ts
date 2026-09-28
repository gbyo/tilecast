/**
 * QR generation (runtime side).
 *
 * QR codes are encoded in the runtime and passed to the renderer as a
 * self-contained SVG data URI, keeping the renderer dependency-free and the
 * QR crisp at any zone size (vector, no raster memory). Synchronous so it
 * slots into the render-tree projection.
 */

import qrcode from "qrcode-generator";

const ECC: Record<string, "L" | "M" | "Q" | "H"> = {
  low: "L",
  medium: "M",
  quartile: "Q",
  high: "H",
};

export function qrDataUri(
  value: string,
  foreground = "#000000",
  background = "#FFFFFF",
  errorCorrection = "medium",
): string {
  const text = value.slice(0, 2048);
  if (text.length === 0) {
    return "";
  }
  const qr = qrcode(0, ECC[errorCorrection] ?? "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const cells: string[] = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        cells.push(`M${col} ${row}h1v1h-1z`);
      }
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${count} ${count}" shape-rendering="crispEdges">` +
    `<rect width="${count}" height="${count}" fill="${background}"/>` +
    `<path d="${cells.join("")}" fill="${foreground}"/>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
