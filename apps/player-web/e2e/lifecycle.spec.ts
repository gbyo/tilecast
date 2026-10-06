import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test, type Page } from "@playwright/test";
import {
  backend,
  freshLimits,
  colorImage,
  expectPixel,
  hex,
  launch,
  sessionOf,
  sha256Hex,
  storage,
  Studio,
  type Launch,
} from "./support";

test.describe.configure({ mode: "serial" });
let studio: Studio;
test.beforeAll(async () => {
  await freshLimits();
  studio = await Studio.connect();
});
test.afterAll(async () => {
  await backend("start").catch(() => undefined);
  await studio.dispose();
});

const CENTER: [number, number] = [640, 360];
const RED = hex("FF0000");
const GREEN = hex("00FF00");

async function schedule(
  playlistId: string,
  screenId: string,
  startsInMs: number,
) {
  const iso = (offset: number) => new Date(Date.now() + offset).toISOString();
  await studio.call("post", "/api/v1/schedules", {
    name: `Scheduled ${playlistId.slice(0, 8)}`,
    description: "",
    playlistId,
    type: "one_time",
    timezone: "UTC",
    priority: 100,
    enabled: true,
    oneTimeStart: iso(startsInMs),
    oneTimeEnd: iso(startsInMs + 3_600_000),
    targets: [{ type: "screen", id: screenId }],
  });
}

async function playlistOf(name: string, hexColor: string) {
  const asset = await studio.uploadAsset(
    colorImage(name, hexColor),
    "image/png",
  );
  return {
    asset,
    playlist: await studio.playlist(name, [
      { assetId: asset, durationMs: 5_000 },
    ]),
    file: colorImage(name, hexColor),
  };
}

test("prepares exactly the selected closure and serves it only through activation grants", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const slot = await studio.createSlot();
  const selected = await playlistOf("selected", "FF0000");
  const later = await playlistOf("later", "00FF00");
  await launch(page, slot);
  await studio.assign(slot.screenId, { playlistId: selected.playlist });
  // A future schedule puts the other playlist's media in the manifest.
  await schedule(later.playlist, slot.screenId, 3_600_000);
  await expectPixel(page, CENTER, RED);

  const manifest = await page.evaluate(
    async (id) =>
      (
        await (
          await fetch("/api/v1/player/manifest", {
            headers: { "X-Tilecast-Player-Slot": id },
          })
        ).json()
      ).data.assets.map((asset: { assetId: string }) => asset.assetId),
    slot.id,
  );
  expect(manifest).toEqual(
    expect.arrayContaining([selected.asset, later.asset]),
  );

  const stored = await storage(page);
  const selectedDigest = sha256Hex(readFileSync(selected.file));
  const laterDigest = sha256Hex(readFileSync(later.file));
  const activation = stored.activations[0]!;
  expect(activation.resources.map((resource) => resource.assetId)).toEqual([
    selected.asset,
  ]);
  // Verified bytes of the selected content only; nothing for the other playlist.
  expect(stored.files).toEqual([selectedDigest]);
  expect(stored.objects.map((object) => object.digest)).toEqual([
    selectedDigest,
  ]);
  expect(stored.files).not.toContain(laterDigest);
  expect(stored.objects[0]!.pins).toEqual([`active:${slot.id}`]);

  // The service worker serves the committed object, exactly and by range.
  const uri = activation.plugins.media!.find(
    (media) => media.assetId === selected.asset,
  )!.uri;
  const bytes = readFileSync(selected.file);
  const probe = (init?: RequestInit, target = uri) =>
    page.evaluate(
      async ([path, request]) => {
        const response = await fetch(path as string, request as RequestInit);
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          length: (await response.arrayBuffer()).byteLength,
        };
      },
      [target, init ?? {}] as const,
    );
  const whole = await page.evaluate(async (path) => {
    const buffer = new Uint8Array(await (await fetch(path)).arrayBuffer());
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
  }, uri);
  expect(whole).toBe(selectedDigest);
  const head = await probe({ method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.headers["content-length"]).toBe(String(bytes.length));
  expect(head.headers["accept-ranges"]).toBe("bytes");
  expect(head.headers["x-content-type-options"]).toBe("nosniff");
  expect(head.headers["cache-control"]).toBe("no-store");
  const ranged = await probe({ headers: { Range: "bytes=0-9" } });
  expect(ranged).toMatchObject({ status: 206, length: 10 });
  expect(ranged.headers["content-range"]).toBe(`bytes 0-9/${bytes.length}`);
  const suffix = await probe({ headers: { Range: "bytes=-4" } });
  expect(suffix.status).toBe(206);
  expect(suffix.length).toBe(4);
  const invalid = await probe({ headers: { Range: `bytes=${bytes.length}-` } });
  expect(invalid.status).toBe(416);
  expect(invalid.headers["content-range"]).toBe(`bytes */${bytes.length}`);
  expect((await probe({ method: "POST" })).status).toBe(405);

  // Bytes in OPFS without a grant are unreachable, even for a guessed URI.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle("tilecast-media-v1", {
      create: true,
    });
    const handle = await directory.getFileHandle("f".repeat(64), {
      create: true,
    });
    const writable = await handle.createWritable();
    await writable.write("not an activation resource");
    await writable.close();
  });
  const forged = `/player/media/${activation.generation}/${crypto.randomUUID()}`;
  expect((await probe(undefined, forged)).status).toBe(404);
  expect(
    (
      await probe(
        undefined,
        `/player/media/1/${"f".repeat(8)}-0000-4000-8000-000000000000`,
      )
    ).status,
  ).toBe(404);

  // A new activation revokes the previous activation's URIs.
  await studio.assign(slot.screenId, { playlistId: later.playlist });
  await page.evaluate(() => dispatchEvent(new Event("online")));
  await expectPixel(page, CENTER, GREEN);
  expect((await probe(undefined, uri)).status).toBe(404);
  const next = await storage(page);
  // The previous activation's unpinned object remains until eviction needs it.
  expect(next.activations[0]!.generation).toBeGreaterThan(
    activation.generation,
  );
  expect(
    next.activations[0]!.resources.map((resource) => resource.assetId),
  ).toEqual([later.asset]);
});

