/*
 * The shared remote web model: one normalized spec for Website assets, web
 * Widgets and YouTube, the host-view port, and projection of remote web
 * Widgets at the root and inside Layout zones.
 */
import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock/scheduler";
import {
  hostContractProblem,
  type RemoteWebCreateResultV1,
  type RemoteWebSurfaceSpecV1,
  type RuntimeItem,
  type RuntimeLayoutPayload,
  type RuntimePresentation,
  type TilecastRuntimeHostV1,
} from "../host/contract";
import { createProjector } from "../compat/projector";
import { RemoteWebPort } from "./port";
import {
  remoteWebSpecOf,
  specFromWebDescriptor,
  specFromWebsite,
  specFromYouTube,
  youtubeEmbedUrl,
} from "./spec";

const website = {
  loadTimeoutSeconds: 500,
  refreshIntervalSeconds: 10,
  zoomPercent: 1000,
  javascriptEnabled: false,
  domStorageEnabled: true,
  cookiePolicy: "disabled",
  reloadPolicy: "interval",
  customUserAgent: "Signage/1\n",
  scrollX: -5,
  scrollY: 40,
  backgroundColor: "red",
  failureBehavior: "fallback_image",
  fallbackSrc: "tcmedia://cap/" + "b".repeat(64),
  allowedHosts: ["Example.ORG.", "example.org", "*.evil", "cdn.example.org"],
};

describe("remote web spec", () => {
  it("normalizes a Website asset and bounds every value", () => {
    const spec = specFromWebsite("https://example.org/board", website)!;
    expect(spec.content).toEqual({
      kind: "page",
      url: "https://example.org/board",
      allowedHosts: ["example.org", "cdn.example.org"],
      javascriptEnabled: false,
      domStorageEnabled: true,
      cookiePolicy: "disabled",
      userAgent: "",
      zoomPercent: 500,
      scrollX: 0,
      scrollY: 40,
      backgroundColor: "#0E141B",
    });
    expect(spec.presentation.loadTimeoutSeconds).toBe(120);
    expect(spec.presentation.reloadIntervalSeconds).toBe(30);
    expect(spec.presentation.fallbackSrc).toBe(website.fallbackSrc);
  });

  it("refuses URLs a host must never load", () => {
    for (const url of [
      "file:///var/lib/tilecast-edge/state.db",
      "tilecast://runtime/index.html",
      "tcmedia://cap/" + "a".repeat(64),
      "javascript:alert(1)",
      "https://user:pw@example.org/",
      "https://example.org/" + "a".repeat(2100),
    ]) {
      expect(specFromWebsite(url, website)).toBeNull();
    }
  });

  it("uses the server-compiled web descriptor as it is", () => {
    const spec = specFromWebDescriptor({
      mode: "remote",
      url: "https://news.example.net/",
      allowedHosts: ["news.example.net"],
      loadTimeoutSeconds: 15,
      lifecycle: "keep_warm",
      warmSeconds: 900,
      reload: { mode: "periodic", intervalSeconds: 120 },
      fallbackBehavior: "skip",
      onlineOnly: true,
    })!;
    expect(spec.content.kind).toBe("page");
    expect(spec.presentation).toMatchObject({
      loadTimeoutSeconds: 15,
      lifecycle: "keep_warm",
      warmSeconds: 300,
      reloadIntervalSeconds: 120,
      failureBehavior: "skip",
      onlineOnly: true,
    });
    expect(
      specFromWebDescriptor({ mode: "bundle", url: "https://x.example/" }),
    ).toBeNull();
  });

  it("carries the documented YouTube settings and completion", () => {
    const spec = specFromYouTube(
      {
        kind: "video",
        videoId: "M7lc1UVf-VE",
        startSeconds: 12,
        endSeconds: 90,
        muted: true,
        volume: 140,
        captions: true,
        captionLanguage: "pt-BR",
        controls: true,
        playlistPlaybackMode: "until_end",
      },
      null,
    )!;
    expect(spec.content).toEqual({
      kind: "youtube",
      videoId: "M7lc1UVf-VE",
      playlistId: null,
      startSeconds: 12,
      endSeconds: 90,
      loop: false,
      muted: true,
      volume: 100,
      captions: true,
      captionLanguage: "pt-BR",
      controls: true,
    });
    expect(spec.presentation.playUntilEnd).toBe(true);
    expect(specFromYouTube({ videoId: 'x"<script>' }, null)).toBeNull();
    expect(
      specFromYouTube(
        { videoId: "M7lc1UVf-VE", fixedDurationSeconds: 30 },
        null,
      )!.presentation.playUntilEnd,
    ).toBe(false);
  });

  it("builds the privacy-enhanced embed URL from documented parameters", () => {
    const url = new URL(
      youtubeEmbedUrl({
        kind: "youtube",
        videoId: "M7lc1UVf-VE",
        playlistId: null,
        startSeconds: 5,
        endSeconds: null,
        loop: true,
        muted: false,
        volume: 50,
        captions: false,
        captionLanguage: "",
        controls: false,
      }),
    );
    expect(url.host).toBe("www.youtube-nocookie.com");
    expect(url.pathname).toBe("/embed/M7lc1UVf-VE");
    expect([...url.searchParams.keys()].sort()).toEqual(
      [
        "autoplay",
        "cc_load_policy",
        "controls",
        "loop",
        "mute",
        "playlist",
        "playsinline",
        "rel",
        "start",
      ].sort(),
    );
    expect(url.searchParams.get("playlist")).toBe("M7lc1UVf-VE");
  });

  it("prefers the projected spec over the Website configuration", () => {
    const spec = specFromWebsite("https://example.org/", website)!;
    const item = {
      id: "i",
      kind: "website",
      src: "https://other.example/",
      website,
      remoteWeb: spec,
    } as unknown as RuntimeItem;
    expect(remoteWebSpecOf(item)).toBe(spec);
  });
});

