import { expect, test } from "@playwright/test";
import { ids, resetDemo } from "../support/demo";

test.beforeEach(async ({ page }) => {
  await resetDemo(page.request);
});

test("create, edit and publish a playlist, then render its preview", async ({
  page,
}) => {
  await page.goto("/playlists?create=1");
  const create = page.getByRole("dialog", {
    name: "Create playlist",
    exact: true,
  });
  await create.getByLabel("Name", { exact: true }).fill("Browser playlist");
  await create
    .getByRole("button", { name: "Create playlist", exact: true })
    .click();
  await expect(page).toHaveURL(/\/playlists\/[0-9a-f-]+$/);
  const playlistId = new URL(page.url()).pathname.split("/").at(-1)!;

  await page.getByRole("button", { name: "Add content", exact: true }).click();
  const picker = page.getByRole("dialog", {
    name: "Choose content",
    exact: true,
  });
  await picker
    .getByRole("checkbox", { name: "Welcome Back, Falcons", exact: true })
    .check();
  await picker
    .getByRole("button", { name: "Add to playlist (1)", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Inspect Welcome Back, Falcons" }),
  ).toBeVisible();

  const publish = page.getByRole("button", { name: "Publish", exact: true });
  await expect(publish).toBeEnabled();
  await publish.click();
  await expect(publish).toBeDisabled();
  await expect(page.getByText("Published", { exact: true })).toBeVisible();
  const saved = await page.request.get(`/api/v1/playlists/${playlistId}`);
  expect(saved.ok()).toBe(true);
  const playlist = (await saved.json()).data;
  expect(playlist.items).toHaveLength(1);
  expect(playlist.hasUnpublishedChanges).toBe(false);
  expect(playlist.publishedRevision).toBe(playlist.revision);

  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = await popupPromise;
  await expect(preview).toHaveURL(
    new RegExp(`/playlists/${playlistId}/preview`),
  );
  await expect(preview.locator("img").first()).toBeVisible();
  await expect
    .poll(() =>
      preview
        .locator("img")
        .first()
        .evaluate(
          (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
        ),
    )
    .toBe(true);
});

test("create a Layout, edit its canvas and persist the draft", async ({
  page,
}) => {
  await page.goto("/layouts");
  await page
    .getByRole("button", { name: "Create layout", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Create layout",
    exact: true,
  });
  await dialog.getByLabel("Name", { exact: false }).fill("Browser layout");
  await dialog.getByRole("button", { name: /Announcement/ }).click();
  await dialog
    .getByRole("button", { name: "Create layout", exact: true })
    .click();
  await expect(page).toHaveURL(/\/layouts\/[0-9a-f-]+$/);
  const width = page.getByRole("spinbutton", { name: "Width", exact: true });
  await width.fill("1600");
  await width.blur();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(width).toHaveValue("1600");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.locator(".layout-preview-frame")).toBeVisible();
});

test("save a Widget through the real authoring form and renderer", async ({
  page,
}) => {
  const clockId = "de30000a-0000-4000-8000-000000000009";
  await page.goto(`/widgets/${clockId}`);
  await expect(page.getByText("Preview ready.", { exact: true })).toBeVisible();
  await expect(page.locator("[data-tilecast-widget]")).toHaveCount(1);
  await page.getByLabel("Widget name", { exact: true }).fill("Browser Clock");
  await page.getByRole("button", { name: "Save Widget", exact: true }).click();
  await page.goto(`/widgets/${clockId}`);
  await expect(page.getByLabel("Widget name", { exact: true })).toHaveValue(
    "Browser Clock",
  );
  await expect(page.getByText("Preview ready.", { exact: true })).toBeVisible();
});

test("author a typed Data Source and retrieve its saved rows", async ({
  page,
}) => {
  await page.goto("/data-sources/new/manual");
  await page.getByLabel("Name", { exact: true }).fill("Browser announcements");
  await page.getByLabel("Title", { exact: true }).fill("Library opens at nine");
  const savedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/data-sources") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Save Data Source", exact: true })
    .click();
  const response = await savedResponse;
  expect(response.ok(), await response.text()).toBe(true);
  const sourceId = (await response.json()).data.id;
  await page.goto(`/data-sources/${sourceId}`);
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Browser announcements",
  );
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "Library opens at nine",
  );
});

test("save organization settings and restore them with demo-reset", async ({
  page,
}) => {
  await page.goto("/settings/general");
  const organization = page.getByRole("textbox", {
    name: "Organization name",
    exact: true,
  });
  await organization.fill("Browser test district");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(organization).toHaveValue("Browser test district");
  await resetDemo(page.request);
  await page.reload();
  await expect(organization).toHaveValue("Tilecast Demo District");
});

test("installed plugin content opens through Studio discovery", async ({
  page,
}) => {
  await page.goto("/plugins");
  await page.getByRole("link", { name: "Open", exact: true }).click();
  await expect(page).toHaveURL(/\/plugins\/countdown-bar$/);
  await expect(page.getByText("Lunch ends", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});
