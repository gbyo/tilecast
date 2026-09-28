import { expect, test } from "@playwright/test";
import { ids, resetDemo } from "../support/demo";
import { snapshot } from "./support";

const hallwaySplit = "de300006-0000-4000-8000-000000000001";
const lobbyPortrait = "de300006-0000-4000-8000-000000000002";
const lobbyClock = "de30000a-0000-4000-8000-000000000009";

test.beforeEach(async ({ page }) => {
  await resetDemo(page.request);
  // Only Date is fixed. Network requests, timers and simulated players keep
  // running; this exercises the production renderer rather than a fake app.
  await page.clock.setFixedTime(new Date("2026-09-28T14:00:00Z"));
});

const states = [
  ["fleet", "/screens", "Cafeteria East"],
  [
    "screen-online",
    `/screens/${ids.cafeteriaEast}`,
    "Current playback, connection, and player reliability.",
  ],
  [
    "screen-stale",
    `/screens/${ids.boardRoom}`,
    "Current playback, connection, and player reliability.",
  ],
  [
    "screen-disabled",
    `/screens/${ids.middleSchoolHallway}`,
    "Current playback, connection, and player reliability.",
  ],
  ["playlists", "/playlists", "Morning Announcements"],
  ["playlist-editor", `/playlists/${ids.morningAnnouncements}`, "Add content"],
  ["layouts", "/layouts", "Hallway Split"],
  ["layout-editor", `/layouts/${hallwaySplit}`, "Go Falcons!"],
  ["content", "/assets", "Welcome Back, Falcons"],
  ["widgets", "/widgets", "Lobby Clock"],
  ["widget-editor", `/widgets/${lobbyClock}`, "Preview ready."],
  ["data-sources", "/data-sources", "No Data Sources yet"],
  ["schedules", "/schedules", "Morning Broadcast"],
  ["users", "/settings/users", "Marcus Reyes"],
  ["settings", "/settings/general", "Organization name"],
  ["plugins", "/plugins", "Countdown Bar"],
] as const;

for (const [name, path, ready] of states) {
  test(name, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByText(ready, { exact: true }).first()).toBeVisible();
    if (name === "widget-editor") {
      await page
        .getByRole("button", { name: "Small zone", exact: true })
        .click();
    }
    if (name.startsWith("screen-")) {
      // Simulated players have no captured image. Wait for the real panel,
      // including its metadata, rather than capturing the lazy-load fallback.
      await expect(
        page
          .getByRole("complementary", { name: "Live preview" })
          .getByText("Not captured", { exact: true }),
      ).toBeVisible();
    }
    await snapshot(page, name);
  });
}

test("overview", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Needs attention" }),
  ).toBeVisible();
  await snapshot(page, "overview", [
    page.locator(".recharts-wrapper"),
    page.getByRole("region", { name: "Fleet health" }).locator(".tabular-nums"),
    page.getByRole("button", { name: /^Per screen ·/ }).locator("span"),
  ]);
});

test("layout-widget-preview", async ({ page }) => {
  await page.goto(`/layouts/${lobbyPortrait}`);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(
    page.locator(".layout-preview-frame [data-tilecast-widget]"),
  ).toHaveCount(1);
  await expect(page.locator(".layout-preview-frame")).toBeInViewport({
    ratio: 1,
  });
  await expect
    .poll(() =>
      page
        .locator(".layout-preview-frame")
        .evaluate((frame) => frame.clientWidth / frame.clientHeight),
    )
    .toBeCloseTo(1080 / 1920, 2);
  await snapshot(page, "layout-widget-preview");
});

test("playlist-create-dialog", async ({ page }) => {
  await page.goto("/playlists?create=1");
  await expect(page.getByRole("dialog")).toBeVisible();
  await snapshot(page, "playlist-create-dialog");
});

test("activity", async ({ page }) => {
  await page.goto("/activity");
  await page.getByRole("tab", { name: "Proof of Play", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "Proof of Play", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await snapshot(page, "activity-proof-of-play");
});

for (const [name, path, ready] of [states[5], states[10]]) {
  test(`${name}-dark`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(path);
    await expect(page.getByText(ready, { exact: true }).first()).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/dark/);
    if (name === "widget-editor") {
      await page
        .getByRole("button", { name: "Small zone", exact: true })
        .click();
    }
    await snapshot(page, `${name}-dark`);
  });
}
