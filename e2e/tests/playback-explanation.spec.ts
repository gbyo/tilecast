import { expect, test } from "@playwright/test";
import { ids, resetDemo } from "../support/demo";
import { inspectFuturePlayback } from "../support/playback-plan";

test.beforeEach(async ({ page }) => {
  await resetDemo(page.request);
});

test("Screen explanation follows server selection and preserves historical gaps", async ({
  page,
}) => {
  await page.goto(`/screens/${ids.cafeteriaEast}`);
  const { panel, inspected } = await inspectFuturePlayback(page);
  const plan = (await inspected.json()).data;
  expect(plan.basis).toBe("current_configuration");
  // The selected presentation name appears twice by design: once in the
  // selection-precedence candidate list and once as the content-path link.
  await expect(
    panel.getByText(plan.current.selected.name, { exact: true }).first(),
  ).toBeVisible();
  await expect(panel.getByText("Selection precedence")).toBeVisible();
  await expect(
    panel.getByText(
      "The next reevaluation may leave the selected content unchanged. Future predictions use current configuration and the latest reported Player state.",
    ),
  ).toBeVisible();
  await expect(
    panel.getByRole("link", { name: "View Player-confirmed Activity" }),
  ).toBeVisible();

  await panel
    .getByRole("button", { name: "Inspect an instant", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Choose the Year" })
    .selectOption("2020");
  await page
    .getByRole("combobox", { name: "Choose the Month" })
    .selectOption("8");
  await page
    .getByRole("button", { name: "Thursday, September 3rd, 2020", exact: true })
    .click();
  await panel.getByRole("button", { name: "Inspect", exact: true }).click();
  await expect(
    panel.getByText("Historical expectation unavailable"),
  ).toBeVisible();
  await expect(
    panel.getByText(
      "No recorded expectation covers this instant. Current assignments cannot fill this historical gap.",
    ),
  ).toBeVisible();
  await expect(panel.getByText("Selection precedence")).toHaveCount(0);
  await expect(
    panel.getByText(plan.current.selected.name, { exact: true }),
  ).toHaveCount(0);

  await panel.getByRole("button", { name: "Use server time" }).click();
  await expect(
    panel.getByText("Prediction from current configuration"),
  ).toBeVisible();
  await panel
    .getByRole("link", { name: "View Player-confirmed Activity" })
    .click();
  await expect(page).toHaveURL(/tab=activity/);
});
