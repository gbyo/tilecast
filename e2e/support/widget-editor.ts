import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Helpers for the one Widget editor. They assert on the shared Widget mount
 * (`[data-tilecast-widget]`), the same element the Player mounts, and on
 * accessible roles. The healthy preview is silent, so nothing here waits for
 * a status label.
 */

/** The real shared Widget the preview mounts. */
export function widgetMount(page: Page): Locator {
  return page.locator("[data-tilecast-widget]");
}

/** What the mounted Widget has rendered, as the reader sees it. */
export function widgetText(mount: Locator) {
  return mount.evaluate(
    (element) =>
      element.shadowRoot?.textContent?.replace(/\s+/g, " ").trim() ?? "",
  );
}

/** Wait until exactly one shared Widget mount has rendered something. */
export async function expectWidgetRendered(page: Page) {
  const mount = widgetMount(page);
  await expect(mount).toHaveCount(1);
  await expect.poll(() => widgetText(mount)).not.toBe("");
  return mount;
}

export async function openWidgetEditor(page: Page, route: string) {
  await page.goto(route);
  await expect(
    page.getByRole("button", { name: "Back to Widgets" }),
  ).toBeVisible();
  return expectWidgetRendered(page);
}

/** Choose a preview frame through the frame selector. */
export async function choosePreviewFrame(page: Page, name: string | RegExp) {
  await page.getByRole("combobox", { name: "Preview frame" }).click();
  await page.getByRole("option", { name }).click();
}

/** The pixel geometry the mounted Widget is laid out at in the preview. */
export function widgetFrameSize(mount: Locator) {
  return mount.evaluate((element) => {
    // The Widget fills the frame it is mounted in; its own box is the frame.
    const box = (element as HTMLElement).getBoundingClientRect();
    const frame = element.parentElement as HTMLElement;
    return {
      width: frame.offsetWidth || Math.round(box.width),
      height: frame.offsetHeight || Math.round(box.height),
    };
  });
}
