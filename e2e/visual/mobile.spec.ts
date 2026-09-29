import { expect, test, type Page } from "@playwright/test";
import { ids, resetDemo } from "../support/demo";

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
    page.getByRole("link", { name: "Cafeteria East" }),
  ).toBeVisible();
  await expectNoPageOverflow(page);
});

test("mobile activity keeps the long tab strip contained", async ({ page }) => {
  await page.goto("/activity");
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();

  const tabs = page.getByRole("tablist");
  await expect
    .poll(() =>
      tabs.evaluate((element) => element.scrollWidth > element.clientWidth),
    )
    .toBe(true);

  await tabs.getByRole("tab", { name: "Proof of Play", exact: true }).click();
  await page.getByRole("button", { name: /more filters/i }).click();
  const filters = page.locator('[data-slot="popover-content"]');
  await expect(filters).toBeVisible();
  const filterBounds = await filters.boundingBox();
  expect(filterBounds).not.toBeNull();
  expect(filterBounds!.x).toBeGreaterThanOrEqual(0);
  expect(filterBounds!.x + filterBounds!.width).toBeLessThanOrEqual(375);
  await page.keyboard.press("Escape");

  const lastTab = tabs.getByRole("tab").last();
  await lastTab.click();
  await expect(lastTab).toHaveAttribute("aria-selected", "true");
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
