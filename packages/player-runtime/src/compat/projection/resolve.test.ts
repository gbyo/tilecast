import { describe, expect, it } from "vitest";
import {
  brandingLogoUri,
  planPresentation,
  realizePresentation,
  statusSurface,
  type ResolveInput,
} from "./resolve";
import type { Manifest } from "./types";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const asset = (n: number, mimeType = "image/png", extra = {}) => ({
  assetId: id(n),
  variantId: id(n + 100),
  mimeType,
  sha256: String(n).padStart(64, "a"),
  fileSize: 10 * n,
  downloadPath: `/api/v1/player/assets/${id(n)}/variants/${id(n + 100)}`,
  ...extra,
});
const item = (n: number, extra = {}) => ({
  id: id(n + 200),
  assetId: id(n),
  variantId: id(n + 100),
  assetType: "image",
  fitMode: "contain",
  transition: "none",
  audioEnabled: false,
  volume: 0,
  deliveryPolicy: "download",
  ...extra,
});

const LAYOUT = id(900);
const WIDGET = id(901);
const PLAYLIST = id(910);
const OTHER = id(911);
const LOGO = id(7);

function manifest(extra: Record<string, unknown> = {}): Manifest {
  return {
    schemaVersion: 17,
    manifestVersion: 1,
    screenId: id(1),
    generatedAt: "2026-10-01T00:00:00Z",
    mode: "presentation",
    serverTime: "2026-10-01T00:00:00Z",
    prefetchHorizonDays: 7,
    activationGraceSeconds: 30,
    schedules: [],
    websites: [],
    widgets: [],
    dataSources: [],
    layouts: [],
    plugins: [],
    // 1 image and 2 video are in PLAYLIST; 3 and 4 are in OTHER; 5 is unused.
    assets: [
      asset(1),
      asset(2, "video/mp4"),
      asset(3),
      asset(4, "video/mp4"),
      asset(5),
      asset(6),
      asset(7),
      asset(8),
    ],
    playlist: null,
    playlists: [
      {
        id: PLAYLIST,
        revision: 1,
        name: "Selected",
        items: [item(1), item(2, { assetType: "video" })],
      },
      {
        id: OTHER,
        revision: 1,
        name: "Other",
        items: [item(3), item(4, { assetType: "video" })],
      },
    ],
    branding: { logoAssetId: LOGO, logoVariantId: id(107) },
    ...extra,
  } as unknown as Manifest;
}

const base = (overrides: Partial<ResolveInput> = {}): ResolveInput => ({
  manifest: manifest(),
  config: { branding: {}, playback: {}, website: {} },
  selection: {
    source: "schedule",
    contentType: "playlist",
    contentId: PLAYLIST,
    selectionId: id(50),
  },
  at: new Date("2026-10-01T12:00:00Z"),
  clockOffsetMs: 0,
  ...overrides,
});

const grant = (plan: ReturnType<typeof planPresentation>) =>
  plan.requirements.map((requirement) => ({
    assetId: requirement.assetId,
    variantId: requirement.variantId,
    uri: `/player/media/1/${requirement.assetId}`,
  }));
const required = (plan: ReturnType<typeof planPresentation>) =>
  plan.requirements.map((requirement) => requirement.assetId);

