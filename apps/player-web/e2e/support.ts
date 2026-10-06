import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expect,
  request,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import sharp from "sharp";

export const origin = "https://localhost:18981";
const control = "http://127.0.0.1:18983";

export interface Launch {
  id: string;
  screenId: string;
  recoverySecret: string;
}

/** Operates the real server the way an Administrator in Studio would. */
export class Studio {
  private constructor(
    readonly api: APIRequestContext,
    readonly csrf: string,
  ) {}

  /**
   * Every spec file shares one server. The first sets the organization up and
   * the rest sign in as the same Owner.
   */
  static async connect(): Promise<Studio> {
    const api = await request.newContext({
      baseURL: origin,
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: { Origin: origin },
    });
    const credentials = {
      username: "browser-test",
      password: "browser player end to end owner password",
    };
    const setup = await api.post("/api/v1/auth/setup", {
      data: {
        organizationName: "Browser qualification",
        ownerName: "Test owner",
        ...credentials,
      },
    });
    if (setup.status() === 201)
      return new Studio(api, (await setup.json()).data.csrfToken as string);
    expect(setup.status(), await setup.text()).toBe(409);
    const login = await api.post("/api/v1/auth/login", { data: credentials });
    expect(login.status(), await login.text()).toBe(200);
    return new Studio(api, (await login.json()).data.csrfToken as string);
  }

  dispose(): Promise<void> {
    return this.api.dispose();
  }

  async call<T = unknown>(
    method: "get" | "post" | "put" | "patch" | "delete",
    path: string,
    data?: unknown,
    expected: number[] = [200, 201, 204],
  ): Promise<T> {
    const response = await this.api[method](path, {
      headers: { "X-CSRF-Token": this.csrf },
      ...(data === undefined ? {} : { data }),
    });
    expect(
      expected,
      `${method.toUpperCase()} ${path}: ${response.status()} ${await response.text()}`,
    ).toContain(response.status());
    return (
      response.status() === 204 ? undefined : (await response.json()).data
    ) as T;
  }

  createSlot(name = "Browser qualification"): Promise<Launch> {
    return this.call("post", "/api/v1/screens/browser", {
      name,
      roomName: "Test room",
      roomNumber: "1",
      description: "Ephemeral browser test",
    });
  }

  /** Administrator Revoke pairing: the permanent end of a Browser Screen. */
  revoke(screenId: string): Promise<void> {
    return this.call("post", `/api/v1/screens/${screenId}/revoke`, {
      reason: "Retired in test",
    });
  }

  /**
   * The server accepts content only for a Player that has reported compatible
   * presentation capabilities, so a Browser Screen must have sent a heartbeat.
   */
  async assign(
    screenId: string,
    target: { playlistId: string } | { layoutId: string },
  ) {
    await expect
      .poll(
        async () =>
          (
            await this.api.put(
              `/api/v1/screens/${screenId}/playlist-assignment`,
              {
                headers: { "X-CSRF-Token": this.csrf },
                data: target,
              },
            )
          ).status(),
        { timeout: 30_000, message: "the Player's reported capabilities" },
      )
      .toBe(200);
  }

  async uploadAsset(file: string, mimeType: string): Promise<string> {
    const body = readFileSync(file);
    const upload = await this.call<{ id: string }>("post", "/api/v1/uploads", {
      filename: file.split("/").pop(),
      mimeType,
      sizeBytes: body.length,
    });
    const chunk = await this.api.patch(`/api/v1/uploads/${upload.id}`, {
      headers: {
        "X-CSRF-Token": this.csrf,
        "Upload-Offset": "0",
        "Content-Type": "application/offset+octet-stream",
      },
      data: body,
    });
    expect(chunk.status(), await chunk.text()).toBe(204);
    const asset = await this.call<{ id: string }>(
      "post",
      `/api/v1/uploads/${upload.id}/complete`,
    );
    await expect
      .poll(
        async () =>
          (
            await this.call<{ processingStatus: string }>(
              "get",
              `/api/v1/assets/${asset.id}`,
            )
          ).processingStatus,
        { timeout: 60_000, message: "asset processing" },
      )
      .toBe("ready");
    return asset.id;
  }

  async widget(
    provider: string,
    name: string,
    configuration: object,
  ): Promise<string> {
    return (
      await this.call<{ id: string }>("post", "/api/v1/widgets", {
        provider,
        name,
        description: "",
        configuration,
      })
    ).id;
  }

  /** Creates, saves and publishes a Layout, returning its ID. */
  async layout(
    name: string,
    canvas: { width: number; height: number; backgroundColor: string },
    placements: object[],
  ): Promise<string> {
    const created = await this.call<{ id: string; draftRevision: number }>(
      "post",
      "/api/v1/layouts",
      {
        name,
        description: "",
        orientation: "landscape",
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
      },
    );
    const saved = await this.call<{ draftRevision: number }>(
      "put",
      `/api/v1/layouts/${created.id}/draft`,
      {
        expectedDraftRevision: created.draftRevision,
        document: {
          schemaVersion: 2,
          canvas: {
            ...canvas,
            orientation: "landscape",
            safeAreaPercent: 0,
          },
          placements,
        },
      },
    );
    await this.call(
      "post",
      `/api/v1/layouts/${created.id}/publish`,
      { expectedDraftRevision: saved.draftRevision },
      [200, 201],
    );
    return created.id;
  }

  /** An emergency takeover of one Screen. Cancelling it ends the takeover. */
  async takeover(screenId: string, playlistId: string, minutes = 10) {
    return this.call<{ id: string }>("post", "/api/v1/takeovers", {
      name: "Browser qualification takeover",
      description: "",
      playlistId,
      screenIds: [screenId],
      expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
    });
  }

