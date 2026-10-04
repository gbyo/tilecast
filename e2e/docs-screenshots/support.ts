import { expect, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { settle } from "../support/settle";

const output = resolve(__dirname, "../../apps/docs/src/assets/screenshots");

export async function capture(page: Page, name: string, region?: Locator) {
  await settle(page);
  // Only disposable-installation chrome differs from an ordinary Studio.
  // Never mask status, errors, timestamps, or any other application content.
  await page.addStyleTag({
    // Fullscreen editors replace the same Demo notice with a compact badge.
    content:
      '[data-testid="demo-mode-banner"], [data-testid="demo-badge"] { display: none !important; }',
  });
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await mkdir(output, { recursive: true });
  const target = region ?? page;
  if (region) await expect(region).toBeVisible();
  await target.screenshot({
    path: `${output}/${name}.png`,
    animations: "disabled",
    caret: "hide",
  });
  console.log(`Generated ${name}.png`);
}
