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
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    if (theme === "dark") {
      await expect(page.locator("html")).toHaveClass(/dark/);
    } else {
      await expect(page.locator("html")).not.toHaveClass(/dark/);
    }
    await settle(page);
    const filename = `${name}${theme === "dark" ? "-dark" : ""}.png`;
    await target.screenshot({
      path: `${output}/${filename}`,
      animations: "disabled",
      caret: "hide",
    });
    console.log(`Generated ${filename}`);
  }
}
