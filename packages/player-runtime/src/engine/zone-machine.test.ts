import { createActor } from "xstate";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock/scheduler";
import type { RuntimeLayoutZonePlaylistItem } from "../host/contract";
import { zoneMachine, ZONE_IMAGE_DEFAULT_MS } from "./zone-machine";

function item(
  id: string,
  kind: "image" | "video" = "image",
  durationMs: number | null = 100,
): RuntimeLayoutZonePlaylistItem {
  return {
    id,
    kind,
    src: `tcmedia://${id}`,
    durationMs,
    fit: "contain",
    muted: true,
    volume: 0,
    loop: false,
  };
}

function actorFor(items: RuntimeLayoutZonePlaylistItem[], clock: ManualClock) {
  return createActor(zoneMachine, {
    input: { items, clock, onAdvance() {} },
  });
}

describe("Layout playlist-zone timing", () => {
  it("uses the explicit image duration", () => {
    const clock = new ManualClock({ wallMs: 0 });
    const actor = actorFor([item("image", "image", 250), item("next")], clock);
    actor.start();
    clock.advance(249);
    expect(actor.getSnapshot().context.shown).toBe(1);
    clock.advance(1);
    expect(actor.getSnapshot().context.shown).toBe(2);
    actor.stop();
  });

  it("uses the shared default for an image without an item duration", () => {
    const clock = new ManualClock({ wallMs: 0 });
    const actor = actorFor([item("image", "image", null), item("next")], clock);
    actor.start();
    clock.advance(ZONE_IMAGE_DEFAULT_MS - 1);
    expect(actor.getSnapshot().context.shown).toBe(1);
    clock.advance(1);
    expect(actor.getSnapshot().context.shown).toBe(2);
    actor.stop();
  });

  it("waits for video end events rather than applying image timers", () => {
    const clock = new ManualClock({ wallMs: 0 });
    const actor = actorFor([item("clip", "video", 400), item("next")], clock);
    actor.start();
    clock.advance(ZONE_IMAGE_DEFAULT_MS * 2);
    expect(actor.getSnapshot().context.shown).toBe(1);
    actor.send({ type: "MEDIA_ENDED", shown: 1 });
    expect(actor.getSnapshot().context.shown).toBe(2);
    actor.stop();
  });
});
