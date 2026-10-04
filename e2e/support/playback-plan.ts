import { expect, type Page } from "@playwright/test";

// Use the real picker and server authority. A fixed future instant keeps
// schedule selection stable across visual runs without faking an API response.
export async function inspectFuturePlayback(page: Page) {
  const panel = page.getByRole("region", { name: "Expected presentation" });
  await expect(
    panel.getByText("Prediction from current configuration"),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Why this selection?" }).click();
  await panel
    .getByRole("button", { name: "Inspect an instant", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Choose the Year" })
    .selectOption("2030");
  await page
    .getByRole("combobox", { name: "Choose the Month" })
    .selectOption("8");
  await page
    .getByRole("button", { name: "Tuesday, September 3rd, 2030", exact: true })
    .click();
  await panel.getByLabel("Inspect an instant time").fill("11:00");
  const response = page.waitForResponse((result) => {
    const url = new URL(result.url());
    return (
      url.pathname.endsWith("/playback-plan") && url.searchParams.has("at")
    );
  });
  await panel.getByRole("button", { name: "Inspect", exact: true }).click();
  const inspected = await response;
  expect(inspected.status()).toBe(200);
  await expect(
    panel.getByText("Prediction from current configuration"),
  ).toBeVisible();
  return { panel, inspected };
}