  async playlist(
    name: string,
    items: {
      assetId?: string;
      layoutId?: string;
      durationMs: number;
      transition?: string;
    }[],
  ): Promise<string> {
    const playlist = await this.call<{ id: string; draftRevision?: number }>(
      "post",
      "/api/v1/playlists",
      { name, description: "", sourceType: "static" },
    );
    for (const item of items)
      await this.call("post", `/api/v1/playlists/${playlist.id}/items`, item);
    const current = await this.call<{
      draftRevision?: number;
      revision?: number;
    }>("get", `/api/v1/playlists/${playlist.id}`);
    await this.call(
      "post",
      `/api/v1/playlists/${playlist.id}/publish`,
      { expectedDraftRevision: current.draftRevision ?? current.revision ?? 1 },
      [200, 201],
    );
    return playlist.id;
  }
}

/** Stops or starts the real server process. Data and media stay. */
export async function backend(action: "stop" | "start"): Promise<void> {
  const response = await fetch(`${control}/backend/${action}`, {
    method: "POST",
  });
  expect(response.status, await response.text()).toBe(200);
}

/**
 * Restarts the server so its in-memory authentication rate limits begin empty.
 * The limits are a security control and are never loosened for tests.
 */
export async function freshLimits(): Promise<void> {
  await backend("stop");
  await backend("start");
}

const mediaDirectory = join(tmpdir(), "tilecast-browser-e2e-media");
/** A deterministic solid-color image, made by the same FFmpeg the server uses. */
export function colorImage(
  name: string,
  hex: string,
  width = 1280,
  height = 720,
): string {
  mkdirSync(mediaDirectory, { recursive: true });
  const file = join(mediaDirectory, `${name}-${hex}-${width}x${height}.png`);
  if (!existsSync(file) || statSync(file).size === 0)
    execFileSync("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=0x${hex}:s=${width}x${height}`,
      "-frames:v",
      "1",
      file,
    ]);
  return file;
}

/** A solid-color clip with a monotonically increasing frame counter overlay-free. */
export function colorVideo(name: string, hex: string, seconds = 6): string {
  mkdirSync(mediaDirectory, { recursive: true });
  const file = join(mediaDirectory, `${name}-${hex}-${seconds}.mp4`);
  if (!existsSync(file) || statSync(file).size === 0)
    execFileSync("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=0x${hex}:s=640x360:r=24:d=${seconds}`,
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "libx264",
      "-g",
      "24",
      "-movflags",
      "+faststart",
      file,
    ]);
  return file;
}

export async function launch(
  page: Page,
  slot: Launch,
  ready = true,
): Promise<void> {
  page.on("pageerror", (error) =>
    console.error("Browser Host error:", error.message),
  );
  await page.goto(`/player/${slot.id}#r=${slot.recoverySecret}`);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
  await expect(page.locator("tc-player")).toBeVisible();
  if (ready)
    await expect(
      page.getByText("No content assigned", { exact: true }),
    ).toBeVisible();
}

export async function sessionOf(page: Page, slotId: string) {
  return page.evaluate(async (slot) => {
    const response = await fetch("/api/v1/player/browser/session", {
      headers: { "X-Tilecast-Player-Slot": slot },
    });
    return { status: response.status, body: await response.json() };
  }, slotId);
}

export type RGB = [number, number, number];

/** One pixel of the page as the user sees it. */
export async function pixel(page: Page, x: number, y: number): Promise<RGB> {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  const { data } = await sharp(png)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return [data[0]!, data[1]!, data[2]!];
}

const near = (a: RGB, b: RGB, tolerance: number) =>
  a.every((value, index) => Math.abs(value - b[index]!) <= tolerance);

export async function expectPixel(
  page: Page,
  at: [number, number],
  color: RGB,
  options: { tolerance?: number; timeout?: number } = {},
): Promise<void> {
  await expect
    .poll(
      async () =>
        near(await pixel(page, ...at), color, options.tolerance ?? 12),
      {
        timeout: options.timeout ?? 30_000,
        message: `pixel ${at} to become ${color}`,
      },
    )
    .toBe(true);
}

export const hex = (value: string): RGB => [
  parseInt(value.slice(0, 2), 16),
  parseInt(value.slice(2, 4), 16),
  parseInt(value.slice(4, 6), 16),
];

/** What the Browser Host persisted, read through the page's own storage. */
export async function storage(page: Page) {
  return page.evaluate(async () => {
    const open = () =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("tilecast-browser-player-v1");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const all = (db: IDBDatabase, store: string, keys = false) =>
      new Promise<unknown[]>((resolve) => {
        const request = keys
          ? db.transaction(store).objectStore(store).getAllKeys()
          : db.transaction(store).objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result as unknown[]);
      });
    const db = await open();
    const activations = (await all(db, "activations")) as {
      slotId: string;
      generation: number;
      activationId: string;
      resources: { digest: string; assetId: string }[];
      plugins: { media?: { assetId: string; uri: string }[] };
    }[];
    const grants = await all(db, "grants", true);
    const objects = (await all(db, "objects")) as {
      digest: string;
      pins: string[];
    }[];
    const identity = JSON.stringify(await all(db, "identity"));
    db.close();
    const root = await navigator.storage.getDirectory();
    const files: string[] = [];
    try {
      const directory = await root.getDirectoryHandle("tilecast-media-v1");
      for await (const name of (
        directory as unknown as { keys(): AsyncIterable<string> }
      ).keys())
        files.push(name);
    } catch {
      /* No media committed yet. */
    }
    return {
      activations,
      grants: grants as string[],
      objects,
      identity,
      files,
    };
  });
}

export const sha256Hex = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
