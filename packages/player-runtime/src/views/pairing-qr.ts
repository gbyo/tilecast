/**
 * QR generation for the pairing surface.
 *
 * The pairing surface renders the approval URL as a self-contained SVG data
 * URI: vector, so it stays crisp at any display size. The quiet zone is
 * baked into the SVG (four modules on every side), the modules are square
 * with no rounding, and the code is dark on light for contrast. It shares
 * only the underlying encoder package with the QR widget, used
 * independently here.
 */

import qrcode from "qrcode-generator";

/** Modules of quiet zone on every side, per the QR specification. */
export const PAIRING_QR_QUIET_ZONE = 4;

export function pairingQrDataUri(value: string): string {
  const text = value.slice(0, 2048);
  if (text.length === 0) {
    return "";
  }
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const size = count + PAIRING_QR_QUIET_ZONE * 2;
  const cells: string[] = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        const x = col + PAIRING_QR_QUIET_ZONE;
        const y = row + PAIRING_QR_QUIET_ZONE;
        cells.push(`M${x} ${y}h1v1h-1z`);
      }
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#FFFFFF"/>` +
    `<path d="${cells.join("")}" fill="#000000"/>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
