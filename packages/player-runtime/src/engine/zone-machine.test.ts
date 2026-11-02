import { createActor } from "xstate";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock/scheduler";
import type { RuntimeLayoutZonePlaylistItem } from "../host/contract";
import {
  zoneEntry,
  zoneMachine,
  zoneOwesContinuingEvidence,
  ZONE_RETRY_MS,
} from "./zone-machine";
import fixtures from "../../../presentation-model/fixtures/zone-policy.json";

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
  it("uses the shared Widget duration fallback for an unset timed occurrence", () => {
    const clock = new ManualClock({ wallMs: 0 });
    const actor = createActor(zoneMachine, {
      input: {
        items: [
          { id: "widget", kind: "widget", durationMs: null },
          item("next"),
        ],
        clock,
        onReady() {},
      },
    });
    actor.start();
    actor.send({
      type: "MEDIA_READY",
      epoch: actor.getSnapshot().context.epoch,
    });
    clock.advance(29_999);
    expect(actor.getSnapshot().context.shown).toBe(1);
    clock.advance(1);
    expect(actor.getSnapshot().context.shown).toBe(2);
    actor.stop();
  });
  it("backs off when a loop of Widgets all fail instead of spinning mounts", () => {
    const clock = new ManualClock({ wallMs: 0 });
    const actor = createActor(zoneMachine, {
      input: {
        items: [
          { id: "a", kind: "widget", durationMs: 100 },
          { id: "b", kind: "widget", durationMs: 100 },
        ],
        clock,
        onReady() {},
      },
    });
    actor.start();
    actor.send({
      type: "MEDIA_FAILED",
      epoch: actor.getSnapshot().context.epoch,
    });
    actor.send({
      type: "MEDIA_FAILED",
      epoch: actor.getSnapshot().context.epoch,
    });
    expect(actor.getSnapshot().context.shown).toBe(2);
    const epoch = actor.getSnapshot().context.epoch;
    clock.advance(ZONE_RETRY_MS - 1);
    expect(actor.getSnapshot().context.epoch).toBe(epoch);
    clock.advance(1);
    expect(actor.getSnapshot().context.epoch).toBe(epoch + 1);
    actor.stop();
    expect(clock.pendingTimers).toBe(0);
  });
  it("times Widgets only after readiness, preserves remaining time, and rejects duplicate and stale completions", () => {
    const clock = new ManualClock({ wallMs: 0 });
    const widget: RuntimeLayoutZonePlaylistItem = {
      id: "widget",
      kind: "widget",
      durationMs: 100,
      widget: {
        background: "#000",
        root: { t: "text", value: "Welcome", style: {} },
      },
    };
    const actor = createActor(zoneMachine, {
      input: { items: [widget, item("next")], clock, onReady() {} },
    });
    actor.start();
    const epoch = actor.getSnapshot().context.epoch;
    clock.advance(100_000);
    expect(actor.getSnapshot().context.shown).toBe(1);
    actor.send({ type: "MEDIA_READY", epoch });
    clock.advance(40);
    actor.send({ type: "MEDIA_READY", epoch });
    actor.send({ type: "PAUSE", epoch });
    clock.advance(1000);
    actor.send({ type: "RESUME", epoch });
    clock.advance(59);
    expect(actor.getSnapshot().context.shown).toBe(1);
    clock.advance(1);
    expect(actor.getSnapshot().context.shown).toBe(2);
    actor.send({ type: "MEDIA_ENDED", epoch });
    actor.send({ type: "MEDIA_FAILED", epoch });
    expect(actor.getSnapshot().context.shown).toBe(2);
    actor.stop();
    expect(clock.pendingTimers).toBe(0);
  });

  it("holds bounded timed Widgets to continuing evidence", () => {
    expect(
      zoneOwesContinuingEvidence({
        playlistItems: [
          { kind: "image", durationMs: 1000 },
          { kind: "widget", durationMs: 30_000 },
        ],
      }),
    ).toBe(true);
    expect(
      zoneOwesContinuingEvidence({
        playlistItems: [
          { kind: "widget", durationMs: 600_000 },
          { kind: "image", durationMs: 1000 },
        ],
      }),
    ).toBe(false);
  });
  it.each(fixtures.advance)("$name", (fixture) => {
    const clock = new ManualClock({ wallMs: 0 });
    const actor = createActor(zoneMachine, {
      input: {
        items: Array.from({ length: fixture.count }, (_, i) => item(String(i))),
        loop: fixture.loop,
        clock,
        onReady() {},
      },
    });
    actor.start();
    for (let i = 0; i < fixture.index; i++)
      actor.send({ type: "NEXT", epoch: actor.getSnapshot().context.epoch });
    const before = actor.getSnapshot().context.epoch;
    actor.send({ type: "NEXT", epoch: before });
    const selected = zoneEntry(actor.getSnapshot().context);
    expect(selected?.entry.id ?? null).toBe(
      fixture.count ? String(fixture.nextIndex) : null,
    );
    expect(actor.getSnapshot().context.epoch !== before).toBe(
      fixture.canAdvance,
    );
    actor.stop();
  });
  it.each(fixtures.nativeLoop)("$name", (fixture) => {
    const entry = {
      ...item("clip", fixture.item.kind as "image" | "video"),
      ...fixture.item,
    } as RuntimeLayoutZonePlaylistItem;
    expect(
      zoneEntry({
        items: Array.from({ length: fixture.count }, () => entry),
        shown: 1,
        loop: fixture.loop,
      })?.loop,
    ).toBe(fixture.expected);
  });
  it("times images but waits for media completion on videos with a duration", () => {
    const clock = new ManualClock({ wallMs: 0 });
    const actor = createActor(zoneMachine, {
      input: {
        items: [item("first"), item("clip", "video")],
        loop: true,
        clock,
        onReady() {},
      },
    });
    actor.start();
    actor.send({
      type: "MEDIA_READY",
      epoch: actor.getSnapshot().context.epoch,
    });
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
        onReady() {},
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
        onReady() {},
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
        onReady() {},
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

  it("reads a zero duration as unset instead of swapping at timer speed", () => {
    const clock = new ManualClock({ wallMs: 0 });
    const zero = { ...item("a"), durationMs: 0 };
    const actor = createActor(zoneMachine, {
      input: {
        items: [zero, { ...item("b"), durationMs: 0 }],
        loop: true,
        clock,
        onReady() {},
      },
    });
    actor.start();
    actor.send({
      type: "MEDIA_READY",
      epoch: actor.getSnapshot().context.epoch,
    });
    clock.advance(9_999);
    expect(actor.getSnapshot().context.shown).toBe(1);
    clock.advance(1);
    expect(actor.getSnapshot().context.shown).toBe(2);
    actor.stop();
  });
});

