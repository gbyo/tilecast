import { expect, test, type Page } from "@playwright/test";
import { ids, resetDemo } from "../support/demo";

const hallwaySplit = "de300006-0000-4000-8000-000000000001";
const lobbyPortrait = "de300006-0000-4000-8000-000000000002";
const lobbyClock = "de30000a-0000-4000-8000-000000000009";

test.beforeEach(async ({ page }) => {
  await resetDemo(page.request);
  // Only Date is fixed. Network requests, timers and simulated players keep
  // running; this exercises the production renderer rather than a fake app.
  await page.clock.setFixedTime(new Date("2026-09-28T14:00:00Z"));
});

async function settle(page: Page) {
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
  await expect(page.getByText("Loading…", { exact: true })).toHaveCount(0);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      Array.from(document.images).map((image) =>
        image.decode().catch(() => undefined),
      ),
    );
    await Promise.all(
      Array.from(document.querySelectorAll("[data-tilecast-widget]")).map(
        (widget) =>
          (widget as HTMLElement & { updateComplete?: Promise<unknown> })
            .updateComplete,
      ),
    );
  });
}

async function snapshot(
  page: Page,
  name: string,
  extraMasks: ReturnType<Page["locator"]>[] = [],
) {
  await settle(page);
  // Server wall time and pairing expiry remain real. Mask only their labels,
  // never status badges, content, controls or the shared Widget renderer.
  const masks = [
    page.locator("time"),
    page.getByRole("button", { name: /^Notifications,/ }),
    page.locator("p").filter({ hasText: /last contact|Paired \d|^Updated / }),
    page
      .locator("dt")
      .filter({ hasText: /^Last contact$/ })
      .locator(".."),
    ...extraMasks,
  ];
  await expect(page).toHaveScreenshot(`${name}.png`, {
    mask: masks,
    maskColor: "#808080",
  });
}

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
    const masks = name === "fleet" ? [page.getByRole("alert")] : [];
    await snapshot(page, name, masks);
  });
}

test("overview", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Needs attention" }),
  ).toBeVisible();
  await snapshot(page, "overview", [
    page.locator(".recharts-wrapper"),
    page.getByLabel("Fleet status").locator("> div").last(),
    page
      .getByRole("heading", { name: "Coming up" })
      .locator("..")
      .locator(".."),
  ]);
});

test("layout-widget-preview", async ({ page }) => {
  await page.goto(`/layouts/${lobbyPortrait}`);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(
    page.locator(".layout-preview-frame [data-tilecast-widget]"),
  ).toHaveCount(1);
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
    await snapshot(page, `${name}-dark`);
  });
}
