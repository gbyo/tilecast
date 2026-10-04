import { expect, type Page } from "@playwright/test";

// Shared render settlement only. Masks and regression assertions stay in the
// visual suite; public documentation captures use the real, unmasked UI.
export async function settle(page: Page) {
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
  await expect(page.getByText("Loading…", { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-slot="toast"]')).toHaveCount(0);
  await expect
    .poll(() =>
      page
        .locator("img")
        .evaluateAll((images) =>
          images.every((image) => image.complete && image.naturalWidth > 0),
        ),
    )
    .toBe(true);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      Array.from(document.images).map((image) => image.decode()),
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
