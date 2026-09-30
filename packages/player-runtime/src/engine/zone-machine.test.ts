import { createActor } from "xstate";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock/scheduler";
import type { RuntimeLayoutZonePlaylistItem } from "../host/contract";
import { zoneMachine } from "./zone-machine";

function image(
  id: string,
  durationMs: number | null,
): RuntimeLayoutZonePlaylistItem {
  return {
    id,
    kind: "image",
    src: `tcmedia://cap/${id}`,
    durationMs,
    fit: "contain",
    muted: true,
    volume: 0,
    loop: false,
  };
}

function harness(items: RuntimeLayoutZonePlaylistItem[]) {
  const clock = new ManualClock({ wallMs: Date.UTC(2026, 8, 1) });
  let advances = 0;
  const actor = createActor(zoneMachine, {
    input: { items, clock, onAdvance: () => (advances += 1) },
  });
  actor.start();
  return { clock, advances: () => advances };
}

describe("zone machine durations", () => {
  it("reads a zero duration as unset instead of swapping at timer speed", () => {
    const h = harness([image("a", 0), image("b", 0)]);
    h.clock.advance(9_999);
    expect(h.advances()).toBe(1);
    h.clock.advance(1);
    expect(h.advances()).toBe(2);
  });

  it("never swaps an image sooner than the dwell floor", () => {
    const h = harness([image("a", 1), image("b", 1)]);
    h.clock.advance(999);
    expect(h.advances()).toBe(1);
    h.clock.advance(1);
    expect(h.advances()).toBe(2);
  });
});
