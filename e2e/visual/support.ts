import { expect, type Page } from "@playwright/test";

async function settle(page: Page) {
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

export async function snapshot(
  page: Page,
  name: string,
  extraMasks: ReturnType<Page["locator"]>[] = [],
) {
  await settle(page);
  // Server wall time and pairing expiry remain real. Mask only their labels,
  // never status badges, content, controls or the shared Widget renderer.
  const masks = [
    page.getByRole("button", { name: /^Notifications,/ }),
    page.locator("p").filter({ hasText: /last contact|Paired \d/ }),
    page.getByText(/^Updated \d/),
    page.locator("p").filter({ hasText: /Last signed in/ }),
    page
      .locator("dt")
      .filter({ hasText: /^Last contact$/ })
      .locator("+ dd"),
    page.locator("table time"),
    page.getByText(/^(just now|\d+ (min|hr) ago|\d{1,2}\/\d{1,2}\/\d{4})$/i),
    page
      .locator("dt")
      .filter({ hasText: /^Next schedule change$/ })
      .locator("+ dd"),
    page
      .locator("dt")
      .filter({ hasText: /^Now playing$/ })
      .locator("+ dd"),
    page
      .getByRole("region", { name: "Pending pairing requests" })
      .locator('[data-slot="item-description"]'),
    ...extraMasks,
  ];
  await expect(page).toHaveScreenshot(`${name}.png`, {
    mask: masks,
    maskColor: "#808080",
  });
}
