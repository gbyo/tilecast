import { createActor } from "xstate";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock/scheduler";
import type { RuntimeLayoutZonePlaylistItem } from "../host/contract";
import { zoneEntry, zoneMachine, ZONE_RETRY_MS } from "./zone-machine";

function item(
  id: string,
  kind: "image" | "video" = "image",
): RuntimeLayoutZonePlaylistItem {
  return {
    id,
    kind,
    src: `tcmedia://${id}`,
    durationMs: 100,
    fit: "contain",
    muted: true,
    volume: 0,
    loop: false,
    transition: "none",
  };
}

describe("layout playlist-zone playback", () => {
  it("times images but waits for media completion on videos with a duration", () => {
    const clock = new ManualClock({ wallMs: 0 });
    const actor = createActor(zoneMachine, {
      input: {
        items: [item("first"), item("clip", "video")],
        loop: true,
        clock,
        onAdvance() {},
      },
    });
    actor.start();
    clock.advance(100);
    expect(zoneEntry(actor.getSnapshot().context)?.entry.id).toBe("clip");
    clock.advance(100_000);
    expect(zoneEntry(actor.getSnapshot().context)?.entry.id).toBe("clip");
    actor.send({
      type: "MEDIA_ENDED",
      epoch: actor.getSnapshot().context.epoch,
    });
    expect(zoneEntry(actor.getSnapshot().context)?.entry.id).toBe("first");
    actor.stop();
  });
  it("stops on the last item when the zone loop is off", () => {
    const clock = new ManualClock({ wallMs: 0 });
    const actor = createActor(zoneMachine, {
      input: {
        items: [item("first"), item("last")],
        loop: false,
        clock,
        onAdvance() {},
      },
    });
    actor.start();
    actor.send({
      type: "MEDIA_ENDED",
      epoch: actor.getSnapshot().context.epoch,
    });
    expect(actor.getSnapshot().context.shown).toBe(2);
    clock.advance(100);
    expect(actor.getSnapshot().context.shown).toBe(2);
    actor.stop();
  });

  it("continues from the final item when the zone loop is on", () => {
    const clock = new ManualClock({ wallMs: 0 });
    const actor = createActor(zoneMachine, {
      input: {
        items: [item("first"), item("last")],
        loop: true,
        clock,
        onAdvance() {},
      },
    });
    actor.start();
    actor.send({
      type: "MEDIA_ENDED",
      epoch: actor.getSnapshot().context.epoch,
    });
    actor.send({
      type: "MEDIA_ENDED",
      epoch: actor.getSnapshot().context.epoch,
    });
    expect(actor.getSnapshot().context.shown).toBe(3);
    expect(zoneEntry(actor.getSnapshot().context)?.entry.id).toBe("first");
    actor.stop();
  });

  it("retries a failed terminal item without advancing to the beginning", () => {
    const clock = new ManualClock({ wallMs: 0 });
    const actor = createActor(zoneMachine, {
      input: {
        items: [item("first"), item("last")],
        loop: false,
        clock,
        onAdvance() {},
      },
    });
    actor.start();
    actor.send({
      type: "MEDIA_ENDED",
      epoch: actor.getSnapshot().context.epoch,
    });
    const beforeRetry = actor.getSnapshot().context.epoch;
    actor.send({ type: "MEDIA_FAILED", epoch: beforeRetry });
    clock.advance(ZONE_RETRY_MS);
    expect(actor.getSnapshot().context.shown).toBe(2);
    expect(actor.getSnapshot().context.epoch).toBe(beforeRetry + 1);
    actor.stop();
  });

  it("uses the zone loop policy for a single video", () => {
    const video = item("clip", "video");
    expect(zoneEntry({ items: [video], shown: 1, loop: false })?.loop).toBe(
      false,
    );
    expect(zoneEntry({ items: [video], shown: 1, loop: true })?.loop).toBe(
      true,
    );
  });
});
