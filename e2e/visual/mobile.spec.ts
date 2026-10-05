import { expect, test, type Page } from "@playwright/test";
import { ids, resetDemo } from "../support/demo";
import { inspectFuturePlayback } from "../support/playback-plan";
import { snapshotRegion } from "./support";

const hallwaySplit = "de300006-0000-4000-8000-000000000001";

test.beforeEach(async ({ page }) => {
  await resetDemo(page.request);
  await page.clock.setFixedTime(new Date("2026-09-28T14:00:00Z"));
});

async function expectNoPageOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    )
    .toBe(true);
}

test("mobile playback explanation keeps evidence and instant controls inside the viewport", async ({
  page,
}) => {
  await page.goto(`/screens/${ids.cafeteriaEast}`);
  const { panel } = await inspectFuturePlayback(page);
  await expect(panel.getByText("Selection precedence")).toBeVisible();
  await expect(
    panel.getByRole("link", { name: "View Player-confirmed Activity" }),
  ).toBeVisible();
  await expectNoPageOverflow(page);
  const time = panel.getByLabel("Inspect an instant time");
  const timeBounds = await time.boundingBox();
  expect(timeBounds).not.toBeNull();
  expect(timeBounds!.width).toBeGreaterThanOrEqual(144);
  await snapshotRegion(page, panel, "screen-playback-explanation-mobile");
});

test("mobile overview keeps uptime rows inside the viewport", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Needs attention" }),
  ).toBeVisible();

  const perScreen = page.getByRole("button", { name: /^Per screen ·/ });
  await perScreen.click();
  await expect(
    page
      .getByRole("region", { name: "Fleet health" })
      .getByRole("link", { name: "Cafeteria East" }),
  ).toBeVisible();
  await expectNoPageOverflow(page);
});

test("mobile activity picks reports from a menu and keeps filters on screen", async ({
  page,
}) => {
  await page.goto("/activity");
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();

  // Narrow screens replace the report tab strip with one native menu, so no
  // strip can overflow.
  await expect(page.getByRole("tablist")).toHaveCount(0);
  const reports = page.getByRole("combobox", { name: "Activity reports" });
  await reports.selectOption({ label: "Proof of Play" });
  await expect(page).toHaveURL(/tab=proof/);

  // The trigger shows "More filters" but announces the popover it opens.
  await page.getByRole("button", { name: "Advanced filters" }).click();
  const filters = page.locator('[data-slot="popover-content"]');
  await expect(filters).toBeVisible();
  const filterBounds = await filters.boundingBox();
  expect(filterBounds).not.toBeNull();
  expect(filterBounds!.x).toBeGreaterThanOrEqual(0);
  expect(filterBounds!.x + filterBounds!.width).toBeLessThanOrEqual(375);
  await page.keyboard.press("Escape");

  const last = await reports.locator("option").last().textContent();
  await reports.selectOption({ label: last!.trim() });
  await expect(reports).toHaveValue(
    (await reports.locator("option").last().getAttribute("value"))!,
  );
  await expectNoPageOverflow(page);
});

test("mobile layout editor moves secondary actions into the file menu", async ({
  page,
}) => {
  await page.goto(`/layouts/${hallwaySplit}`);
  await expect(page.getByText("Go Falcons!", { exact: true })).toBeVisible();

  await expect(
    page.getByRole("button", { name: "Preview", exact: true }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Layout file actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Undo" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Redo" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Preview" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "History…" })).toBeVisible();
  await expectNoPageOverflow(page);
});

test("mobile content picker keeps tabs and create action reachable", async ({
  page,
}) => {
  await page.goto(`/playlists/${ids.morningAnnouncements}`);
  await expect(
    page.getByText("Add content", { exact: true }).first(),
  ).toBeVisible();

  await page.getByRole("button", { name: "Add content", exact: true }).click();
  const dialog = page.getByRole("dialog").last();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "Library" })).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "Upload" })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /create widget/i }),
  ).toBeVisible();

  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
  await expectNoPageOverflow(page);
});

test("mobile dependency search popup stays inside the viewport", async ({
  page,
}) => {
  await page.goto("/settings/dependency-graph");
  await expect(
    page.getByRole("heading", { name: "Dependency Explorer" }),
  ).toBeVisible();

  const search = page.getByRole("combobox", { name: /search/i }).first();
  await search.fill("a");
  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible();
  await expectNoPageOverflow(page);

  const bounds = await listbox.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
});
