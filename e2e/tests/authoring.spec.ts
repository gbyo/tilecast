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
  await width.fill("2000");
  await width.blur();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(width).toHaveValue("2000");
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = await popupPromise;
  await expect(preview).toHaveURL(/\/layouts\/[0-9a-f-]+\/preview$/);
  await expect(preview.locator(".layout-preview-frame")).toBeVisible();
});

test("backfills a real rendered Widget thumbnail for the library", async ({
  page,
}) => {
  const clockId = "de30000a-0000-4000-8000-000000000009";
  const uploaded = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/v1/widgets/${clockId}/preview-image`) &&
      response.request().method() === "PUT",
  );
  await page.goto("/widgets");
  expect((await uploaded).ok()).toBe(true);

  const card = page
    .getByRole("article")
    .filter({ hasText: "Lobby Clock" })
    .first();
  const image = card.locator("img");
  await expect(image).toBeVisible();
  await expect
    .poll(() =>
      image.evaluate(
        (node: HTMLImageElement) =>
          node.complete &&
          node.naturalWidth === 960 &&
          node.naturalHeight === 540,
      ),
    )
    .toBe(true);

  // A 960x540 JPEG existing is not enough: the old Shadow-DOM-blind capture
  // produced a valid but visually blank file. Verify the stored browser image
  // has meaningful contrast from the real Widget render.
  const luminanceRange = await image.evaluate((node: HTMLImageElement) => {
    const canvas = document.createElement("canvas");
    canvas.width = node.naturalWidth;
    canvas.height = node.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) return 0;
    context.drawImage(node, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let minimum = 255;
    let maximum = 0;
    // Sample every 16th pixel: enough to hit the large Clock glyphs without
    // making this smoke assertion expensive.
    for (let index = 0; index < pixels.length; index += 4 * 16) {
      const luminance =
        pixels[index]! * 0.2126 +
        pixels[index + 1]! * 0.7152 +
        pixels[index + 2]! * 0.0722;
      minimum = Math.min(minimum, luminance);
      maximum = Math.max(maximum, luminance);
    }
    return maximum - minimum;
  });
  expect(luminanceRange).toBeGreaterThan(40);

  const stored = await page.request.get(`/api/v1/assets/${clockId}`);
  expect(stored.ok()).toBe(true);
  expect((await stored.json()).data.metadata.widgetPreviewCaptureVersion).toBe(
    3,
  );
});

test("renders the real V2 Widget on the editable Layout canvas", async ({
  page,
}) => {
  const lobbyPortrait = "de300006-0000-4000-8000-000000000002";
  await page.goto(`/layouts/${lobbyPortrait}`);
  const widget = page.locator(".layout-canvas [data-tilecast-widget]").first();
  await expect(widget).toHaveCount(1);
  await expect
    .poll(() =>
      widget.evaluate(
        (element) => element.shadowRoot?.textContent?.trim() ?? "",
      ),
    )
    .not.toBe("");
  await expect
    .poll(() =>
      widget.evaluate((element: HTMLElement) => ({
        width: element.offsetWidth,
        height: element.offsetHeight,
      })),
    )
    .toEqual({ width: 1080, height: 480 });
});

test("save a Widget through the real authoring form and renderer", async ({
  page,
}) => {
  const clockId = "de30000a-0000-4000-8000-000000000009";
  await page.goto(`/widgets/${clockId}`);
  await expect(page.getByText("Preview ready.", { exact: true })).toBeVisible();
  await expect(page.locator("[data-tilecast-widget]")).toHaveCount(1);
  await page.getByLabel("Widget name", { exact: true }).fill("Browser Clock");
  const savedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/v1/widgets/${clockId}`) &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save Widget", exact: true }).click();
  const response = await savedResponse;
  expect(response.ok(), await response.text()).toBe(true);
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
  await page
    .getByRole("link", { name: "Open Countdown Bar", exact: true })
    .click();
  await expect(page).toHaveURL(/\/plugins\/countdown-bar$/);
  await expect(page.getByText("Lunch ends", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Manage", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Name", exact: true }),
  ).toHaveValue("Lunch ends");
});
