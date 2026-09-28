import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

interface StoryIndex {
  entries: Record<string, { id: string; title: string; type: string }>;
}

const index = JSON.parse(
  readFileSync(join(__dirname, "../storybook-static/index.json"), "utf8"),
) as StoryIndex;
const stories = Object.values(index.entries).filter(
  (entry) => entry.type === "story" && entry.title.startsWith("Widgets/"),
);

test("the Widget stories were built", () => {
  expect(stories.length).toBeGreaterThan(0);
});

for (const story of stories) {
  test(story.id, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/iframe.html?id=${story.id}&viewMode=story`);
    const frame = page.locator(".tc-story-frame");
    await expect(frame.locator("[data-tilecast-widget]")).toHaveCount(1);
    await page.evaluate(async () => {
      await document.fonts.ready;
      const widget = document.querySelector("[data-tilecast-widget]") as
        (HTMLElement & { updateComplete?: Promise<unknown> }) | null;
      await widget?.updateComplete;
    });
    await expect(frame.locator("[data-tilecast-widget]")).toBeVisible();
    await expect(frame).toHaveScreenshot(`${story.id}.png`);
    expect(errors).toEqual([]);
  });
}
