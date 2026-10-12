// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { swapLayers } from "./crossfade";

function layer(visible: boolean): HTMLDivElement {
  const el = document.createElement("div");
  if (visible) el.classList.add("visible");
  return el;
}

function fakeAnimation() {
  let resolve!: () => void;
  const finished = new Promise<void>((r) => (resolve = r));
  return { finished, cancel: vi.fn(), finish: resolve };
}

describe("swapLayers", () => {
  it("keeps the outgoing layer opaque under the incoming fade until it ends", async () => {
    const incoming = layer(false);
    const outgoing = layer(true);
    const fade = fakeAnimation();
    const animate = vi.fn(() => fade);
    incoming.animate = animate as unknown as typeof incoming.animate;
    outgoing.animate = vi.fn() as unknown as typeof outgoing.animate;

    const running = swapLayers(incoming, outgoing, "crossfade", {
      durationScale: 1,
    });

    // Only the incoming layer animates; fading both exposes the black
    // backdrops and dips the picture dark mid-transition.
    expect(animate).toHaveBeenCalledOnce();
    expect(outgoing.animate).not.toHaveBeenCalled();
    expect(incoming.classList.contains("visible")).toBe(true);
    expect(outgoing.classList.contains("visible")).toBe(true);
    expect(Number(incoming.style.zIndex)).toBeGreaterThan(
      Number(outgoing.style.zIndex),
    );

    fade.finish();
    await expect(running.finished).resolves.toBe("finished");
    expect(outgoing.classList.contains("visible")).toBe(false);
    expect(incoming.classList.contains("visible")).toBe(true);
  });

  it("settles both layers at once when cancelled", async () => {
    const incoming = layer(false);
    const outgoing = layer(true);
    incoming.animate = vi.fn(() =>
      fakeAnimation(),
    ) as unknown as typeof incoming.animate;

    const running = swapLayers(incoming, outgoing, "fade", {
      durationScale: 1,
    });
    running.cancel();

    await expect(running.finished).resolves.toBe("cancelled");
    expect(outgoing.classList.contains("visible")).toBe(false);
    expect(incoming.classList.contains("visible")).toBe(true);
  });

  it("cuts without animating", async () => {
    const incoming = layer(false);
    const outgoing = layer(true);
    const animate = vi.fn();
    incoming.animate = animate as unknown as typeof incoming.animate;

    const running = swapLayers(incoming, outgoing, "none", {
      durationScale: 1,
    });

    await expect(running.finished).resolves.toBe("finished");
    expect(animate).not.toHaveBeenCalled();
    expect(outgoing.classList.contains("visible")).toBe(false);
    expect(incoming.classList.contains("visible")).toBe(true);
  });
});
