import { expect, test } from "@playwright/test";
import { resetDemo } from "../support/demo";
import { snapshot } from "./support";

// Explicit local verification, excluded from the ordinary suite. A known-good
// baseline must pass before the deliberately changed rendering is evaluated.
test("a deliberate Studio style regression produces screenshot differences", async ({
  page,
}) => {
  await resetDemo(page.request);
  await page.clock.setFixedTime(new Date("2026-09-28T14:00:00Z"));
  await page.goto("/widgets/de30000a-0000-4000-8000-000000000009");
  await expect(page.getByText("Preview ready.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Small zone", exact: true }).click();
  await snapshot(page, "widget-editor");
  await page.addStyleTag({
    content:
      "[data-slot=input] { background: #ff00ff !important; min-height: 70px !important; }",
  });
  await expect(snapshot(page, "widget-editor")).rejects.toThrow(
    /Screenshot comparison failed|pixels|screenshot/i,
  );
});