describe("exact resource closure", () => {
  it("requires only the selected playlist and the branding logo", () => {
    const plan = planPresentation(base());
    expect(plan.kind).toBe("playing");
    expect(required(plan)).toEqual([id(1), id(2), LOGO].sort());
    expect(required(plan)).not.toContain(id(3));
    expect(required(plan)).not.toContain(id(5));
  });

  it("follows the Server selection rather than ranking anything itself", () => {
    const plan = planPresentation(
      base({
        selection: {
          source: "assignment",
          contentType: "playlist",
          contentId: OTHER,
        },
      }),
    );
    expect(required(plan)).toEqual([id(3), id(4), LOGO].sort());
  });

  it("requires a Layout's canvas and placement media and nothing else", () => {
    const layout = {
      id: LAYOUT,
      document: {
        schemaVersion: 2,
        canvas: {
          width: 1920,
          height: 1080,
          backgroundColor: "#000000",
          backgroundAssetId: id(5),
          backgroundVariantId: id(105),
        },
        placements: [
          {
            id: "zone",
            type: "asset",
            assetId: id(6),
            variantId: id(106),
            x: 0,
            y: 0,
            width: 960,
            height: 1080,
            layer: 0,
            opacity: 1,
            visible: true,
          },
        ],
      },
    };
    const plan = planPresentation(
      base({
        manifest: manifest({ layouts: [layout] }),
        selection: {
          source: "schedule",
          contentType: "layout",
          contentId: LAYOUT,
        },
      }),
    );
    expect(plan.kind).toBe("playing");
    expect(required(plan)).toEqual([id(5), id(6), LOGO].sort());
  });

  it("includes Website fallback images and brand bug media but not other assets", () => {
    const website = {
      assetId: id(60),
      name: "Site",
      url: "https://example.org/",
      allowedHosts: ["example.org"],
      javascriptEnabled: true,
      domStorageEnabled: true,
      cookiePolicy: "first_party",
      reloadPolicy: "on_each_activation",
      loadTimeoutSeconds: 0,
      zoomPercent: 0,
      scrollX: 0,
      scrollY: 0,
      backgroundColor: "#000000",
      failureBehavior: "",
      fallbackImageAssetId: id(5),
      fallbackVariantId: id(105),
    };
    const plan = planPresentation(
      base({
        manifest: manifest({
          websites: [website],
          playlists: [
            {
              id: PLAYLIST,
              revision: 1,
              name: "Site",
              items: [item(60, { assetType: "website", variantId: null })],
            },
          ],
          plugins: [
            {
              id: id(70),
              type: "brand_bug",
              version: 1,
              config: { imageAssetId: id(8), imageVariantId: id(108) },
            },
          ],
        }),
      }),
    );
    expect(required(plan)).toEqual([id(5), id(8), LOGO].sort());
  });

  it("requires nothing for media an availability window hides, and reports when it opens", () => {
    const hidden = asset(1, "image/png", {
      availableFrom: "2026-10-01T13:00:00Z",
    });
    const plan = planPresentation(
      base({
        manifest: manifest({
          assets: [hidden, asset(2, "video/mp4"), asset(7)],
        }),
      }),
    );
    expect(required(plan)).not.toContain(id(1));
    expect(plan.validUntil?.toISOString()).toBe("2026-10-01T13:00:00.000Z");
  });

  it("is not bounded by availability windows of unrelated content", () => {
    const unrelated = [
      asset(3, "image/png", { availableFrom: "2026-10-01T12:10:00Z" }),
      asset(4, "video/mp4", { expiresAt: "2026-10-01T12:20:00Z" }),
      asset(5, "image/png", { availableFrom: "2026-10-01T12:30:00Z" }),
    ];
    const plan = planPresentation(
      base({
        manifest: manifest({
          assets: [
            asset(1),
            asset(2, "video/mp4"),
            ...unrelated,
            asset(6),
            asset(7),
            asset(8),
          ],
        }),
      }),
    );
    expect(plan.kind).toBe("playing");
    expect(plan.validUntil).toBeNull();
  });

  it("is bounded by a window on media the selected presentation uses", () => {
    const plan = planPresentation(
      base({
        manifest: manifest({
          assets: [
            asset(1, "image/png", { expiresAt: "2026-10-01T12:45:00Z" }),
            asset(2, "video/mp4"),
            asset(3, "image/png", { availableFrom: "2026-10-01T12:10:00Z" }),
            asset(7),
          ],
        }),
      }),
    );
    expect(plan.validUntil?.toISOString()).toBe("2026-10-01T12:45:00.000Z");
  });

  it("is bounded by a window on the branding logo and on plugin media", () => {
    const logo = planPresentation(
      base({
        manifest: manifest({
          assets: [
            asset(1),
            asset(2, "video/mp4"),
            asset(7, "image/png", { expiresAt: "2026-10-01T12:40:00Z" }),
          ],
        }),
      }),
    );
    expect(logo.validUntil?.toISOString()).toBe("2026-10-01T12:40:00.000Z");
    const plugin = planPresentation(
      base({
        manifest: manifest({
          assets: [
            asset(1),
            asset(2, "video/mp4"),
            asset(7),
            asset(8, "image/png", { availableFrom: "2026-10-01T12:20:00Z" }),
          ],
          plugins: [
            {
              id: id(70),
              type: "brand_bug",
              version: 1,
              config: { imageAssetId: id(8), imageVariantId: id(108) },
            },
          ],
        }),
      }),
    );
    expect(plugin.validUntil?.toISOString()).toBe("2026-10-01T12:20:00.000Z");
  });

  it("is bounded by a Layout placement's media window and by an item window", () => {
    const layout = {
      id: LAYOUT,
      document: {
        schemaVersion: 2,
        canvas: {
          width: 1920,
          height: 1080,
          backgroundColor: "#000000",
        },
        placements: [
          {
            id: "zone",
            type: "asset",
            assetId: id(5),
            variantId: id(105),
            x: 0,
            y: 0,
            width: 960,
            height: 1080,
            layer: 0,
            opacity: 1,
            visible: true,
          },
        ],
      },
    };
    const plan = planPresentation(
      base({
        manifest: manifest({
          layouts: [layout],
          assets: [
            asset(5, "image/png", { expiresAt: "2026-10-01T14:00:00Z" }),
            asset(3, "image/png", { expiresAt: "2026-10-01T12:15:00Z" }),
            asset(7),
          ],
        }),
        selection: {
          source: "assignment",
          contentType: "layout",
          contentId: LAYOUT,
        },
      }),
    );
    expect(plan.validUntil?.toISOString()).toBe("2026-10-01T14:00:00.000Z");
    const windowedItem = planPresentation(
      base({
        manifest: manifest({
          playlists: [
            {
              id: PLAYLIST,
              revision: 1,
              name: "Selected",
              items: [
                item(1, { availableFrom: "2026-10-01T12:50:00Z" }),
                item(2, { assetType: "video" }),
              ],
            },
          ],
        }),
      }),
    );
    expect(windowedItem.validUntil?.toISOString()).toBe(
      "2026-10-01T12:50:00.000Z",
    );
  });

  it("is bounded by the Server's next evaluation", () => {
    const plan = planPresentation(
      base({ nextEvaluationAt: new Date("2026-10-01T12:30:00Z") }),
    );
    expect(plan.validUntil?.toISOString()).toBe("2026-10-01T12:30:00.000Z");
  });
});