test("a restarted browser continues its last activation while the server is down, then follows the server", async () => {
  test.setTimeout(240_000);
  const slot = await studio.createSlot();
  const first = await playlistOf("offline-first", "FF0000");
  const second = await playlistOf("offline-second", "00FF00");
  const userData = mkdtempSync(join(tmpdir(), "tilecast-browser-profile-"));
  const open = () =>
    chromium.launchPersistentContext(userData, {
      ignoreHTTPSErrors: true,
      args: ["--ignore-certificate-errors"],
      viewport: { width: 1280, height: 720 },
      baseURL: "https://localhost:18981",
    });
  try {
    let context = await open();
    let page = context.pages()[0] ?? (await context.newPage());
    await launch(page, slot);
    await studio.assign(slot.screenId, { playlistId: first.playlist });
    await expectPixel(page, CENTER, RED);
    // The server will select the second playlist while the browser is offline.
    const startsAt = Date.now() + 45_000;
    await schedule(second.playlist, slot.screenId, 45_000);
    const before = await storage(page);
    expect(before.activations).toHaveLength(1);
    await context.close();

    await backend("stop");
    context = await open();
    page = context.pages()[0] ?? (await context.newPage());
    const apiFailures: string[] = [];
    // A stopped server answers through the proxy with a gateway error.
    page.on("response", (response) => {
      if (response.url().includes("/api/v1/") && response.status() >= 500)
        apiFailures.push(response.url());
    });
    page.on("requestfailed", (request) => {
      if (request.url().includes("/api/v1/")) apiFailures.push(request.url());
    });
    // No fragment, no server, no cookie exchange: only what the browser kept.
    await page.goto(`/player/${slot.id}`);
    await expectPixel(page, CENTER, RED, { timeout: 60_000 });
    const restored = await storage(page);
    expect(restored.activations[0]!.activationId).toBe(
      before.activations[0]!.activationId,
    );

    // The server's schedule moves to the second playlist. Offline, the browser
    // evaluates no schedule and keeps showing the last committed activation.
    await page.waitForTimeout(Math.max(0, startsAt - Date.now()) + 8_000);
    await expectPixel(page, CENTER, RED);
    expect(apiFailures.length).toBeGreaterThan(0);

    await backend("start");
    await page.evaluate(() => dispatchEvent(new Event("online")));
    await expectPixel(page, CENTER, GREEN, { timeout: 60_000 });
    expect((await sessionOf(page, slot.id)).status).toBe(200);
    const after = await storage(page);
    expect(
      after.activations[0]!.resources.map((resource) => resource.assetId),
    ).toEqual([second.asset]);
    await context.close();
  } finally {
    await backend("start").catch(() => undefined);
    rmSync(userData, { recursive: true, force: true });
  }
});

