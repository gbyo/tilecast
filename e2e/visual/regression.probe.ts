import { expect, test } from "@playwright/test";
import { resetDemo } from "../support/demo";
import { snapshot } from "./support";
import { openWidgetEditor } from "../support/widget-editor";

// Explicit local verification, excluded from the ordinary suite. A known-good
// baseline must pass before the deliberately changed rendering is evaluated.
test("a deliberate Studio style regression produces screenshot differences", async ({
  page,
}) => {
  await resetDemo(page.request);
  await page.clock.setFixedTime(new Date("2026-09-28T14:00:00Z"));
  await openWidgetEditor(page, "/widgets/de30000a-0000-4000-8000-000000000009");
  await snapshot(page, "widget-editor");
  const style = await page.addStyleTag({
    content:
      "[data-slot=select-trigger] { background: #ff00ff !important; min-height: 70px !important; }",
  });
  try {
    await expect(snapshot(page, "widget-editor")).rejects.toThrow(
      /Screenshot comparison failed|pixels|screenshot/i,
    );
  } finally {
    await style.evaluate((element) => element.remove());
  }
  await snapshot(page, "widget-editor");
});