describe("selection mapping", () => {
  it("uses the quick-present override's playlist for asset presentations", () => {
    const plan = planPresentation(
      base({
        manifest: manifest({
          presentationOverride: {
            id: id(51),
            contentType: "asset",
            contentId: id(5),
            contentName: "Poster",
            startedAt: "2026-10-01T11:00:00Z",
            playlistId: OTHER,
          },
        }),
        selection: {
          source: "quick_present",
          contentType: "asset",
          contentId: id(5),
          selectionId: id(51),
        },
      }),
    );
    expect(plan.selection).toMatchObject({
      source: "quick_present",
      playlistId: OTHER,
    });
    expect(required(plan)).toContain(id(3));
  });

  it("marks a takeover and reports the Server's selection facts", () => {
    const plan = planPresentation(
      base({
        selection: {
          source: "takeover",
          contentType: "playlist",
          contentId: PLAYLIST,
          selectionId: id(52),
        },
      }),
    );
    const resolved = realizePresentation(plan, grant(plan), [], {
      activationId: "a",
      generation: 1,
    });
    expect(resolved.presentation.presentation).toMatchObject({
      state: "playing",
      takeover: true,
    });
    expect(plan.selection).toMatchObject({
      takeoverId: id(52),
      scheduleId: null,
    });
  });

  it("is idle when the Server selected nothing, using the accepted branding copy", () => {
    const plan = planPresentation(
      base({
        selection: null,
        config: {
          branding: {
            noContentTitle: "Welcome",
            noContentMessage: "Back soon",
            backgroundColor: "#112233",
          },
        },
      }),
    );
    expect(plan.kind).toBe("idle");
    expect(plan.requirements.map((r) => r.assetId)).toEqual([LOGO]);
    const resolved = realizePresentation(
      plan,
      [{ assetId: LOGO, variantId: id(107), uri: "/player/media/1/logo" }],
      [],
      { activationId: "a", generation: 1 },
    );
    expect(resolved.presentation.presentation).toMatchObject({
      state: "idle",
      title: "Welcome",
      message: "Back soon",
      backgroundColor: "#112233",
      logoSrc: "/player/media/1/logo",
      status: "no_content",
    });
  });

  it("is unavailable when the selected content has no displayable item", () => {
    const plan = planPresentation(
      base({
        manifest: manifest({
          playlists: [{ id: PLAYLIST, revision: 1, name: "Empty", items: [] }],
        }),
      }),
    );
    expect(plan.kind).toBe("unavailable");
    const missingLayout = planPresentation(
      base({
        selection: {
          source: "assignment",
          contentType: "layout",
          contentId: LAYOUT,
        },
      }),
    );
    expect(missingLayout.kind).toBe("unavailable");
  });
});

