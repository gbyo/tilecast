import { expect, test } from "@playwright/test";
import { csrfToken, ids, resetDemo } from "../support/demo";

test.use({ timezoneId: "UTC", viewport: { width: 1440, height: 1000 } });

test("align expected playback on a week grid and inspect a group overlap on a phone", async ({
  page,
}) => {
  await resetDemo(page.request);
  const csrf = await csrfToken(page.request);
  const start = new Date();
  start.setUTCHours(14, 0, 0, 0);
  // Pick a date in the next week for either a Sunday or Monday week start.
  const weekday = start.getUTCDay();
  start.setUTCDate(start.getUTCDate() + (weekday === 0 ? 7 : 10 - weekday));
  const end = new Date(start.getTime() + 60 * 60_000);
  for (const [name, priority, playlistId] of [
    ["Regular broadcast", 110, ids.generalInformation],
    ["Assembly special", 120, ids.morningAnnouncements],
  ] as const) {
    const result = await page.request.post("/api/v1/schedules", {
      headers: { "X-CSRF-Token": csrf },
      data: {
        name,
        priority,
        playlistId,
        type: "one_time",
        enabled: true,
        timezone: "UTC",
        oneTimeStart: start.toISOString(),
        oneTimeEnd: end.toISOString(),
        targets: [{ type: "group", id: ids.cafeteriaDisplays }],
      },
    });
    expect(result.ok(), await result.text()).toBe(true);
  }

  await page.goto("/schedules");
  await page.getByRole("tab", { name: "Playback agenda" }).click();
  await expect(page).toHaveURL(/\/schedules\?view=agenda$/);
  await page
    .getByRole("combobox", { name: "Choose a screen or group" })
    .click();
  await page.getByRole("option", { name: "Cafeteria Displays" }).click();
  await page.getByRole("button", { name: "Next week" }).click();
  const calendar = page.getByRole("region", {
    name: "Playback calendar for Cafeteria East",
  });
  await expect(calendar.getByRole("group")).toHaveCount(7);
  const date = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(start);
  const day = calendar.getByRole("group", { name: `${date}, overlaps` });
  const block = day.getByRole("button", {
    name: /Assembly special.*Schedule overlap/,
  });
  await expect(block).toBeVisible();
  await expect(block).toContainText("Assembly special");

  const dayBounds = (await day.boundingBox())!;
  const blockBounds = (await block.boundingBox())!;
  expect(blockBounds.y - dayBounds.y).toBeCloseTo(14 * 56 + 1, 0);
  expect(blockBounds.height).toBeCloseTo(56 - 2, 0);
  await expect(
    day.locator('[data-calendar-block="fallback"]').first(),
  ).toBeAttached();

  await page.setViewportSize({ width: 375, height: 812 });
  const dateButton = page.getByRole("button", { name: `${date}, overlaps` });
  await dateButton.click();
  await expect(calendar.getByRole("group")).toHaveCount(1);
  await block.click();
  const details = page.getByRole("dialog");
  await expect(
    details.getByRole("link", { name: "Assembly special" }),
  ).toBeVisible();
  await expect(
    details.getByRole("link", { name: "Regular broadcast" }),
  ).toBeVisible();
  await expect(
    details.getByText("Another active schedule has a higher priority."),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("combobox", { name: "Screen in group" }).click();
  await page.getByRole("option", { name: "Cafeteria West" }).click();
  await expect(
    page.getByRole("region", { name: "Playback calendar for Cafeteria West" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(375);

  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Previous week" }),
  ).toBeDisabled();
});