class FakeHost {
  created: RemoteWebSurfaceSpecV1[] = [];
  calls: string[] = [];
  result: RemoteWebCreateResultV1 = {
    ok: true,
    target: { kind: "media-uri", uri: "tcweb://cap/" + "c".repeat(64) },
  };
  readonly api = {
    reportRecovered: () => this.calls.push("recovered"),
    create: (spec: RemoteWebSurfaceSpecV1) => {
      this.created.push(spec);
      return Promise.resolve(this.result);
    },
    updateViewport: (id: string) => this.calls.push(`viewport ${id}`),
    setVisible: (id: string, v: boolean) =>
      this.calls.push(`visible ${id} ${v}`),
    setMuted: (id: string, m: boolean) => this.calls.push(`muted ${id} ${m}`),
    reload: (id: string) => this.calls.push(`reload ${id}`),
    destroy: (id: string) => this.calls.push(`destroy ${id}`),
  };
}

const page = specFromWebsite("https://example.org/", website)!.content;
const viewport = { x: 0, y: 0, width: 640, height: 360, deviceScale: 1 };

describe("host-view port", () => {
  it("requires every host-view member when the capability is advertised", () => {
    const host = {
      contractVersion: 1,
      info: {},
      capabilities: { remoteWeb: "host-view" },
      subscribe() {},
      ready() {},
      presentationResult() {},
      reportEvidence() {},
      reportPlaybackError() {},
      remoteWeb: { reportRecovered() {}, create() {} },
    } as unknown as TilecastRuntimeHostV1;
    expect(hostContractProblem(host)).toContain("remoteWeb.updateViewport");
    const electron = {
      ...host,
      capabilities: { remoteWeb: "electron-webview" },
    };
    expect(hostContractProblem(electron)).toBeNull();
  });

  it("dispatches events by surface and drops those of released surfaces", async () => {
    const fake = new FakeHost();
    const port = new RemoteWebPort(fake.api, new ManualClock({ wallMs: 0 }));
    const seen: string[] = [];
    const { state } = await port.create(
      { content: page, viewport, muted: true, visible: false },
      (event) => seen.push(event.kind),
    );
    expect(fake.created[0]!.surfaceId).toMatch(/^[a-z0-9-]{1,48}$/);
    port.receive({ surfaceId: state.surfaceId, kind: "loaded" });
    port.receive({ surfaceId: "rw-999", kind: "failed", code: "load_failed" });
    port.release(state.surfaceId, null);
    port.receive({
      surfaceId: state.surfaceId,
      kind: "failed",
      code: "load_failed",
    });
    port.setVisible(state.surfaceId, true);
    expect(seen).toEqual(["loaded"]);
    expect(fake.calls).toEqual([
      `muted ${state.surfaceId} true`,
      `visible ${state.surfaceId} false`,
      `destroy ${state.surfaceId}`,
    ]);
  });

  it("fails every live surface when the host process ends, then reports recovery once", async () => {
    const fake = new FakeHost();
    const port = new RemoteWebPort(fake.api, new ManualClock({ wallMs: 0 }));
    const events: string[] = [];
    for (let i = 0; i < 2; i++) {
      await port.create(
        { content: page, viewport, muted: true, visible: true },
        (e) => events.push(`${e.surfaceId} ${e.kind} ${e.code}`),
      );
    }
    port.receive({ surfaceId: null, kind: "process-terminated" });
    expect(events).toEqual([
      "rw-1 failed helper_terminated",
      "rw-2 failed helper_terminated",
    ]);
    expect(port.takeRecovery()).toBe(true);
    expect(port.takeRecovery()).toBe(false);
  });

  it("keeps at most two warm surfaces and expires them", async () => {
    const fake = new FakeHost();
    const clock = new ManualClock({ wallMs: 0 });
    const port = new RemoteWebPort(fake.api, clock);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { state } = await port.create(
        { content: page, viewport, muted: true, visible: true },
        () => undefined,
      );
      port.receive({ surfaceId: state.surfaceId, kind: "loaded" });
      ids.push(state.surfaceId);
      port.release(state.surfaceId, { key: `k${i}`, warmMs: 60_000 });
    }
    expect(port.describe()).toEqual({ live: 2, warm: 2 });
    expect(fake.calls).toContain(`destroy ${ids[0]}`);
    const adopted = port.adopt("k2", () => undefined);
    expect(adopted?.surfaceId).toBe(ids[2]);
    clock.advance(60_001);
    expect(fake.calls).toContain(`destroy ${ids[1]}`);
    expect(port.describe()).toEqual({ live: 1, warm: 0 });
  });

  it("never keeps a failed surface warm", async () => {
    const fake = new FakeHost();
    const port = new RemoteWebPort(fake.api, new ManualClock({ wallMs: 0 }));
    const { state } = await port.create(
      { content: page, viewport, muted: true, visible: true },
      () => undefined,
    );
    port.receive({ surfaceId: state.surfaceId, kind: "loaded" });
    port.receive({
      surfaceId: state.surfaceId,
      kind: "failed",
      code: "renderer_crash",
    });
    port.release(state.surfaceId, { key: "k", warmMs: 60_000 });
    expect(port.describe()).toEqual({ live: 0, warm: 0 });
  });

  it("maps a host that cannot create into a typed failure", async () => {
    const fake = new FakeHost();
    fake.result = { ok: false, code: "limit_exceeded" };
    const port = new RemoteWebPort(fake.api, new ManualClock({ wallMs: 0 }));
    const { result } = await port.create(
      { content: page, viewport, muted: true, visible: true },
      () => undefined,
    );
    expect(result).toEqual({ ok: false, code: "limit_exceeded" });
    expect(port.describe().live).toBe(0);
  });
});

