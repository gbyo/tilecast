import { expect, test } from "@playwright/test";
import { ids, resetDemo } from "../support/demo";
import { expectWidgetRendered } from "../support/widget-editor";
import { capture } from "./support";

// Fixed identities from the Demo seed, not a second set of fixtures.
const hallwaySplit = "de300006-0000-4000-8000-000000000001";
const lobbyClock = "de30000a-0000-4000-8000-000000000009";
const homecomingWeek = "de300008-0000-4000-8000-000000000001";
const morningBroadcast = "de300007-0000-4000-8000-000000000003";

test.beforeEach(async ({ page }, testInfo) => {
  await resetDemo(page.request);
  // Only time-based content needs a fixed browser Date. Contact ages and
  // schedule dates remain truthful to the running server elsewhere.
  if (testInfo.title === "widget-editor") {
    await page.clock.setFixedTime(new Date("2026-09-28T14:00:00Z"));
  }
});

for (const [name, route, ready] of [
  ["studio-overview", "/", "Needs attention"],
  ["fleet", "/screens", "Cafeteria East"],
  ["media-library", "/assets", "Welcome Back, Falcons"],
  ["widget-editor", `/widgets/${lobbyClock}`, "Show seconds"],
  ["playlist-editor", `/playlists/${ids.morningAnnouncements}`, "Add content"],
  ["layout-editor", `/layouts/${hallwaySplit}`, "Go Falcons!"],
  ["campaign-editor", `/campaigns/${homecomingWeek}`, "Content blocks"],
  ["schedule-editor", `/schedules/${morningBroadcast}`, "Edit schedule"],
  [
    "display-group",
    `/groups/${ids.cafeteriaDisplays}`,
    "Menu boards in every cafeteria.",
  ],
  ["plugins", "/plugins", "Countdown Bar"],
  ["users", "/settings/users", "Marcus Reyes"],
] as const) {
  test(name, async ({ page }) => {
    await page.goto(route);
    await expect(page.getByText(ready, { exact: true }).first()).toBeVisible();
    if (name === "media-library") {
      await page.getByRole("button", { name: /^Sort media/ }).click();
      await page
        .getByRole("menuitemradio", { name: "Name", exact: true })
        .click();
      await expect(page.getByRole("menu")).toBeHidden();
      // The pointer would otherwise leave a hover state on the card beneath it.
      await page.mouse.move(0, 0);
      await expect(page.getByRole("article")).toHaveCount(8);
      await expect(page.getByRole("article").first()).toContainText(
        "Booster Club",
      );
    }
    if (name === "widget-editor") {
      // The healthy preview is silent; the shared Widget mount proves it.
      await expectWidgetRendered(page);
    }
    if (name === "playlist-editor") {
      await page
        .getByText("Welcome Back, Falcons", { exact: true })
        .first()
        .click();
      await expect(
        page.getByRole("complementary", { name: "Item inspector" }),
      ).toBeVisible();
    }
    if (name === "layout-editor") {
      await page.getByRole("button", { name: "Layers", exact: true }).click();
      await page
        .getByRole("button", { name: "Spirit week", exact: true })
        .click();
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("button", { name: "Collapse inspector", exact: true }),
      ).toBeVisible();
      // Use the editor's real zoom/pan controls to keep the selected panel
      // and the Inspector visible together, without changing the Layout.
      await page.getByRole("button", { name: "Zoom out", exact: true }).click();
      const canvas = await page.locator(".layout-canvas").boundingBox();
      if (!canvas) throw new Error("Hallway Split canvas is not visible.");
      await page.mouse.move(
        canvas.x + canvas.width / 2,
        canvas.y + canvas.height / 2,
      );
      await page.mouse.down({ button: "middle" });
      await page.mouse.move(
        canvas.x + canvas.width / 2 - 150,
        canvas.y + canvas.height / 2,
        { steps: 10 },
      );
      await page.mouse.up({ button: "middle" });
      await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    }
    if (name === "display-group") {
      await page.getByRole("tab", { name: "Screens", exact: true }).click();
      await expect(
        page.getByText("Cafeteria East", { exact: true }),
      ).toBeVisible();
    }
    if (name === "schedule-editor") {
      await expect(
        page.getByRole("complementary", { name: "Schedule summary" }),
      ).toBeVisible();
    }
    await capture(page, name);
  });
}

test("data-source-providers", async ({ page }) => {
  await page.goto("/data-sources/new");
  await expect(
    page.getByRole("heading", { name: "Create Data Source", exact: true }),
  ).toBeVisible();
  const catalog = page.locator(".app-editor-route");
  await expect(
    catalog.getByRole("button", { name: /Manual/ }).first(),
  ).toBeVisible();
  await capture(page, "data-source-providers", catalog);
});

test("pair-screen", async ({ page }) => {
  await page.goto("/screens");
  await page
    .getByRole("region", { name: "Pending pairing requests" })
    .getByRole("link", { name: "Review" })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Approve and pair", exact: true }),
  ).toBeVisible();
  await capture(page, "pair-screen", dialog);
});

test("bulk-change-review", async ({ page }) => {
  await page.goto("/screens/bulk");
  await page
    .getByRole("checkbox", { name: /^Select Cafeteria East\b/ })
    .check();
  await page.getByRole("checkbox", { name: /^Select Front Office\b/ }).check();
  await page.getByRole("combobox", { name: "Playlist", exact: true }).click();
  await page
    .getByRole("option", { name: "General Information", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Preview the change", exact: true })
    .click();
  const preview = page.getByRole("region", {
    name: "What will change",
    exact: true,
  });
  await expect(preview.getByText(/Cafeteria West/)).toBeVisible();
  await capture(page, "bulk-change-review", preview);
});

test("live-preview-unavailable", async ({ page }) => {
  await page.goto(`/screens/${ids.cafeteriaEast}`);
  const panel = page.getByRole("complementary", { name: "Live preview" });
  await expect(panel.getByText("Capture error", { exact: true })).toBeVisible();
  await expect(panel.getByText("Not captured", { exact: true })).toBeVisible();
  await capture(page, "live-preview-unavailable", panel);
});

test("backups", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/settings/operations/backups");
  await page
    .getByRole("button", { name: "Create backup", exact: true })
    .click();
  const available = page.locator("section").filter({
    has: page.getByRole("heading", {
      name: "Available backups",
      exact: true,
    }),
  });
  await expect(
    available.getByRole("button", { name: "Verify", exact: true }),
  ).toBeVisible({ timeout: 90_000 });
  await available.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(available.getByText("Verified", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await capture(page, "backups", available);
});

// TODO: Add Content review and Forms/Approvals when Demo has a reproducible
// submitted record fixture. Empty inboxes do not teach those workflows.
// Player updates are omitted: Demo seeds no verified release or deployment.
