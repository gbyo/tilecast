import { createHash } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeSupportV1 } from "@tilecast/player-runtime/host-contract";
import { PlayerAPI } from "./api";
import { reconcileSelection, type ReconcileMemory } from "./reconcile";
import { openDatabase } from "./storage/database";
import { IndexedObjects } from "./storage/index";
import { activeGrant, loadActivation } from "./storage/activation";
import { memoryStore } from "./test-support/memory-store";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const bytes = (n: number) => `asset ${n} bytes`;
const digestOf = (n: number) =>
  createHash("sha256").update(bytes(n)).digest("hex");
const asset = (n: number, mimeType = "image/png", windows = {}) => ({
  ...windows,
  assetId: id(n),
  variantId: id(n + 100),
  mimeType,
  sha256: digestOf(n),
  fileSize: bytes(n).length,
  downloadPath: `/api/v1/player/assets/${id(n)}/variants/${id(n + 100)}`,
});
const item = (n: number) => ({
  id: id(n + 200),
  assetId: id(n),
  variantId: id(n + 100),
  assetType: "image",
  fitMode: "contain",
  transition: "none",
  audioEnabled: false,
  volume: 0,
  deliveryPolicy: "download",
});
const PLAYLIST_A = id(901);
const PLAYLIST_B = id(902);
const clock = { ms: Date.now() };
type Windows = Record<number, { availableFrom?: string; expiresAt?: string }>;
const manifest = (version = 1, windows: Windows = {}) => ({
  schemaVersion: 17,
  manifestVersion: version,
  screenId: id(1),
  generatedAt: "2026-10-01T00:00:00Z",
  mode: "presentation",
  serverTime: new Date(clock.ms).toISOString(),
  schedules: [],
  websites: [],
  widgets: [],
  dataSources: [],
  layouts: [],
  plugins: [],
  // Eight assets are in the manifest. A Screen shows one playlist at a time.
  assets: [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
    asset(n, "image/png", windows[n] ?? {}),
  ),
  playlists: [
    { id: PLAYLIST_A, revision: 1, name: "A", items: [item(1), item(2)] },
    { id: PLAYLIST_B, revision: 1, name: "B", items: [item(3), item(4)] },
  ],
});

const FRAME_BODY = "<!doctype html><html><body>scores</body></html>";
const FRAME_DIGEST = createHash("sha256").update(FRAME_BODY).digest("hex");
const FRAME_PACKAGE = "e".repeat(64);
const WIDGET_ASSET = id(500);
const PLAYLIST_WIDGET = id(903);
const FRAME_PATH =
  "/api/v1/player/packages/acme.athletics/widgets/scoreboard/frame";
const frameSupport: RuntimeSupportV1 = {
  presentationSchemas: [3],
  declarativeCapabilities: {},
  widgetComponents: { "widget.external-runtime": 2 },
};
const widgetManifest = (): Record<string, unknown> => {
  const base = manifest(1);
  return {
    ...base,
    widgets: [
      {
        assetId: WIDGET_ASSET,
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
              digest: `sha256:${FRAME_PACKAGE}`,
              frame: {
                sha256: FRAME_DIGEST,
                fileSize: FRAME_BODY.length,
                downloadPath: FRAME_PATH,
              },
            },
          },
        },
      },
    ],
    playlists: [
      ...base.playlists,
      {
        id: PLAYLIST_WIDGET,
        revision: 1,
        name: "Widget",
        items: [
          {
            id: id(950),
            assetId: WIDGET_ASSET,
            variantId: null,
            assetType: "widget",
            fitMode: "contain",
            transition: "none",
            audioEnabled: false,
            volume: 0,
            deliveryPolicy: "download",
          },
        ],
      },
    ],
  };
};

function server(
  selectedPlaylist: string | null,
  windows: Windows = {},
  manifestOverride?: Record<string, unknown>,
) {
  const downloads: string[] = [];
  let current = selectedPlaylist;
  let failing: string | undefined;
  const transport = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://signage.example.org");
    const path = url.pathname;
    const ok = (data: unknown) =>
      new Response(JSON.stringify({ data }), { status: 200 });
    if (path === "/api/v1/player/manifest")
      return ok(manifestOverride ?? manifest(1, windows));
    if (path === "/api/v1/player/config")
      return ok({
        configRevision: 1,
        branding: {},
        playback: {},
        website: {},
        cache: {},
      });
    if (path === "/api/v1/player/browser/selection")
      return ok({
        at: new Date(clock.ms).toISOString(),
        current: current
          ? {
              selected: {
                source: "assignment",
                contentType: "playlist",
                contentId: current,
              },
            }
          : {},
      });
    downloads.push(path);
    if (failing && path.includes(failing))
      return new Response("nope", { status: 500 });
    if (path === FRAME_PATH) return new Response(FRAME_BODY, { status: 200 });
    const n = [1, 2, 3, 4, 5, 6, 7, 8].find((value) =>
      path.includes(id(value)),
    )!;
    return new Response(bytes(n), { status: 200 });
  }) as typeof fetch;
  return {
    api: new PlayerAPI(transport),
    downloads,
    select: (value: string | null) => (current = value),
    fail: (value: string | undefined) => (failing = value),
  };
}

async function setup(
  selectedPlaylist: string | null,
  windows: Windows = {},
  manifestOverride?: Record<string, unknown>,
  support?: RuntimeSupportV1,
) {
  clock.ms = Date.now();
  const database = await openDatabase(new IDBFactory());
  const memory = memoryStore();
  const remote = server(selectedPlaylist, windows, manifestOverride);
  const index = new IndexedObjects(database);
  const reconcileMemory: ReconcileMemory = {
    key: "",
    generation: 0,
    validUntilMs: null,
    clockOffsetMs: 0,
  };
  const reconcile = () =>
    reconcileSelection(
      {
        api: remote.api,
        database,
        files: memory.files,
        index,
        binding: {
          slotId: "slot",
          bindingId: "binding",
          serverInstallationId: "server",
        },
        support: () => support,
        signal: new AbortController().signal,
        storeOptions: {},
        exclusively: (run) => run(),
        now: () => clock.ms,
      },
      reconcileMemory,
    );
  return { database, memory, remote, reconcile, memoryState: reconcileMemory };
}