const WEB = "2f1c0e3d-5a7b-4c9d-8e1f-0a2b3c4d5e6f";
const YT = "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d";
const YT2 = "8b7c6d5e-4f3a-4b2c-8d9e-6f5a4b3c2d1e";
const FALLBACK = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const FALLBACK_VARIANT = "4d5e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f7a";
const LAYOUT = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const CAP = "tcmedia://cap/" + "d".repeat(64);

const placement = (id: string, widgetId: string, x: number, width: number) => ({
  id,
  type: "widget",
  name: id,
  widgetId,
  x,
  y: 0,
  width,
  height: 540,
  layer: 0,
  opacity: 1,
  visible: true,
  locked: false,
});

const manifest = {
  assets: [
    {
      assetId: FALLBACK,
      variantId: FALLBACK_VARIANT,
      mimeType: "image/png",
      sha256: "0".repeat(64),
      fileSize: 68,
      downloadPath: `/api/v1/player/assets/${FALLBACK}/variants/${FALLBACK_VARIANT}`,
    },
  ],
  playlists: [],
  dataSources: [],
  widgets: [
    {
      assetId: WEB,
      name: "Menu",
      provider: "website",
      configVersion: 1,
      configuration: {},
      presentation: {
        schemaVersion: 1,
        kind: "web",
        requiredCapabilities: { "web.remote": 1 },
        web: {
          mode: "remote",
          url: "https://menu.example.org/today",
          allowedHosts: ["menu.example.org"],
          loadTimeoutSeconds: 20,
          fallbackBehavior: "placeholder",
          lifecycle: "destroy_on_hide",
          onlineOnly: true,
        },
      },
    },
    {
      assetId: YT,
      name: "Clip",
      provider: "youtube",
      configVersion: 1,
      configuration: {
        kind: "video",
        videoId: "M7lc1UVf-VE",
        failureBehavior: "fallback_image",
        fallbackImageAssetId: FALLBACK,
        playlistPlaybackMode: "until_end",
      },
      presentation: {
        schemaVersion: 1,
        kind: "web",
        requiredCapabilities: { "web.remote": 1 },
        web: {
          mode: "remote",
          url: "https://www.youtube.com/embed/M7lc1UVf-VE",
        },
      },
    },
    {
      assetId: YT2,
      name: "Clip 2",
      provider: "youtube",
      configVersion: 1,
      configuration: { kind: "video", videoId: "aqz-KE-bpKQ" },
    },
  ],
  layouts: [
    {
      id: LAYOUT,
      document: {
        schemaVersion: 2,
        canvas: { width: 1920, height: 1080, backgroundColor: "#000000" },
        placements: [
          placement("zone-menu", WEB, 0, 960),
          placement("zone-clip", YT, 960, 960),
        ],
      },
    },
  ],
};

