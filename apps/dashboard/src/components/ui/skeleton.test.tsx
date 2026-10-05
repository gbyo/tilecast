// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { Skeleton } from "./skeleton";

afterEach(cleanup);

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

describe("Skeleton reduced motion", () => {
  it("pulses by default and opts out for the system preference", () => {
    const { container } = render(<Skeleton />);
    const skeleton = container.firstElementChild!;
    expect(skeleton).toHaveAttribute("data-slot", "skeleton");
    expect(skeleton).toHaveClass("animate-pulse", "motion-reduce:animate-none");
  });

  it("stops the pulse outright for Tilecast's own preference", () => {
    // The blanket 0.01ms duration override would leave an infinite pulse
    // strobing, so the skeleton needs no animation at all.
    const css = read("../../styles.css");
    expect(css).toMatch(
      /html\[data-reduced-motion="true"\] \[data-slot="skeleton"\]\s*\{\s*animation:\s*none;/,
    );
  });
});

describe("load reveal styles", () => {
  const css = read("../../styles/load-reveal.css");

  it("moves only opacity and a few pixels of vertical travel", () => {
    expect(css).toContain("--load-reveal-shift: 3px");
    expect(css).toContain("--load-reveal-shift: 5px");
    expect(css).not.toMatch(/scale|blur|box-shadow|gradient|will-change/);
    expect(css).not.toMatch(/translate(X|3d)/);
  });

  it("uses the shared motion tokens, the recap one slower", () => {
    expect(css).toContain("var(--tc-motion-standard)");
    expect(css).toContain("var(--tc-motion-slow)");
    expect(css).toContain("var(--tc-motion-fast)");
    expect(css).toContain("var(--tc-ease-standard)");
  });

  it("removes the animation for both reduced-motion preferences", () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\[data-load-reveal\]\s*\{\s*animation:\s*none;/,
    );
    expect(css).toMatch(
      /html\[data-reduced-motion="true"\] \[data-load-reveal\]\s*\{\s*animation:\s*none;/,
    );
  });
});
