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
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: {
              items: [{ id: "layout-1" }],
              total: 101,
              page: 1,
              pageSize: 100,
            },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: {
              items: [{ id: "layout-101" }],
              total: 101,
              page: 2,
              pageSize: 100,
            },
          }),
      });
    vi.stubGlobal("fetch", fetch);

    await expect(api.layouts("lobby")).resolves.toMatchObject({
      items: [{ id: "layout-1" }, { id: "layout-101" }],
      total: 101,
    });
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/v1/layouts?search=lobby&page=2&pageSize=100",
      expect.any(Object),
    );
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
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { id: "group-1", name: "Lobby" } }),
      }),
    );

    await expect(api.screenGroup("group-1")).resolves.toMatchObject({
      id: "group-1",
      screens: [],
    });
  });

  it("normalizes missing screens collections in group lists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { items: [{ id: "group-1" }] } }),
      }),
    );

    await expect(api.screenGroups()).resolves.toMatchObject({
      items: [{ id: "group-1", screens: [] }],
    });
  });

  it("handles a list response without items", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: {} }),
      }),
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
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { id: "playlist-1" } }),
      }),
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
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: {
              id: "layout-1",
              orientation: "landscape",
              canvasWidth: 1920,
              canvasHeight: 1080,
              draft: { schemaVersion: 2, canvas: null },
            },
          }),
      }),
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
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: () =>
        Promise.resolve({
          data: { id: "playlist-1", sourceType: "tag" },
        }),
    });
    vi.stubGlobal("fetch", fetch);

    await api.createPlaylist(
      { name: "Tagged media", description: "", sourceType: "tag" },
      "csrf-token",
    );

    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/playlists",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": "csrf-token",
        },
        body: JSON.stringify({
          name: "Tagged media",
          description: "",
          sourceType: "tag",
        }),
      }),
    );
  });
});

describe("playlist bulk editing contract", () => {
  it("sends an authoring-level transition update to the static playlist endpoint", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { id: "playlist-1", items: [] } }),
    });
    vi.stubGlobal("fetch", fetch);

    await api.bulkUpdatePlaylistItems(
      "playlist-1",
      { transition: "crossfade" },
      "csrf-token",
    );

    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/playlists/playlist-1/items/bulk",
      expect.objectContaining({
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": "csrf-token",
        },
        body: JSON.stringify({ transition: "crossfade" }),
      }),
    );
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
