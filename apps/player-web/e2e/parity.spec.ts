// Representative presentations through the real server, the Browser Host and the
// one production Runtime. Colors, text and timing are asserted from what is
// actually on screen, so a host that altered Runtime output would fail here.
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  colorImage,
  colorVideo,
  freshLimits,
  expectPixel,
  hex,
  launch,
  pixel,
  Studio,
  type RGB,
} from "./support";

test.describe.configure({ mode: "serial" });
let studio: Studio;
test.beforeAll(async () => {
  await freshLimits();
  studio = await Studio.connect();
});
test.afterAll(async () => {
  await studio.dispose();
});

const CENTER: [number, number] = [640, 360];
const RED = hex("FF0000");
const GREEN = hex("00FF00");
const BLUE = hex("0000FF");

/** A Screen that has reported capabilities, so the server accepts content for it. */
async function screen(page: Page) {
  const slot = await studio.createSlot();
  await launch(page, slot);
  return slot;
}
const image = (name: string, color: string) =>
  studio.uploadAsset(colorImage(name, color), "image/png");

const near = (a: RGB, b: RGB, tolerance = 14) =>
  a.every((value, index) => Math.abs(value - b[index]!) <= tolerance);

test("idle and status surface use the accepted configuration, not host copy", async ({
  page,
}) => {
  await screen(page);
  // The Server's configured wording and the shared Runtime surface.
  await expect(
    page.getByText("No content assigned", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("This screen is ready for content."),
  ).toBeVisible();
  await expectPixel(page, [20, 20], hex("0E141B"), { tolerance: 6 });
});

test("an image fills the stage", async ({ page }) => {
  const slot = await screen(page);
  const asset = await image("parity-red", "FF0000");
  await studio.assign(slot.screenId, {
    playlistId: await studio.playlist("Image", [
      { assetId: asset, durationMs: 4_000 },
    ]),
  });
  await expectPixel(page, CENTER, RED);
  await expectPixel(page, [5, 5], RED);
  await expectPixel(page, [1274, 714], RED);
});

test("playlist items change on their authored durations", async ({ page }) => {
  test.setTimeout(120_000);
  const slot = await screen(page);
  const red = await image("parity-red", "FF0000");
  const green = await image("parity-green", "00FF00");
  await studio.assign(slot.screenId, {
    playlistId: await studio.playlist("Rotation", [
      { assetId: red, durationMs: 2_500 },
      { assetId: green, durationMs: 2_500 },
    ]),
  });
  await expectPixel(page, CENTER, RED);
  // Sample the screen and measure how long each item stays up.
  const timeline: { color: "red" | "green" | "other"; at: number }[] = [];
  const started = Date.now();
  while (Date.now() - started < 11_000) {
    const sample = await pixel(page, ...CENTER);
    const color = near(sample, RED)
      ? "red"
      : near(sample, GREEN)
        ? "green"
        : "other";
    if (timeline.at(-1)?.color !== color)
      timeline.push({ color, at: Date.now() });
    await page.waitForTimeout(80);
  }
  const solid = timeline.filter((entry) => entry.color !== "other");
  expect(solid.map((entry) => entry.color).slice(0, 3)).toEqual(
    solid[0]!.color === "red"
      ? ["red", "green", "red"]
      : ["green", "red", "green"],
  );
  // The first segment began before sampling did. Every later complete segment
  // lasts the authored duration, within sampling tolerance.
  const durations = solid
    .slice(0, -1)
    .map((entry, index) => solid[index + 1]!.at - entry.at);
  expect(durations.length).toBeGreaterThanOrEqual(3);
  for (const duration of durations.slice(1, 3)) {
    expect(duration).toBeGreaterThan(1_900);
    expect(duration).toBeLessThan(3_300);
  }
});

test("a video plays from the verified local copy", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("about:blank");
  const h264 = await page.evaluate(
    () =>
      document
        .createElement("video")
        .canPlayType('video/mp4; codecs="avc1.42E01E"') !== "",
  );
  test.skip(!h264, "This Chromium build cannot decode H.264");
  const slot = await screen(page);
  const video = await studio.uploadAsset(
    colorVideo("parity-blue", "0000FF", 8),
    "video/mp4",
  );
  await studio.assign(slot.screenId, {
    playlistId: await studio.playlist("Video", [
      { assetId: video, durationMs: 20_000 },
    ]),
  });
  await expectPixel(page, CENTER, BLUE, { tolerance: 40 });
  const element = page.locator("video").first();
  await expect(element).toHaveCount(1);
  const first = await element.evaluate(
    (node: HTMLVideoElement) => node.currentTime,
  );
  await page.waitForTimeout(1_500);
  const second = await element.evaluate(
    (node: HTMLVideoElement) => node.currentTime,
  );
  expect(second).toBeGreaterThan(first);
  // It plays the activation-bound local object, never the network.
  expect(
    await element.evaluate((node: HTMLVideoElement) => node.currentSrc),
  ).toMatch(/\/player\/media\/\d+\/[a-f0-9-]{36}$/);
});