test("a browser whose binding the server withdrew stops trusting its local activation", async () => {
  test.setTimeout(180_000);
  const slot = await studio.createSlot();
  const content = await playlistOf("withdrawn", "FF0000");
  const userData = mkdtempSync(join(tmpdir(), "tilecast-browser-profile-"));
  const open = () =>
    chromium.launchPersistentContext(userData, {
      ignoreHTTPSErrors: true,
      args: ["--ignore-certificate-errors"],
      viewport: { width: 1280, height: 720 },
      baseURL: "https://localhost:18981",
    });
  try {
    let context = await open();
    let page = context.pages()[0] ?? (await context.newPage());
    await launch(page, slot);
    await studio.assign(slot.screenId, { playlistId: content.playlist });
    await expectPixel(page, CENTER, RED);
    await studio.revoke(slot.screenId);
    await page.reload();
    await expect(
      page.getByText("Browser Player disconnected", { exact: true }),
    ).toBeVisible({
      timeout: 30_000,
    });
    const stored = await storage(page);
    expect(stored.activations).toEqual([]);
    expect(stored.grants).toEqual([]);
    expect(stored.objects.flatMap((object) => object.pins)).toEqual([]);
    await context.close();

    // Offline afterwards, nothing withdrawn can come back.
    await backend("stop");
    context = await open();
    page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`/player/${slot.id}`);
    await expect(
      page.getByText("Waiting for the Tilecast server", { exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1_500);
    expect(await storage(page).then((value) => value.activations)).toEqual([]);
    await context.close();
  } finally {
    await backend("start").catch(() => undefined);
    rmSync(userData, { recursive: true, force: true });
  }
});

test("one tab owns a slot, and its loss lets a later tab take over", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const slot: Launch = await studio.createSlot();
  await launch(page, slot);
  const other: Page = await context.newPage();
  const traffic: string[] = [];
  other.on("request", (request) => {
    if (request.url().includes("/api/v1/player/")) traffic.push(request.url());
  });
  await other.goto(`/player/${slot.id}`);
  await expect(
    other.getByText(
      "This Browser Player is already running in another window.",
      { exact: true },
    ),
  ).toBeVisible();
  // The second tab never reports as the Player.
  await other.waitForTimeout(1_500);
  expect(traffic).toEqual([]);
  // The browser releases a Web Lock whenever its owner goes away, however it
  // goes. A closed owner lets a reloaded tab take over.
  await page.close({ runBeforeUnload: false });
  await other.reload();
  await expect(
    other.getByText("No content assigned", { exact: true }),
  ).toBeVisible({
    timeout: 30_000,
  });
  // So does an owner that is navigated away without any cleanup.
  const third = await context.newPage();
  await third.goto(`/player/${slot.id}`);
  await expect(
    third.getByText(
      "This Browser Player is already running in another window.",
      { exact: true },
    ),
  ).toBeVisible();
  await other.goto("about:blank");
  await third.reload();
  await expect(
    third.getByText("No content assigned", { exact: true }),
  ).toBeVisible({
    timeout: 30_000,
  });
});
