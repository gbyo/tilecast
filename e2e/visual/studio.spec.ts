import { expect, test } from "@playwright/test";
import { ids, resetDemo } from "../support/demo";
import { snapshot, snapshotRegion } from "./support";
import { inspectFuturePlayback } from "../support/playback-plan";
import {
  expectWidgetRendered,
  openWidgetEditor,
} from "../support/widget-editor";

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
  ["widget-editor", `/widgets/${lobbyClock}`, "Show seconds"],
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
    if (name === "content") {
      // Processing completion order is real and concurrent. Choose a stable
      // sort through the production UI rather than masking whole cards.
      await page.getByRole("button", { name: /^Sort media/ }).click();
      await page
        .getByRole("menuitemradio", { name: "Name", exact: true })
        .click();
      await expect(page.getByRole("menu")).toBeHidden();
      // The pointer would otherwise leave a hover state on the card beneath it.
      await page.mouse.move(0, 0);
      await expect(page.getByRole("article")).toHaveCount(8);
      await expect(page.getByRole("article").first()).toContainText(
        "Booster Club",
      );
    }
    if (name === "widgets") {
      // The library repairs an old Widget thumbnail asynchronously. Wait for
      // that real capture so the screenshot records the stable preview state.
      const preview = page
        .getByRole("article")
        .filter({ hasText: "Lobby Clock" })
        .first()
        .locator("img");
      // The capture runs in a real headless renderer, which is slower on CI.
      await expect(preview).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(() =>
          preview.evaluate(
            (image: HTMLImageElement) =>
              image.complete && image.naturalWidth > 0,
          ),
        )
        .toBe(true);
    }
    if (name === "widget-editor") {
      // The healthy preview is silent; the shared Widget mount is the proof
      // that it rendered. The default frame fits the stage, so no preset
      // is needed to keep the whole frame visible.
      await expectWidgetRendered(page);
    }
    if (name.startsWith("screen-")) {
      await inspectFuturePlayback(page);
      // Demo players explicitly acknowledge unsupported captures. Screens
      // without a connected player show Offline rather than awaiting an image.
      await expect(
        page
          .getByRole("complementary", { name: "Live preview" })
          .getByText(name === "screen-online" ? "Capture error" : "Offline", {
            exact: true,
          }),
      ).toBeVisible();
      await expect(
        page
          .getByRole("complementary", { name: "Live preview" })
          .getByText("Not captured", { exact: true }),
      ).toBeVisible();
    }
    await snapshot(page, name);
  });
}

test("screen playback explanation", async ({ page }) => {
  await page.goto(`/screens/${ids.cafeteriaEast}`);
  const { panel } = await inspectFuturePlayback(page);
  await snapshotRegion(page, panel, "screen-playback-explanation");
});

test("overview", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Needs attention" }),
  ).toBeVisible();
  await snapshot(page, "overview", [
    // Coming up shows how far away each change is and its date, both relative
    // to the real clock.
    page
      .getByRole("region", { name: "Coming up" })
      .locator('[data-slot="item"]'),
    page.locator(".recharts-wrapper"),
    page.getByRole("region", { name: "Fleet health" }).locator(".tabular-nums"),
    page.getByRole("button", { name: /^Per screen ·/ }).locator("span"),
  ]);
});

test("layout-widget-preview", async ({ page }) => {
  await page.goto(`/layouts/${lobbyPortrait}`);
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = await popupPromise;
  await preview.setViewportSize({ width: 1440, height: 1000 });
  await preview.clock.setFixedTime(new Date("2026-09-28T14:00:00Z"));
  await expect(preview.locator("#layout-preview-date")).toHaveText("9/28/2026");
  const widget = preview
    .locator(".layout-preview-frame [data-tilecast-widget]")
    .first();
  await expect(widget).toHaveCount(1);
  await expect
    .poll(() =>
      widget.evaluate(
        (element) => element.shadowRoot?.textContent?.trim() ?? "",
      ),
    )
    .not.toBe("");
  await expect
    .poll(() =>
      widget.evaluate((element: HTMLElement) => ({
        width: element.offsetWidth,
        height: element.offsetHeight,
      })),
    )
    .toEqual({ width: 1080, height: 480 });
  await expect(preview.locator(".layout-preview-frame")).toBeInViewport({
    ratio: 1,
  });
  await expect
    .poll(() =>
      preview
        .locator(".layout-preview-frame")
        .evaluate((frame) => frame.clientWidth / frame.clientHeight),
    )
    .toBeCloseTo(1080 / 1920, 2);
  await snapshot(preview, "layout-widget-preview");
});

test("playlist-create-dialog", async ({ page }) => {
  await page.goto("/playlists?create=1");
  await expect(page.getByRole("dialog")).toBeVisible();
  await snapshot(page, "playlist-create-dialog");
});

test("fleet-bulk-review", async ({ page }) => {
  await page.goto("/screens/bulk");
  await expect(
    page.getByRole("heading", { name: "Bulk changes" }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Select all" }).click();
  await page.getByRole("combobox", { name: "Playlist" }).click();
  await page.getByRole("option", { name: "Morning Announcements" }).click();
  await page.getByRole("button", { name: "Preview the change" }).click();
  await expect(
    page.getByRole("heading", { name: "What will change" }),
  ).toBeVisible();
  await snapshot(page, "fleet-bulk-review");
});

test("screen-scope-editor", async ({ page }) => {
  await page.goto("/settings/users");
  const row = page
    .locator('[data-slot="item"]')
    .filter({ hasText: "Priya Natarajan" });
  await row.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("button", { name: "Screen scope" }).click();
  await page.getByRole("radio", { name: "Limit access" }).click();
  await expect(
    page.getByRole("checkbox", { name: "High School" }),
  ).toBeVisible();
  await snapshot(page, "screen-scope-editor");
});

test("datasource-create", async ({ page }) => {
  await page.goto("/data-sources/new");
  await expect(
    page.getByRole("heading", { name: "Create Data Source" }),
  ).toBeVisible();
  await snapshot(page, "datasource-create");
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
    if (name === "widget-editor") await expectWidgetRendered(page);
    await snapshot(page, `${name}-dark`);
  });
}

// The one Widget editor with a data Widget: Data authoring, the Widget's
// recommended strip frame, and the compact toolbar, none of which the clock
// shows.
test("widget-editor-data", async ({ page }) => {
  await openWidgetEditor(page, "/widgets/new/ticker");
  await expect(
    page.getByText("No data connected", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect new data" }),
  ).toBeVisible();
  await snapshot(page, "widget-editor-data");
});

// Problems appear after a save attempt, beside the field and in the tab that
// holds it; the Widget keeps its last good preview.
test("widget-editor-validation", async ({ page }) => {
  await page.goto("/widgets/new/website");
  await expect(page.getByRole("tab", { name: "Content" })).toBeVisible();
  await page.getByRole("button", { name: "Save Widget", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: /Web address/ }),
  ).toHaveAttribute("aria-invalid", "true");
  await snapshot(page, "widget-editor-validation");
});