function reference(id: string, extra: Partial<RuntimeItem>): RuntimeItem {
  return {
    id,
    kind: "widget",
    src: "",
    durationMs: null,
    fitMode: "contain",
    transition: "none",
    audioEnabled: true,
    volume: 1,
    videoStartOffsetMs: null,
    videoEndOffsetMs: null,
    ...extra,
  };
}

describe("remote web Widget projection", () => {
  const projector = createProjector({
    schema: 1,
    clockOffsetMs: 0,
    manifest,
    media: [{ assetId: FALLBACK, variantId: FALLBACK_VARIANT, uri: CAP }],
  })!;
  const project = (items: RuntimeItem[]) =>
    projector.project(
      {
        state: "playing",
        items,
        takeover: false,
        generation: 1,
      } as RuntimePresentation,
      Date.UTC(2026, 8, 26),
    ) as Extract<RuntimePresentation, { state: "playing" }>;

  it("turns root web and YouTube Widgets into remote web items", () => {
    const projected = project([
      reference("a", { widget: { widgetAssetId: WEB } }),
      reference("b", { widget: { widgetAssetId: YT } }),
    ]);
    const [web, youtube] = projected.items;
    expect(web).toMatchObject({
      id: "a",
      kind: "website",
      src: "https://menu.example.org/today",
    });
    expect(web!.widget).toBeUndefined();
    expect(web!.remoteWeb!.content).toMatchObject({
      kind: "page",
      allowedHosts: ["menu.example.org"],
    });
    expect(youtube).toMatchObject({
      id: "b",
      kind: "youtube",
      audioEnabled: true,
    });
    expect(youtube!.remoteWeb!.content).toMatchObject({
      kind: "youtube",
      videoId: "M7lc1UVf-VE",
    });
    // The fallback image is addressed only through the host's alias table.
    expect(youtube!.remoteWeb!.presentation.fallbackSrc).toBe(CAP);
    expect(youtube!.remoteWeb!.presentation.playUntilEnd).toBe(true);
  });

  it("places remote web Widgets in Layout zones", () => {
    const projected = project([
      reference("l", { kind: "layout", layout: { layoutId: LAYOUT } }),
    ]);
    const layout = projected.items[0]!.layout as RuntimeLayoutPayload;
    const zones = Object.fromEntries(
      layout.zones.map((zone) => [zone.id, zone]),
    );
    expect(zones["zone-menu"]!.remoteWeb!.content).toMatchObject({
      kind: "page",
      url: "https://menu.example.org/today",
    });
    expect(zones["zone-clip"]!.remoteWeb!.content.kind).toBe("youtube");
    expect(zones["zone-menu"]!.render).toBeUndefined();
  });
});
