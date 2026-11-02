import { expect, test, type Page } from "@playwright/test";
import { csrfToken, ids, resetDemo } from "../support/demo";

test.beforeEach(async ({ request }) => resetDemo(request));

async function setDensity(page: Page, density: "comfortable" | "compact") {
  const response = await page.request.get("/api/v1/me/preferences");
  const { data } = await response.json();
  const saved = await page.request.patch("/api/v1/me/preferences", {
    headers: { "X-CSRF-Token": await csrfToken(page.request) },
    data: {
      revision: data.revision,
      values: { ...data.values, "preference.density": density },
    },
  });
  expect(saved.ok()).toBe(true);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-density", density);
}

test("saved density tightens collections without shrinking controls or changing domain data", async ({
  page,
}) => {
  await page.goto("/screens");
  await setDensity(page, "comfortable");
  const row = page.getByRole("row").filter({
    has: page.getByRole("link", { name: "Cafeteria East", exact: true }),
  });
  const action = row.getByRole("button", {
    name: "Actions for Cafeteria East",
  });
  await expect(action).toBeVisible();
  const beforeData = await (
    await page.request.get(`/api/v1/playlists/${ids.morningAnnouncements}`)
  ).json();
  const comfortable = await row.boundingBox();
  const control = await action.boundingBox();
  const font = await action.evaluate(
    (element) => getComputedStyle(element).fontSize,
  );
  await setDensity(page, "compact");
  await expect(action).toBeVisible();
  const compact = await row.boundingBox();
  expect(compact!.height).toBeLessThan(comfortable!.height);
  expect(await action.boundingBox()).toMatchObject({
    width: control!.width,
    height: control!.height,
  });
  expect(
    await action.evaluate((element) => getComputedStyle(element).fontSize),
  ).toBe(font);
  expect(
    await (
      await page.request.get(`/api/v1/playlists/${ids.morningAnnouncements}`)
    ).json(),
  ).toEqual(beforeData);
  await page.goto("/playlists");
  await page
    .getByRole("button", { name: "Create playlist", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const geometry = () =>
    dialog.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        width: style.width,
        height: style.height,
        padding: style.padding,
        font: style.fontSize,
      };
    });
  const compactDialog = await geometry();
  await page.evaluate(() => {
    document.documentElement.dataset.density = "comfortable";
  });
  expect(await geometry()).toEqual(compactDialog);
});

test("fleet context actions match overflow, preserve row navigation, and respect batch selection", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
  });
  await page.goto("/screens");
  const link = page.getByRole("link", { name: "Cafeteria East", exact: true });
  const row = page.getByRole("row").filter({ has: link });
  const button = row.getByRole("button", {
    name: "Actions for Cafeteria East",
  });
  await button.focus();
  await page.keyboard.press("Enter");
  const dropdown = await page.getByRole("menuitem").allTextContents();
  await page.keyboard.press("Escape");
  await expect(button).toBeFocused();
  await link.click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  expect(await page.getByRole("menuitem").allTextContents()).toEqual(dropdown);
  await expect(page).toHaveURL(/\/screens$/);
  await page.keyboard.press("Escape");
  // Browser-native macOS Control-click produces this contextmenu event.
  await link.dispatchEvent("click", { button: 0, ctrlKey: true });
  await link.dispatchEvent("contextmenu", {
    button: 0,
    ctrlKey: true,
    clientX: 300,
    clientY: 300,
  });
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page).toHaveURL(/\/screens$/);
  await page.keyboard.press("Escape");
  await row
    .getByRole("checkbox", { name: "Select Cafeteria East", exact: true })
    .check();
  await expect(button).toHaveCount(0);
  await row.click({ button: "right" });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await row
    .getByRole("checkbox", { name: "Select Cafeteria East", exact: true })
    .uncheck();
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/screens/${ids.cafeteriaEast}`));
});

for (const width of [1440, 1024, 820, 768, 390]) {
  test(`Studio collections and editor actions fit ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    for (const path of [
      "/screens",
      "/groups",
      `/playlists/${ids.morningAnnouncements}`,
      "/layouts/de300006-0000-4000-8000-000000000001",
    ]) {
      await page.goto(path);
      await expect(page.locator('[data-slot="sidebar-inset"]')).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        )
        .toBe(true);
      if (path.startsWith("/playlists/")) {
        await expect(
          page.getByRole("button", { name: "Preview", exact: true }),
        ).toBeInViewport();
        await expect(
          page.getByRole("button", { name: "Publish", exact: true }),
        ).toBeInViewport();
      }
    }
  });
}

test.describe("coarse pointer", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("keeps visible row actions and practical touch targets in both densities", async ({
    page,
  }) => {
    await page.goto("/schedules");
    for (const density of ["comfortable", "compact"] as const) {
      await setDensity(page, density);
      const action = page.getByRole("button", {
        name: "Actions for Morning Broadcast",
      });
      await expect(action).toBeVisible();
      const box = await action.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(36);
      expect(box!.height).toBeGreaterThanOrEqual(36);
      await action.tap();
      await expect(page.getByRole("menu")).toBeVisible();
      await page.keyboard.press("Escape");
    }
    await page.goto("/layouts/de300006-0000-4000-8000-000000000001");
    await expect(
      page.getByText("Go Falcons!", { exact: true }).first(),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
});
