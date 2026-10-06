import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  normalizeContentDefinitionCatalog,
  normalizeLayout,
  normalizePlaylist,
  normalizePlaylistAssignment,
  normalizeProviderCatalog,
  normalizeScreen,
  playerReleaseContentType,
} from "./client";
import type { AuthStatus, Layout, Screen } from "./types";

afterEach(() => vi.unstubAllGlobals());

/**
 * Realistic fetch stub body for migrated domain helpers, which read
 * through openapi-fetch (headers and all) rather than the legacy
 * json-only request path.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("authentication contract", () => {
  it("distinguishes initial setup from a signed-out installation", () => {
    const setup: AuthStatus = { setupRequired: true, authenticated: false };
    const signedOut: AuthStatus = {
      setupRequired: false,
      authenticated: false,
    };
    expect(setup.setupRequired).toBe(true);
    expect(signedOut.setupRequired).toBe(false);
  });
});

describe("layout library contract", () => {
  it("loads every page for client-side library filtering", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            items: [{ id: "layout-1" }],
            total: 101,
            page: 1,
            pageSize: 100,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            items: [{ id: "layout-101" }],
            total: 101,
            page: 2,
            pageSize: 100,
          },
        }),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(api.layouts("lobby")).resolves.toMatchObject({
      items: [{ id: "layout-1" }, { id: "layout-101" }],
      total: 101,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const second = fetch.mock.calls[1] as [string, RequestInit];
    const url = new URL(second[0]);
    expect(url.pathname).toBe("/api/v1/layouts");
    expect(url.searchParams.get("search")).toBe("lobby");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("pageSize")).toBe("100");
  });
});

describe("paged Studio library contracts", () => {
  it("requests the selected playlist page with its server search", async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          items: [{ id: "playlist-101", name: "Lobby" }],
          total: 101,
          page: 2,
          pageSize: 100,
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(api.playlistPage("lobby", 2)).resolves.toMatchObject({
      items: [{ id: "playlist-101" }],
      page: 2,
      total: 101,
    });
    const [requestUrl] = fetch.mock.calls[0] as [string, RequestInit];
    const url = new URL(requestUrl);
    expect(url.pathname).toBe("/api/v1/playlists");
    expect(url.searchParams.get("search")).toBe("lobby");
    expect(url.searchParams.get("page")).toBe("2");
  });

  it("loads later Data Source pages for selector callers", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            items: [{ id: "source-1" }],
            total: 101,
            page: 1,
            pageSize: 100,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            items: [{ id: "source-101" }],
            total: 101,
            page: 2,
            pageSize: 100,
          },
        }),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(
      api.listDataSources(new URLSearchParams({ provider: "weather" })),
    ).resolves.toMatchObject({
      items: [{ id: "source-1" }, { id: "source-101" }],
      total: 101,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const second = fetch.mock.calls[1] as [string, RequestInit];
    const url = new URL(second[0]);
    expect(url.searchParams.get("provider")).toBe("weather");
    expect(url.searchParams.get("page")).toBe("2");
  });
});

describe("Player release upload contract", () => {
  it("uses server-accepted media types for the Linux release files", () => {
    expect(playerReleaseContentType("tilecast-player.AppImage")).toBe(
      "application/octet-stream",
    );
    expect(playerReleaseContentType("tilecast-player-update-linux.json")).toBe(
      "application/json",
    );
    expect(
      playerReleaseContentType("tilecast-player-update-linux.json.sig"),
    ).toBe("text/plain");
  });
});

describe("screen group compatibility", () => {
  it("normalizes a missing screens collection in group details", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ data: { id: "group-1", name: "Lobby" } }),
        ),
    );

    await expect(api.screenGroup("group-1")).resolves.toMatchObject({
      id: "group-1",
      screens: [],
    });
  });

  it("normalizes missing screens collections in group lists", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ data: { items: [{ id: "group-1" }] } }),
        ),
    );

    await expect(api.screenGroups()).resolves.toMatchObject({
      items: [{ id: "group-1", screens: [] }],
    });
  });

  it("handles a list response without items", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ data: {} })),
    );

    await expect(api.screenGroups()).resolves.toMatchObject({ items: [] });
  });
});

describe("mixed-version collection compatibility", () => {
  it("normalizes missing screen metadata used by detail panels", () => {
    expect(
      normalizeScreen({ platform: "android-tv" } as unknown as Screen)
        .deviceManufacturer,
    ).toBe("");
  });

  it("normalizes missing assignment collections and status", () => {
    expect(normalizePlaylistAssignment(undefined)).toMatchObject({
      synchronizationStatus: "not_reported",
      groups: [],
      relevantSchedules: [],
    });
  });

  it("normalizes missing provider and definition collections", () => {
    expect(normalizeProviderCatalog(undefined).providers).toEqual([]);
    expect(normalizeContentDefinitionCatalog(undefined)).toMatchObject({
      widgets: [],
      dataSources: [],
    });
  });

  it("normalizes missing collections even when a detail payload is nullish", () => {
    expect(normalizePlaylist(undefined)).toMatchObject({
      items: [],
      warnings: [],
      layoutUsage: [],
    });
  });

  it("normalizes missing playlist collections before pages consume them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ data: { id: "playlist-1" } })),
    );

    await expect(api.playlist("playlist-1")).resolves.toMatchObject({
      items: [],
      warnings: [],
      layoutUsage: [],
    });
  });

  it("normalizes missing layout editor collections", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            id: "layout-1",
            orientation: "landscape",
            canvasWidth: 1920,
            canvasHeight: 1080,
            draft: { schemaVersion: 2, canvas: null },
          },
        }),
      ),
    );

    await expect(api.layout("layout-1")).resolves.toMatchObject({
      draft: {
        canvas: { width: 1920, height: 1080 },
        placements: [],
      },
      dependencies: [],
      usage: { screens: [], schedules: [] },
    });
  });

  it("merges layout canvas defaults into a partial draft", () => {
    const layout = {
      id: "layout-1",
      orientation: "landscape",
      canvasWidth: 1920,
      canvasHeight: 1080,
      draft: { canvas: { backgroundColor: "#123456" } },
    } as unknown as Layout;

    expect(normalizeLayout(layout).draft.canvas).toMatchObject({
      width: 1920,
      height: 1080,
      orientation: "landscape",
      backgroundColor: "#123456",
      safeAreaPercent: 5,
    });
  });
});

describe("playlist creation contract", () => {
  it("sends the selected playlist type", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ data: { id: "playlist-1", sourceType: "tag" } }, 201),
      );
    vi.stubGlobal("fetch", fetch);

    await api.createPlaylist(
      { name: "Tagged media", description: "", sourceType: "tag" },
      "csrf-token",
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/playlists");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-csrf-token"]).toBe("csrf-token");
    expect(init.credentials).toBe("same-origin");
    expect(init.body).toBe(
      JSON.stringify({
        name: "Tagged media",
        description: "",
        sourceType: "tag",
      }),
    );
  });
});

describe("playlist bulk editing contract", () => {
  it("sends an authoring-level transition update to the static playlist endpoint", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ data: { id: "playlist-1", items: [] } }),
      );
    vi.stubGlobal("fetch", fetch);

    await api.bulkUpdatePlaylistItems(
      "playlist-1",
      { transition: "crossfade" },
      "csrf-token",
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/playlists/playlist-1/items/bulk");
    expect(init.method).toBe("PUT");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-csrf-token"]).toBe("csrf-token");
    expect(init.credentials).toBe("same-origin");
    expect(init.body).toBe(JSON.stringify({ transition: "crossfade" }));
  });
});

describe("Widget preview snapshots", () => {
  it("uploads the frozen JPEG with CSRF protection", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetch);
    const image = new Blob(["jpeg"], { type: "image/jpeg" });

    await api.uploadWidgetPreview("widget 1", image, "csrf-token");

    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/widgets/widget%201/preview-image",
      expect.objectContaining({
        method: "PUT",
        credentials: "same-origin",
        headers: {
          "Content-Type": "image/jpeg",
          "X-CSRF-Token": "csrf-token",
        },
        body: image,
      }),
    );
  });
});

describe("Widget preview snapshot requests", () => {
  const image = new Blob(["jpeg"], { type: "image/jpeg" });

  it("passes the abort signal so a superseded upload can be cancelled", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();

    await api.uploadWidgetPreview("widget-1", image, "csrf", controller.signal);

    expect(fetch.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("raises the Server's error, or a Widget-specific fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 413,
        json: () =>
          Promise.resolve({
            error: { code: "too_large", message: "The image is too large." },
          }),
      }),
    );
    await expect(
      api.uploadWidgetPreview("widget-1", image, "csrf"),
    ).rejects.toMatchObject({
      message: "The image is too large.",
      status: 413,
      code: "too_large",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error("not json")),
      }),
    );
    await expect(
      api.uploadWidgetPreview("widget-1", image, "csrf"),
    ).rejects.toMatchObject({
      message: "The Widget preview image could not be saved.",
      status: 500,
      code: "unknown_error",
    });
  });
});

describe("Layout preview snapshots", () => {
  it("uploads the frozen JPEG with CSRF protection", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetch);
    const image = new Blob(["jpeg"], { type: "image/jpeg" });

    await api.uploadLayoutPreview("layout 1", 7, image, "csrf-token");

    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/layouts/layout%201/preview-image?draftRevision=7",
      expect.objectContaining({
        method: "PUT",
        credentials: "same-origin",
        headers: {
          "Content-Type": "image/jpeg",
          "X-CSRF-Token": "csrf-token",
        },
        body: image,
      }),
    );
  });
});
