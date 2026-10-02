import { createActor } from "xstate";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock/scheduler";
import type {
  EvidenceKind,
  RuntimeItem,
  RuntimeWidgetComponentPayload,
} from "../host/contract";
import { presentationMachine } from "./presentation-machine";
import { specFromYouTube } from "../remote-web/spec";

function item(id: string, overrides: Partial<RuntimeItem> = {}): RuntimeItem {
  return {
    id,
    kind: "image",
    src: `tcmedia://cap/${id}`,
    durationMs: null,
    fitMode: "contain",
    audioEnabled: false,
    volume: 1,
    videoStartOffsetMs: null,
    videoEndOffsetMs: null,
    ...overrides,
  };
}

function harness(items: RuntimeItem[], synchronized = false) {
  const clock = new ManualClock({ wallMs: Date.UTC(2026, 8, 1, 12) });
  const log: string[] = [];
  const reporter = {
    evidence: (kind: EvidenceKind, itemId: string | null, zoneId?: string) =>
      log.push(`${kind}:${itemId ?? "-"}${zoneId ? `/${zoneId}` : ""}`),
    playbackError: (itemId: string | null, message: string) =>
      log.push(`error:${itemId ?? "-"}:${message}`),
    websiteRecovered: () => log.push("website-recovered"),
  };
  const actor = createActor(presentationMachine, {
    input: {
      items,
      generation: 7,
      synchronized,
      previousItemId: null,
      firstMount: 1,
      clock,
      reporter,
    },
  });
  actor.start();
  const stage = () => actor.getSnapshot().context.stage;
  const mount = () => stage()!.mount;
  const state = () => String(actor.getSnapshot().value);
  const ready = (empty = false) =>
    actor.send({
      type: "SURFACE_READY",
      mount: mount(),
      ...(empty ? { empty: true } : {}),
    });
  return { actor, clock, log, stage, mount, state, ready };
}

function componentItem(
  id: string,
  empty: RuntimeWidgetComponentPayload["component"]["empty"],
): RuntimeItem {
  return item(id, {
    kind: "widget",
    widget: {
      component: {
        type: "tilecast.test",
        version: 1,
        config: {},
        dataSources: [],
        media: [],
        empty,
      },
      documents: {},
      media: {},
      regional: { locale: "en", timeZone: "UTC", hourCycle: "h23" },
    },
  });
}