describe("Widget references", () => {
  const widget = {
    assetId: WIDGET,
    name: "Greeting",
    provider: "text",
    presentation: {
      schemaVersion: 1,
      kind: "native",
      requiredCapabilities: { "content.text": 1 },
      native: {
        root: {
          type: "text",
          binding: { source: "literal", value: "Welcome to the lobby" },
        },
      },
    },
  };

  it("resolves a native Widget to a reference with no media beyond branding", () => {
    const plan = planPresentation(
      base({
        manifest: manifest({
          widgets: [widget],
          playlists: [
            {
              id: PLAYLIST,
              revision: 1,
              name: "Widget",
              items: [
                item(0, {
                  assetId: WIDGET,
                  variantId: null,
                  assetType: "widget",
                }),
              ],
            },
          ],
        }),
      }),
    );
    expect(plan.kind).toBe("playing");
    expect(required(plan)).toEqual([LOGO]);
    expect(plan.compatibility.required).toEqual({});
    const resolved = realizePresentation(plan, grant(plan), [], {
      activationId: "a",
      generation: 1,
    });
    const shown = resolved.presentation.presentation;
    if (shown.state !== "playing") throw new Error("not playing");
    // The Runtime projects the reference; the resolver does not draw it.
    expect(shown.items[0]).toMatchObject({
      kind: "widget",
      widget: { widgetAssetId: WIDGET },
    });
  });
});

describe("realization", () => {
  it("addresses media only through the host's bindings and applies Website defaults", () => {
    const plan = planPresentation(base());
    const bindings = plan.requirements.map((requirement) => ({
      assetId: requirement.assetId,
      variantId: requirement.variantId,
      uri: `/player/media/1/${requirement.assetId}`,
    }));
    const resolved = realizePresentation(plan, bindings, [], {
      activationId: "act",
      generation: 4,
    });
    const presentation = resolved.presentation.presentation;
    expect(presentation.state).toBe("playing");
    if (presentation.state !== "playing") throw new Error("not playing");
    expect(presentation.generation).toBe(4);
    expect(presentation.items.map((entry) => entry.src)).toEqual([
      `/player/media/1/${id(1)}`,
      `/player/media/1/${id(2)}`,
    ]);
    expect(resolved.presentation.activation).toEqual({
      activationId: "act",
      generation: 4,
    });
    expect(resolved.plugins.media).toEqual(bindings);
    expect(JSON.stringify(resolved)).not.toContain("tcreq:");
    expect(() =>
      realizePresentation(plan, [], [], { activationId: "act", generation: 4 }),
    ).toThrow("not authorized");
  });

  it("reports an unsupported component Widget without choosing the Runtime's answer", () => {
    const component = {
      assetId: WIDGET,
      name: "Clock",
      provider: "component",
      configVersion: 1,
      configuration: {},
      presentation: {
        schemaVersion: 3,
        kind: "component",
        component: {
          type: "tilecast.clock",
          version: 2,
          config: {},
          dataSources: [],
          media: [],
          empty: "render",
        },
      },
    };
    const input = base({
      manifest: manifest({
        widgets: [component],
        playlists: [
          {
            id: PLAYLIST,
            revision: 1,
            name: "Widget",
            items: [
              item(0, {
                assetId: WIDGET,
                variantId: null,
                assetType: "widget",
              }),
            ],
          },
        ],
      }),
      support: {
        presentationSchemas: [3],
        declarativeCapabilities: {},
        widgetComponents: { "widget.tilecast.clock": 1 },
      },
    });
    const plan = planPresentation(input);
    expect(plan.compatibility.required).toEqual({ "tilecast.clock": 2 });
    expect(plan.compatibility.failures).toEqual([
      {
        code: "widget_component_unsupported",
        component: "tilecast.clock",
        version: 2,
      },
    ]);
    expect(
      planPresentation({
        ...input,
        support: {
          presentationSchemas: [3],
          declarativeCapabilities: {},
          widgetComponents: { "widget.tilecast.clock": 2 },
        },
      }).compatibility.failures,
    ).toEqual([]);
  });

  it("finds an authorized logo for host-raised surfaces", () => {
    const logo = {
      assetId: LOGO,
      variantId: id(107),
      uri: "/player/media/1/logo",
    };
    expect(brandingLogoUri(manifest(), [logo], new Date())).toBe(logo.uri);
    expect(brandingLogoUri(manifest(), [], new Date())).toBeNull();
    expect(
      statusSurface("disabled", { branding: { disabledTitle: "Off" } }),
    ).toMatchObject({
      state: "disabled",
      title: "Off",
    });
  });
});

