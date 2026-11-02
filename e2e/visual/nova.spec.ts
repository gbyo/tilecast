import { expect, test } from "@playwright/test";
import { ids, resetDemo } from "../support/demo";
import { snapshot } from "./support";

test.beforeEach(async ({ page }) => {
  await resetDemo(page.request);
  await page.clock.setFixedTime(new Date("2026-09-28T14:00:00Z"));
});

for (const [name, route, ready] of [
  ["groups", "/groups", "Cafeteria Displays"],
  ["group-detail", `/groups/${ids.cafeteriaDisplays}`, "Cafeteria Displays"],
  ["plugin-store", "/plugins/store", "Countdown Bar"],
  ["plugin-detail", "/plugins/store/countdown_bar", "Countdown Bar"],
] as const) {
  test(name, async ({ page }) => {
    await page.goto(route);
    await expect(page.getByText(ready, { exact: true }).first()).toBeVisible();
    await snapshot(page, name);
  });
}

test("fleet-context-menu", async ({ page }) => {
  await page.goto("/screens");
  const link = page.getByRole("link", { name: "Cafeteria East", exact: true });
  await link.click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await page.mouse.move(0, 0);
  await snapshot(page, "fleet-context-menu");
});

test("content-list", async ({ page }) => {
  await page.goto("/assets");
  await expect(
    page.getByText("Welcome Back, Falcons", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Sort media/ }).click();
  await page.getByRole("menuitemradio", { name: "Name", exact: true }).click();
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(0);
  await page.mouse.move(0, 0);
  await snapshot(page, "content-list");
});

test("fleet-compact", async ({ page }) => {
  await page.goto("/screens");
  await expect(
    page.getByRole("link", { name: "Cafeteria East", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.dataset.density = "compact";
  });
  await snapshot(page, "fleet-compact");
});

for (const width of [1024, 820, 768, 390]) {
  test(`layout-editor-${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto("/layouts/de300006-0000-4000-8000-000000000001");
    await expect(
      page.getByText("Go Falcons!", { exact: true }).first(),
    ).toBeVisible();
    await snapshot(page, `layout-editor-${width}`);
  });
}
