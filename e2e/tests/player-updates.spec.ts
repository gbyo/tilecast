import { expect, test } from "@playwright/test";
import { resetDemo } from "../support/demo";

test.beforeEach(async ({ page }) => {
  await resetDemo(page.request);
});

test("Player Updates preserves its family and view through browser navigation", async ({
  page,
}) => {
  await page.goto("/settings/player/updates?platform=edge&keep=bookmark");
  await expect(
    page.getByRole("tab", { name: "Deployments", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const family = page.getByRole("combobox", {
    name: "Player type",
    exact: true,
  });
  await expect(family).toBeVisible();
  await page.getByRole("tab", { name: "Release catalog", exact: true }).click();
  await family.click();
  await page.getByRole("option", { name: /Windows/ }).click();
  await expect(page).toHaveURL(
    /platform=windows.*keep=bookmark.*view=releases/,
  );
  await page.goBack();
  await expect(
    page.getByRole("combobox", { name: "Player type", exact: true }),
  ).toContainText("Tilecast Edge");
  await page.reload();
  await expect(
    page.getByRole("tab", { name: "Release catalog", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect(
    page.getByRole("tab", { name: "Deployments", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`deployment workflow uses a keyboard-accessible overlay at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/settings/player/updates?platform=edge");
    const deploy = page.getByRole("button", {
      name: "Deploy update",
      exact: true,
    });
    await expect(deploy).toBeEnabled();
    await deploy.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", {
      name: "Deploy update",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("1 of 3 — Update");
    await expect(
      dialog.getByRole("button", { name: "Continue", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(deploy).toBeFocused();
  });
}
