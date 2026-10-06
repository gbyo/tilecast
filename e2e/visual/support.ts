import { expect, type Locator, type Page } from "@playwright/test";
import { settle } from "../support/settle";

function volatileRegions(scope: Page | Locator) {
  // Server wall time and pairing expiry remain real. Mask only their labels,
  // never status badges, content, controls or the shared Widget renderer.
  return [
    scope.getByRole("button", { name: /^Notifications,/ }),
    scope.locator("p").filter({ hasText: /last contact|Paired \d/ }),
    scope.getByText(/^Updated (?:just now|\d)/),
    scope.locator("p").filter({ hasText: /^Requested: .* · Evaluated:/ }),
    scope.locator("p").filter({ hasText: /Last signed in/ }),
    scope
      .locator("dt")
      .filter({ hasText: /^Last contact$/ })
      .locator("+ dd"),
    scope.locator("table time"),
    scope.getByText(/^(just now|\d+ (min|hr) ago)$/i),
    // The schedule editor's next-run check names the server's next occurrence,
    // which moves with the real clock.
    scope.getByText(/^(Checked for|Running now ·)/),
    scope
      .locator("dt")
      .filter({ hasText: /^Next schedule change$/ })
      .locator("+ dd"),
    scope
      .locator("dt")
      .filter({ hasText: /^Now playing$/ })
      .locator("+ dd"),
    scope
      .getByRole("region", { name: "Pending pairing requests" })
      .locator('[data-slot="item-description"]'),
  ];
}

export async function snapshotRegion(
  page: Page,
  region: Locator,
  name: string,
) {
  await settle(page);
  await expect(region).toHaveScreenshot(`${name}.png`, {
    mask: volatileRegions(region),
    maskColor: "#808080",
  });
}

export async function snapshot(
  page: Page,
  name: string,
  extraMasks: Locator[] = [],
) {
  await settle(page);
  const dialog = page.getByRole("dialog").last();
  const modal = (await dialog.count()) > 0;
  if (modal) {
    // Playwright paints masks above dialogs. Hide volatile background labels
    // in their own paint layer instead, keeping the foreground unobscured.
    for (const region of volatileRegions(page)) {
      await region.evaluateAll((elements) => {
        for (const element of elements) {
          if (!element.closest('[role="dialog"]')) {
            element.setAttribute("data-visual-volatile", "");
          }
        }
      });
    }
  }
  try {
    await expect(page).toHaveScreenshot(`${name}.png`, {
      mask: [...volatileRegions(modal ? dialog : page), ...extraMasks],
      maskColor: "#808080",
    });
  } finally {
    if (modal) {
      await page.locator("[data-visual-volatile]").evaluateAll((elements) => {
        for (const element of elements) {
          element.removeAttribute("data-visual-volatile");
        }
      });
    }
  }
}