describe("presentation machine", () => {
  it("rotates still images on the default duration", () => {
    const h = harness([item("a"), item("b")]);
    expect(h.log).toEqual(["item-started:a"]);
    expect(h.stage()).toMatchObject({ phase: "preparing", transition: "fade" });
    h.ready();
    expect(h.state()).toBe("showing");
    expect(h.stage()!.phase).toBe("shown");
    h.clock.advance(9_999);
    expect(h.log).toEqual(["item-started:a", "image-shown:a"]);
    h.clock.advance(1);
    expect(h.log.slice(2)).toEqual(["item-transition:a", "item-started:b"]);
    expect(h.stage()!.item.id).toBe("b");
    expect(h.stage()!.mount).toBe(2);
  });

  it("re-reports a long-lived still image and stops when it is replaced", () => {
    const h = harness([item("a", { durationMs: 70_000 }), item("b")]);
    h.ready();
    h.clock.advance(65_000);
    expect(h.log.filter((entry) => entry === "image-shown:a")).toHaveLength(3);
    h.clock.advance(5_000);
    h.clock.advance(60_000);
    expect(h.log.filter((entry) => entry === "image-shown:a")).toHaveLength(3);
  });

  it("starts the image duration only once the image is shown", () => {
    const h = harness([item("a", { durationMs: 5_000 }), item("b")]);
    h.clock.advance(20_000);
    expect(h.stage()!.item.id).toBe("a");
    h.ready();
    h.clock.advance(5_000);
    expect(h.stage()!.item.id).toBe("b");
  });

  it("restarts a single local video in place exactly once per occurrence", () => {
    const video = item("v", { kind: "video", durationMs: 30_000 });
    const h = harness([video]);
    h.ready();
    const first = h.mount();
    // The ended event and the duration timer describe the same completion.
    h.actor.send({ type: "SURFACE_ENDED", mount: first, source: "ended" });
    h.clock.advance(30_000);
    expect(h.stage()!.restarts).toBe(1);
    expect(h.mount()).toBe(first);
    expect(
      h.log.filter((entry) => entry.startsWith("item-transition")),
    ).toHaveLength(1);
    // Until playback genuinely resumes, a trailing signal is ignored.
    h.actor.send({ type: "SURFACE_ENDED", mount: first, source: "ended" });
    expect(h.stage()!.restarts).toBe(1);
    h.actor.send({ type: "SURFACE_RESUMED", mount: first });
    h.actor.send({ type: "SURFACE_ENDED", mount: first, source: "end-offset" });
    expect(h.stage()!.restarts).toBe(2);
  });

  it("advances a video in a playlist on whichever completion comes first", () => {
    const h = harness([
      item("v", { kind: "video", durationMs: 20_000 }),
      item("b"),
    ]);
    const first = h.mount();
    h.ready();
    h.actor.send({ type: "SURFACE_ENDED", mount: first, source: "ended" });
    h.clock.flush();
    expect(h.stage()!.item.id).toBe("b");
    // The duration deadline belonged to the replaced occurrence.
    h.clock.advance(20_000);
    expect(h.stage()!.item.id).toBe("b");
    expect(h.log.filter((entry) => entry === "item-started:b")).toHaveLength(1);
  });

  it("ignores reports from a replaced occurrence", () => {
    const h = harness([item("a", { durationMs: 1_000 }), item("b")]);
    const old = h.mount();
    h.ready();
    h.clock.advance(1_000);
    h.actor.send({ type: "SURFACE_FAILED", mount: old, message: "late" });
    h.actor.send({
      type: "SURFACE_EVIDENCE",
      mount: old,
      kind: "video-progress",
    });
    expect(h.log.some((entry) => entry.includes("late"))).toBe(false);
    expect(h.log.some((entry) => entry.startsWith("video-progress"))).toBe(
      false,
    );
    expect(h.state()).toBe("preparing");
  });

  it("isolates a failure and backs off harder when everything fails", () => {
    const h = harness([item("a"), item("b")]);
    const fail = () =>
      h.actor.send({
        type: "SURFACE_FAILED",
        mount: h.mount(),
        message: "boom",
      });
    fail();
    expect(h.log).toContain("error:a:boom");
    h.clock.advance(999);
    expect(h.stage()!.item.id).toBe("a");
    h.clock.advance(1);
    expect(h.stage()!.item.id).toBe("b");
    fail();
    h.clock.advance(1_000);
    fail(); // third consecutive failure over a two-item playlist
    h.clock.advance(2_999);
    expect(h.stage()!.item.id).toBe("a");
    h.clock.advance(1);
    expect(h.stage()!.item.id).toBe("b");
  });

  it("clears the failure count once an item is shown", () => {
    const h = harness([item("a"), item("b"), item("c")]);
    h.actor.send({ type: "SURFACE_FAILED", mount: h.mount(), message: "x" });
    h.clock.advance(1_000);
    h.ready();
    expect(h.actor.getSnapshot().context.consecutiveFailures).toBe(0);
  });

  it("fails a widget with no payload without mounting a surface", () => {
    const h = harness([item("w", { kind: "widget" }), item("b")]);
    expect(h.log).toEqual(["item-started:w", "error:w:widget payload missing"]);
    h.clock.advance(1_000);
    expect(h.stage()!.item.id).toBe("b");
  });

  it("skips empty widgets and pauses a lap of nothing but empty widgets", () => {
    const empty = (id: string) =>
      item(id, {
        kind: "widget",
        widget: { background: "#000", root: { t: "box" }, autoSkip: true },
      });
    const h = harness([empty("x"), empty("y")]);
    h.clock.flush();
    expect(h.stage()!.item.id).toBe("y");
    h.clock.advance(29_999);
    expect(h.stage()!.item.id).toBe("y");
    // The lap starts over: the first empty widget is skipped at once and the
    // last one holds the pause again.
    h.clock.advance(1);
    expect(h.stage()!.item.id).toBe("y");
    expect(
      h.log.filter((entry) => entry.startsWith("widget-empty")),
    ).toHaveLength(4);
    h.clock.advance(29_999);
    expect(
      h.log.filter((entry) => entry.startsWith("widget-empty")),
    ).toHaveLength(4);
  });

  it("skips an empty skip-eligible component in local fullscreen playback", () => {
    const h = harness([componentItem("empty", "skip-eligible"), item("next")]);
    h.ready(true);
    expect(h.state()).toBe("skipping");
    expect(h.stage()).toMatchObject({
      phase: "skipping",
      item: { id: "empty" },
    });
    h.clock.flush();
    expect(h.stage()!.item.id).toBe("next");
    expect(h.log).toContain("widget-empty:empty");
    expect(h.log).not.toContain("widget-shown:empty");
  });

  it("advances when a shown skip-eligible component later becomes empty", () => {
    const h = harness([
      componentItem("changing", "skip-eligible"),
      item("next"),
    ]);
    h.ready();
    h.actor.send({ type: "WIDGET_EMPTY", mount: h.mount() });
    expect(h.state()).toBe("skipping");
    h.clock.flush();
    expect(h.stage()!.item.id).toBe("next");
    expect(h.log).toContain("widget-empty:changing");
  });

  it("pauses an empty component lap and ignores replaced mount signals", () => {
    const h = harness([
      componentItem("x", "skip-eligible"),
      componentItem("y", "skip-eligible"),
    ]);
    const firstMount = h.mount();
    h.ready(true);
    h.clock.flush();
    expect(h.stage()!.item.id).toBe("y");
    h.actor.send({ type: "WIDGET_EMPTY", mount: firstMount });
    expect(h.state()).toBe("preparing");
    h.ready(true);
    h.clock.advance(29_999);
    expect(h.state()).toBe("skipping");
    expect(h.stage()!.item.id).toBe("y");
    h.clock.advance(1);
    expect(h.stage()!.item.id).toBe("x");
    expect(h.state()).toBe("preparing");
    h.actor.send({ type: "WIDGET_EMPTY", mount: firstMount });
    expect(h.state()).toBe("preparing");
    expect(
      h.log.filter((entry) => entry.startsWith("widget-empty:")),
    ).toHaveLength(2);
    h.actor.stop();
  });

  it("renders empty components declared render and in synchronized playback", () => {
    const render = harness([componentItem("render", "render"), item("next")]);
    render.ready(true);
    expect(render.state()).toBe("showing");
    expect(render.log).toContain("widget-shown:render");
    expect(render.log).not.toContain("widget-empty:render");

    const synchronized = harness(
      [componentItem("shared", "skip-eligible"), item("next")],
      true,
    );
    synchronized.ready(true);
    expect(synchronized.state()).toBe("showing");
    expect(synchronized.stage()!.item.id).toBe("shared");
    expect(synchronized.log).toContain("widget-shown:shared");
    expect(synchronized.log).not.toContain("widget-empty:shared");
  });

  it("does not skip a Layout when one of its zones is empty", () => {
    const h = harness([
      item("layout", {
        kind: "layout",
        layout: {
          canvasWidth: 1920,
          canvasHeight: 1080,
          background: "#000",
          zones: [
            {
              id: "zone",
              x: 0,
              y: 0,
              width: 1920,
              height: 1080,
              layer: 0,
              opacity: 1,
              component: componentItem("zone-widget", "skip-eligible")
                .widget as RuntimeWidgetComponentPayload,
            },
          ],
        },
      }),
      item("next"),
    ]);
    h.ready(true);
    expect(h.state()).toBe("showing");
    expect(h.stage()!.item.id).toBe("layout");
    expect(h.log).toContain("layout-shown:layout");
    expect(h.log).not.toContain("widget-empty:layout");
  });

  it("bounds a website from mount and falls back or advances on failure", () => {
    const website = {
      loadTimeoutSeconds: 10,
      refreshIntervalSeconds: null,
      zoomPercent: 100,
      javascriptEnabled: true,
      domStorageEnabled: true,
      cookiePolicy: "first_party",
      reloadPolicy: "never",
      customUserAgent: "",
      scrollX: 0,
      scrollY: 0,
      backgroundColor: "#000",
      failureBehavior: "fallback",
      fallbackSrc: "tcmedia://cap/fallback",
      allowedHosts: [],
    };
    const h = harness([
      item("site", { kind: "website", src: "https://example.org", website }),
      item("b"),
    ]);
    h.actor.send({
      type: "WEBSITE_FAILED",
      mount: h.mount(),
      reason: "load timeout",
      fallback: true,
    });
    expect(h.log).toContain("error:site:website failed: load timeout");
    h.actor.send({ type: "FALLBACK_SHOWN", mount: h.mount() });
    expect(h.log).toContain("image-shown:site");
    expect(h.stage()!.phase).toBe("shown");
    // The mount-time 60 s bound still applies to the occurrence.
    h.clock.advance(60_000);
    h.clock.flush();
    expect(h.stage()!.item.id).toBe("b");
  });

  it("never changes the occurrence on its own under a shared timeline", () => {
    const h = harness(
      [
        item("a", { durationMs: 1_000 }),
        item("v", { kind: "video", durationMs: 1_000 }),
      ],
      true,
    );
    h.ready();
    h.clock.advance(60_000);
    expect(h.stage()!.item.id).toBe("a");
    h.actor.send({ type: "SKIP" });
    h.actor.send({ type: "SURFACE_FAILED", mount: h.mount(), message: "x" });
    h.clock.advance(60_000);
    expect(h.stage()!.item.id).toBe("a");
    expect(h.log).toContain("error:a:x");
  });

  it("skips and retries on command", () => {
    const h = harness([item("a"), item("b")]);
    h.ready();
    h.actor.send({ type: "SKIP" });
    h.clock.flush();
    expect(h.stage()!.item.id).toBe("b");
    const before = h.mount();
    h.actor.send({ type: "RETRY" });
    expect(h.stage()!.item.id).toBe("b");
    expect(h.mount()).toBe(before + 1);
  });

  it("does nothing for an empty playlist and stops cleanly", () => {
    const h = harness([]);
    expect(h.state()).toBe("empty");
    const running = harness([item("a")]);
    running.ready();
    running.actor.send({ type: "STOP" });
    expect(running.clock.pendingTimers).toBe(0);
    expect(running.actor.getSnapshot().status).toBe("done");
  });

  it("does not dissolve an item into itself", () => {
    const h = harness([item("a", { transition: "fade" })]);
    h.ready();
    h.clock.advance(10_000);
    h.clock.flush();
    expect(h.stage()!.transition).toBe("none");
  });

  it("plays YouTube until the video ends, with no duration timer", () => {
    const remoteWeb = specFromYouTube(
      { videoId: "M7lc1UVf-VE", playlistPlaybackMode: "until_end" },
      null,
    )!;
    const h = harness([
      item("yt", { kind: "youtube", src: "", remoteWeb }),
      item("b"),
    ]);
    h.ready();
    h.clock.advance(10 * 60_000);
    expect(h.stage()!.item.id).toBe("yt");
    h.actor.send({ type: "SURFACE_ENDED", mount: h.mount(), source: "ended" });
    h.clock.flush();
    expect(h.stage()!.item.id).toBe("b");
    expect(h.log).toContain("website-loaded:yt");
  });

  it("keeps the Website duration for YouTube with a fixed duration", () => {
    const remoteWeb = specFromYouTube(
      { videoId: "M7lc1UVf-VE", fixedDurationSeconds: 20 },
      null,
    )!;
    const h = harness([
      item("yt", { kind: "youtube", src: "", remoteWeb, durationMs: 20_000 }),
      item("b"),
    ]);
    h.ready();
    h.clock.advance(20_000);
    h.clock.flush();
    expect(h.stage()!.item.id).toBe("b");
  });

  it("reports a failed Layout zone without failing the Layout", () => {
    const h = harness([
      item("l", {
        kind: "layout",
        src: "",
        durationMs: 30_000,
        layout: {
          canvasWidth: 1920,
          canvasHeight: 1080,
          background: "#000",
          zones: [],
        },
      }),
    ]);
    h.ready();
    h.actor.send({
      type: "ZONE_FAILED",
      mount: h.mount(),
      zoneId: "zone-menu",
      message: "website failed: renderer_crash",
    });
    h.actor.send({
      type: "ZONE_FAILED",
      mount: 999,
      zoneId: "stale",
      message: "x",
    });
    expect(h.state()).toBe("showing");
    expect(h.log).toContain(
      "error:l:zone zone-menu: website failed: renderer_crash",
    );
    expect(h.log.some((entry) => entry.includes("stale"))).toBe(false);
  });
});