beforeEach(() => {
  vi.stubGlobal("location", { origin: "https://signage.example.org" });
});

describe("exact-closure reconciliation", () => {
  it("downloads only the resources the selected content needs", async () => {
    const h = await setup(PLAYLIST_A);
    const result = await h.reconcile();
    expect(result.changed).toBe(true);
    expect(h.remote.downloads.sort()).toEqual(
      [1, 2].map(
        (n) => `/api/v1/player/assets/${id(n)}/variants/${id(n + 100)}`,
      ),
    );
    // Assets 3-8 are in the manifest and were never requested.
    expect(h.remote.downloads.some((path) => path.includes(id(3)))).toBe(false);
    const stored = [...h.memory.bytes.keys()];
    expect(stored.sort()).toEqual([digestOf(1), digestOf(2)].sort());
    const activation = await loadActivation(h.database, "slot");
    expect(
      activation?.resources.map((resource) => resource.digest).sort(),
    ).toEqual([digestOf(1), digestOf(2)].sort());
  });

  it("downloads, verifies and grants the frames a widget playlist needs", async () => {
    const h = await setup(PLAYLIST_WIDGET, {}, widgetManifest(), frameSupport);
    const result = await h.reconcile();
    expect(result.changed).toBe(true);
    expect(h.remote.downloads).toContain(FRAME_PATH);
    expect([...h.memory.bytes.keys()]).toContain(FRAME_DIGEST);
    const activation = await loadActivation(h.database, "slot");
    expect(activation?.frames?.map((frame) => frame.frameDigest)).toEqual([
      FRAME_DIGEST,
    ]);
    const table = activation?.presentation.projection?.widgetFrames;
    expect(table).toHaveLength(1);
    expect(table![0]).toMatchObject({
      packageId: "acme.athletics",
      packageDigest: `sha256:${FRAME_PACKAGE}`,
      frameDigest: FRAME_DIGEST,
    });
    expect(table![0]!.uri).toMatch(/^\/player\/widget-frame\/1\//);
    expect(await activeGrant(h.database, table![0]!.uri)).toMatchObject({
      kind: "frame",
      digest: FRAME_DIGEST,
    });
  });

  it("needs no download or activation when nothing changed", async () => {
    const h = await setup(PLAYLIST_A);
    await h.reconcile();
    const before = h.remote.downloads.length;
    expect((await h.reconcile()).changed).toBe(false);
    expect(h.remote.downloads.length).toBe(before);
  });

  it("prepares only new resources when the Server selects other content", async () => {
    const h = await setup(PLAYLIST_A);
    await h.reconcile();
    h.remote.downloads.length = 0;
    h.remote.select(PLAYLIST_B);
    const result = await h.reconcile();
    expect(result.changed).toBe(true);
    expect(h.remote.downloads.every((path) => !path.includes(id(1)))).toBe(
      true,
    );
    expect(h.remote.downloads).toHaveLength(2);
    expect((await loadActivation(h.database, "slot"))?.generation).toBe(2);
  });

  it("never replaces the last good activation with a partly prepared one", async () => {
    const h = await setup(PLAYLIST_A);
    await h.reconcile();
    const first = await loadActivation(h.database, "slot");
    h.remote.select(PLAYLIST_B);
    h.remote.fail(id(4));
    await expect(h.reconcile()).rejects.toThrow();
    const after = await loadActivation(h.database, "slot");
    expect(after?.activationId).toBe(first?.activationId);
    expect(h.memoryState.generation).toBe(1);
    // The failure is retried, and once the resource arrives the switch happens.
    h.remote.fail(undefined);
    expect((await h.reconcile()).changed).toBe(true);
  });

  it("shows branded no-content copy and requires no media when nothing is selected", async () => {
    const h = await setup(null);
    const result = await h.reconcile();
    expect(result.changed && result.plan.kind).toBe("idle");
    expect(h.remote.downloads).toEqual([]);
  });
});

describe("activation stability", () => {
  it("keeps the same activation when unrelated content becomes available", async () => {
    const opens = new Date(Date.now() + 60_000).toISOString();
    // Playlist A shows image 1 and 2. Playlist B, which is not selected, uses
    // image 3, which only becomes available in the future.
    const h = await setup(PLAYLIST_A, { 3: { availableFrom: opens } });
    const first = await h.reconcile();
    expect(first.changed).toBe(true);
    expect(first.plan.validUntil).toBeNull();
    const before = await loadActivation(h.database, "slot");
    clock.ms += 120_000;
    h.remote.downloads.length = 0;
    const second = await h.reconcile();
    expect(second.changed).toBe(false);
    expect(h.remote.downloads).toEqual([]);
    const after = await loadActivation(h.database, "slot");
    expect(after?.activationId).toBe(before?.activationId);
    expect(after?.generation).toBe(before?.generation);
  });

  it("plans again when the window of the selected content opens", async () => {
    const opens = new Date(Date.now() + 60_000).toISOString();
    const h = await setup(PLAYLIST_A, { 2: { availableFrom: opens } });
    const first = await h.reconcile();
    expect(first.changed).toBe(true);
    expect(first.plan.validUntil?.toISOString()).toBe(opens);
    clock.ms += 120_000;
    expect((await h.reconcile()).changed).toBe(true);
  });
});
