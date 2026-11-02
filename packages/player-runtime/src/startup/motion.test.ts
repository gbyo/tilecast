import { describe, expect, it } from "vitest";
import {
  coversViewport,
  planCardMotion,
  project,
  tilePolygon,
  transformOf,
  type CardGeometry,
} from "./motion";

/** The card box runtime.css lays out for this viewport. */
function geometry(width: number, height: number): CardGeometry {
  const logoWidth = Math.min(560, 0.3 * width);
  const logoHeight = (logoWidth * 295.25) / 1207.43;
  const card = {
    left: (width - logoWidth) / 2 + (logoWidth * 99.36) / 1207.43,
    top: (height - logoHeight) / 2 + (logoHeight * 92.42) / 295.25,
    width: (logoWidth * 184.13) / 1207.43,
    height: (logoHeight * 178.83) / 295.25,
  };
  return { viewport: { width, height }, card, polygon: tilePolygon(card) };
}

const VIEWPORTS: [number, number][] = [
  [1920, 1080],
  [1280, 720],
  [3840, 2160],
  [1080, 1920],
  [1024, 768],
];

describe("startup card motion", () => {
  for (const [width, height] of VIEWPORTS) {
    describe(`${width}x${height}`, () => {
      const g = geometry(width, height);
      const plan = planCardMotion(g);
      const first = plan.samples[0]!;
      const last = plan.samples.at(-1)!;

      it("starts exactly where the logo draws the front tile", () => {
        expect(first).toMatchObject({ dx: 0, dy: 0, z: 0, shade: 0 });
        expect(Math.abs(first.rotateX) + Math.abs(first.rotateY)).toBe(0);
        for (const point of g.polygon) {
          const screen = project(g, plan, first, point)!;
          expect(screen.x).toBeCloseTo(g.card.left + point.x, 6);
          expect(screen.y).toBeCloseTo(g.card.top + point.y, 6);
        }
      });

      it("ends square to the camera, unshaded, covering every pixel", () => {
        expect(last.rotateX).toBe(0);
        expect(last.rotateY).toBe(0);
        expect(last.shade).toBe(0);
        expect(coversViewport(g, plan, last)).toBe(true);
      });

      it("never puts any part of the card behind the camera", () => {
        for (const sample of plan.samples) {
          for (const point of g.polygon) {
            expect(project(g, plan, sample, point)).not.toBeNull();
          }
        }
      });

      it("keeps approaching and only covers the screen at the end", () => {
        const depths = plan.samples.map((sample) => sample.z);
        for (let i = 1; i < depths.length; i++) {
          expect(depths[i]!).toBeGreaterThan(depths[i - 1]!);
        }
        const firstCover = plan.samples.findIndex((sample) =>
          coversViewport(g, plan, sample),
        );
        expect(plan.samples[firstCover]!.offset).toBeGreaterThan(0.85);
      });

      it("tilts enough to show depth, never like a page flip", () => {
        const peakY = Math.max(...plan.samples.map((s) => Math.abs(s.rotateY)));
        const peakX = Math.max(...plan.samples.map((s) => Math.abs(s.rotateX)));
        expect(peakY).toBeGreaterThan(8);
        expect(peakY).toBeLessThanOrEqual(11);
        expect(peakX).toBeLessThanOrEqual(5);
      });

      it("brings one side toward the viewer before the other", () => {
        // Mid-push, the near (right) edge is drawn taller than the far one.
        const middle = plan.samples.find((s) => s.offset >= 0.7)!;
        const edge = (a: number, b: number) => {
          const p = project(g, plan, middle, g.polygon[a]!)!;
          const q = project(g, plan, middle, g.polygon[b]!)!;
          return Math.hypot(p.x - q.x, p.y - q.y);
        };
        const left = edge(7, 0);
        const right = edge(3, 4);
        const leftRest = g.polygon[7]!.y - g.polygon[0]!.y;
        const rightRest = g.polygon[4]!.y - g.polygon[3]!.y;
        expect(right / rightRest / (left / leftRest)).toBeGreaterThan(1.04);
      });
    });
  }

  it("writes transforms the compositor can interpolate function by function", () => {
    const plan = planCardMotion(geometry(1920, 1080));
    for (const sample of plan.samples) {
      expect(transformOf(sample)).toMatch(
        /^translate3d\(-?[\d.]+px, -?[\d.]+px, -?[\d.]+px\) rotateX\(-?[\d.]+deg\) rotateY\(-?[\d.]+deg\)$/,
      );
    }
  });
});