describe("zones that owe continuing render evidence", () => {
  const images = (count: number, durationMs: number | null = 100) =>
    Array.from({ length: count }, (_, i) => ({
      ...item(String(i)),
      durationMs,
    }));

  it("is true only for a looping rotation of short images", () => {
    expect(zoneOwesContinuingEvidence({ playlistItems: images(2) })).toBe(true);
    expect(
      zoneOwesContinuingEvidence({
        loop: true,
        playlistItems: images(3, null),
      }),
    ).toBe(true);
    expect(
      zoneOwesContinuingEvidence({ playlistItems: images(2, 120_000) }),
    ).toBe(true);
  });

  it("is false for a zone that renders once and holds", () => {
    expect(zoneOwesContinuingEvidence({})).toBe(false);
    expect(zoneOwesContinuingEvidence({ playlistItems: images(1) })).toBe(
      false,
    );
    expect(
      zoneOwesContinuingEvidence({ loop: false, playlistItems: images(3) }),
    ).toBe(false);
  });

  it("is false when the Runtime cannot bound how long an entry stays", () => {
    expect(
      zoneOwesContinuingEvidence({
        playlistItems: [...images(2), item("clip", "video")],
      }),
    ).toBe(false);
    expect(
      zoneOwesContinuingEvidence({ playlistItems: images(2, 120_001) }),
    ).toBe(false);
  });
});