describe("reported selection facts", () => {
  it("reports a direct assignment the way every Player does", () => {
    const plan = planPresentation(
      base({
        selection: {
          source: "assignment",
          contentType: "playlist",
          contentId: PLAYLIST,
        },
      }),
    );
    expect(plan.selection?.source).toBe("direct");
    // The Server's own word still decides which content to look up.
    expect(required(plan)).toEqual([id(1), id(2), LOGO].sort());
  });

  it("leaves the other sources as the Server names them", () => {
    for (const source of ["schedule", "takeover", "quick_present"]) {
      const plan = planPresentation(
        base({
          selection: { source, contentType: "playlist", contentId: PLAYLIST },
        }),
      );
      expect(plan.selection?.source).toBe(source);
    }
  });
});

describe("external frame requirements", () => {
  const FRAME = "c".repeat(64);
  const PACKAGE = "a".repeat(64);
  const external = (pkg: Record<string, unknown>) => ({
    assetId: WIDGET,
    name: "Scores",
    provider: "acme.athletics.scoreboard",
    presentation: {
      schemaVersion: 3,
      kind: "component",
      requiredCapabilities: { "widget.external-runtime": 2 },
      component: {
        type: "acme.athletics.scoreboard",
        version: 2,
        config: { title: "Friday" },
        dataSources: [],
        media: [],
        empty: "render",
        package: {
          packageId: "acme.athletics",
          digest: `sha256:${PACKAGE}`,
          ...pkg,
        },
      },
    },
  });
  const frame = {
    sha256: FRAME,
    fileSize: 4242,
    downloadPath:
      "/api/v1/player/packages/acme.athletics/widgets/scoreboard/frame",
  };
  const planned = (
    widgets: Record<string, unknown>[],
    support?: ResolveInput["support"],
  ) =>
    planPresentation(
      base({
        manifest: manifest({
          widgets,
          playlists: [
            {
              id: PLAYLIST,
              revision: 1,
              name: "Widget",
              items: [
                item(0, {
                  assetId: WIDGET,
                  variantId: null,
                  assetType: "widget",
                }),
              ],
            },
          ],
        }),
        ...(support ? { support } : {}),
      }),
    );

  it("requires the projected frame and nothing else", () => {
    const plan = planned([external({ frame })]);
    expect(plan.kind).toBe("playing");
    expect(plan.frameRequirements).toEqual([
      {
        packageId: "acme.athletics",
        packageDigest: `sha256:${PACKAGE}`,
        frameDigest: FRAME,
        size: 4242,
        downloadPath:
          "/api/v1/player/packages/acme.athletics/widgets/scoreboard/frame",
      },
    ]);
  });

  it("fails the plan on a malformed frame claim", () => {
    for (const pkg of [
      {
        frame: { sha256: "xyz", fileSize: 9, downloadPath: frame.downloadPath },
      },
      {
        frame: { sha256: FRAME, fileSize: 0, downloadPath: frame.downloadPath },
      },
      {
        frame: {
          sha256: FRAME,
          fileSize: 9,
          downloadPath: "/api/v1/player/assets/x",
        },
      },
      { packageId: "tilecast.evil", frame },
    ]) {
      expect(planned([external(pkg)]).kind).toBe("unavailable");
    }
  });

  it("checks external components against the frame ABI, never a per-type capability", () => {
    const without = planned([external({ frame })], {
      presentationSchemas: [3],
      declarativeCapabilities: {},
      widgetComponents: { "widget.acme.athletics.scoreboard": 99 },
    });
    expect(without.compatibility.failures).toEqual([
      {
        code: "widget_component_unsupported",
        component: "acme.athletics.scoreboard",
        version: 2,
      },
    ]);
    const incapable = planned([external({ frame })], {
      presentationSchemas: [3],
      declarativeCapabilities: {},
      widgetComponents: { "widget.external-runtime": 1 },
    });
    expect(incapable.compatibility.failures).toHaveLength(1);
    const capable = planned([external({ frame })], {
      presentationSchemas: [3],
      declarativeCapabilities: {},
      widgetComponents: { "widget.external-runtime": 2 },
    });
    expect(capable.compatibility.failures).toEqual([]);
  });

  it("realizes the frame authorization table with the presentation", () => {
    const plan = planned([external({ frame })]);
    const bindings = [
      {
        packageId: "acme.athletics",
        packageDigest: `sha256:${PACKAGE}`,
        frameDigest: FRAME,
        uri: "/player/widget-frame/1/scores",
      },
    ];
    const resolved = realizePresentation(plan, [], bindings, {
      activationId: "a",
      generation: 1,
    });
    expect(resolved.presentation.projection?.widgetFrames).toEqual(bindings);
    expect(JSON.stringify(resolved)).not.toContain("tcreqframe:");
  });
});