test("a Layout composes an asset zone and a native text element", async ({
  page,
}) => {
  const slot = await screen(page);
  const green = await image("parity-green", "00FF00");
  const layout = await studio.layout(
    "Split",
    { width: 1280, height: 720, backgroundColor: "#000000" },
    [
      {
        id: randomUUID(),
        type: "asset",
        name: "Panel",
        x: 0,
        y: 0,
        width: 640,
        height: 720,
        layer: 1,
        opacity: 1,
        visible: true,
        locked: false,
        assetId: green,
      },
      {
        id: randomUUID(),
        type: "primitive",
        name: "Banner",
        x: 640,
        y: 0,
        width: 640,
        height: 720,
        layer: 2,
        opacity: 1,
        visible: true,
        locked: false,
        primitive: {
          kind: "text",
          text: "Go Falcons",
          fontSize: 64,
          fontWeight: 700,
          textAlign: "center",
          verticalAlign: "middle",
          color: "#FFFFFF",
          backgroundColor: "#6B1E2E",
        },
      },
    ],
  );
  await studio.assign(slot.screenId, { layoutId: layout });
  await expectPixel(page, [320, 360], GREEN);
  // The text element takes its own height at the top of its zone.
  await expectPixel(page, [1200, 30], hex("6B1E2E"), { tolerance: 8 });
  await expectPixel(page, [900, 400], [0, 0, 0], { tolerance: 4 });
  await expect(page.getByText("Go Falcons")).toBeVisible();
});

test("component Widgets render with the accepted configuration", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const slot = await screen(page);
  const text = await studio.widget("text", "Announcement", {
    heading: "Welcome",
    body: "Browser Player",
    style: "standard",
    align: "center",
    backgroundColor: "#6B1E2E",
    foregroundColor: "#FFFFFF",
  });
  const clock = await studio.widget("clock", "Clock", {
    mode: "time",
    timezone: "UTC",
    zones: [],
    dateFormat: "locale",
    format: "locale",
    showSeconds: false,
    style: "standard",
    showDate: false,
    backgroundColor: "#1E3A5F",
    foregroundColor: "#FFFFFF",
  });
  await studio.assign(slot.screenId, {
    playlistId: await studio.playlist("Widgets", [
      { assetId: text, durationMs: 5_000 },
      { assetId: clock, durationMs: 5_000 },
    ]),
  });
  await expectPixel(page, [10, 10], hex("6B1E2E"), { tolerance: 8 });
  await expect(page.getByText("Welcome")).toBeVisible();
  // The second Widget follows on its own duration.
  await expectPixel(page, [10, 10], hex("1E3A5F"), {
    tolerance: 8,
    timeout: 20_000,
  });
  await expect(page.getByText(/\d{1,2}:\d{2}/).first()).toBeVisible();
});

test("expiring content ends in the branded unavailable surface at its boundary", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const slot = await screen(page);
  const red = await image("parity-red", "FF0000");
  await studio.assign(slot.screenId, {
    playlistId: await studio.playlist("Expiring", [
      { assetId: red, durationMs: 4_000 },
    ]),
  });
  await expectPixel(page, CENTER, RED);
  // The asset's availability window closes shortly. The Host planned against
  // the boundary the resolver reported, not against a timer of its own.
  await studio.call("patch", `/api/v1/assets/${red}`, {
    availabilitySet: true,
    expiresAt: new Date(Date.now() + 15_000).toISOString(),
  });
  await expect(
    page.getByText("Content unavailable", { exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await expectPixel(page, [20, 20], hex("0E141B"), { tolerance: 6 });
});

test("an emergency takeover replaces the schedule and ends when cancelled", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const slot = await screen(page);
  const base = await image("parity-red", "FF0000");
  const urgent = await image("parity-blue", "0000FF");
  await studio.assign(slot.screenId, {
    playlistId: await studio.playlist("Everyday", [
      { assetId: base, durationMs: 5_000 },
    ]),
  });
  await expectPixel(page, CENTER, RED);
  const takeover = await studio.takeover(
    slot.screenId,
    await studio.playlist("Urgent", [{ assetId: urgent, durationMs: 5_000 }]),
  );
  await page.evaluate(() => dispatchEvent(new Event("online")));
  await expectPixel(page, CENTER, BLUE, { timeout: 45_000 });
  await studio.call(
    "post",
    `/api/v1/takeovers/${takeover.id}/cancel`,
    {},
    [200, 204],
  );
  await page.evaluate(() => dispatchEvent(new Event("online")));
  await expectPixel(page, CENTER, RED, { timeout: 45_000 });
});
