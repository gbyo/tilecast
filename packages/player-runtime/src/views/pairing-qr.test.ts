import { describe, expect, it } from "vitest";
import { PAIRING_QR_QUIET_ZONE, pairingQrDataUri } from "./pairing-qr";

const APPROVAL_URL =
  "https://signage.example.org/screens/pair/K7Q2XD?installation=8c7d4a52-6a1e-4c1a-9f2b-2f6f0e6d7a10";

function svgOf(dataUri: string): string {
  expect(dataUri.startsWith("data:image/svg+xml;utf8,")).toBe(true);
  return decodeURIComponent(dataUri.slice("data:image/svg+xml;utf8,".length));
}

describe("pairingQrDataUri", () => {
  it("encodes the approval URL as a crisp dark-on-light SVG", () => {
    const svg = svgOf(pairingQrDataUri(APPROVAL_URL));
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain('fill="#FFFFFF"');
    expect(svg).toContain('fill="#000000"');
    // Square modules only: no rounded rects or circles.
    expect(svg).not.toContain("<rect x=");
    expect(svg).not.toContain("<circle");
    expect(svg).not.toMatch(/rx=|ry=|\.5h/);
  });

  it("keeps a four-module quiet zone on every side", () => {
    const svg = svgOf(pairingQrDataUri(APPROVAL_URL));
    const viewBox = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
    expect(viewBox).not.toBeNull();
    const size = Number(viewBox![1]);
    const path = svg.match(/<path d="([^"]*)"/)?.[1];
    expect(path).toBeDefined();
    if (!path) throw new Error("expected QR SVG path");
    const coordinates = [...path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map(
      ([, x, y]) => [Number(x), Number(y)] as const,
    );
    expect(coordinates.length).toBeGreaterThan(0);
    for (const [x, y] of coordinates) {
      expect(x).toBeGreaterThanOrEqual(PAIRING_QR_QUIET_ZONE);
      expect(y).toBeGreaterThanOrEqual(PAIRING_QR_QUIET_ZONE);
      expect(x + 1).toBeLessThanOrEqual(size - PAIRING_QR_QUIET_ZONE);
      expect(y + 1).toBeLessThanOrEqual(size - PAIRING_QR_QUIET_ZONE);
    }
  });

  it("returns an empty string for an empty value", () => {
    expect(pairingQrDataUri("")).toBe("");
  });

  it("bounds an overlong value", () => {
    const bounded = pairingQrDataUri(
      `https://signage.example.org/${"a".repeat(5000)}`,
    );
    expect(bounded).not.toBe("");
    expect(svgOf(bounded)).toContain("<svg");
  });
});
