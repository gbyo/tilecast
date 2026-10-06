import { expect, test } from "@playwright/test";
import { csrfToken, ids, resetDemo } from "../support/demo";
import {
  choosePreviewFrame,
  expectWidgetRendered,
  openWidgetEditor,
  widgetFrameSize,
  widgetMount,
  widgetText,
} from "../support/widget-editor";

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
  const settings = page.getByRole("button", {
    name: "Layout settings",
    exact: true,
  });
  await settings.click();
  const width = page.getByRole("spinbutton", { name: "Width", exact: true });
  await width.fill("2000");
  await width.blur();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await settings.click();
  await expect(width).toHaveValue("2000");
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = await popupPromise;
  await expect(preview).toHaveURL(
    /\/layouts\/[0-9a-f-]+\/preview\?date=\d{4}-\d{2}-\d{2}$/,
  );
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
    4,
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

test("edit, save, and reopen a Widget in the one editor", async ({ page }) => {
  const clockId = "de30000a-0000-4000-8000-000000000009";
  const mount = await openWidgetEditor(page, `/widgets/${clockId}`);
  // The shared Widget component is what the preview shows. Mark it so the
  // edit below can prove the preview updated in place instead of remounting.
  await mount.evaluate((element) => {
    (window as unknown as { previewMount: Element }).previewMount = element;
  });
  // The seeded clock is a 12-hour time; seconds follow the AM/PM marker.
  const withSeconds = /\d{1,2}\s*:\s*\d{2}\s*(AM|PM)\s*\d{2}$/i;
  await expect.poll(() => widgetText(mount)).toMatch(/(AM|PM)$/i);

  // Change a real authoring field; the preview follows without saving.
  const toggle = page.getByRole("switch", { name: "Show seconds" });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect.poll(() => widgetText(mount)).toMatch(withSeconds);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { previewMount: Element }).previewMount ===
        document.querySelector("[data-tilecast-widget]"),
    ),
  ).toBe(true);
  await expect(
    page.getByText("Unsaved changes", { exact: true }),
  ).toBeVisible();

  // Save first. The thumbnail is captured afterward and never decides the save.
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/v1/widgets/${clockId}`) &&
      response.request().method() === "PATCH",
  );
  const thumbnail = page.waitForResponse((response) =>
    response.url().endsWith(`/api/v1/widgets/${clockId}/preview-image`),
  );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  const response = await saved;
  expect(response.ok(), await response.text()).toBe(true);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect((await thumbnail).ok()).toBe(true);

  // The Server holds the new configuration...
  const stored = await page.request.get(`/api/v1/assets/${clockId}`);
  expect((await stored.json()).data.widget.configuration.showSeconds).toBe(
    true,
  );

  // ...and a fresh editor shows it again.
  await page.reload();
  const reopened = await expectWidgetRendered(page);
  await expect(
    page.getByRole("switch", { name: "Show seconds" }),
  ).toBeChecked();
  await expect.poll(() => widgetText(reopened)).toMatch(withSeconds);
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeDisabled();
});

test("a new Layout placement takes the shape its Widget recommends", async ({
  page,
}) => {
  const hallwaySplit = "de300006-0000-4000-8000-000000000001";
  const csrf = await csrfToken(page.request);
  const source = await page.request.post("/api/v1/data-sources", {
    headers: { "X-CSRF-Token": csrf },
    data: {
      provider: "announcements",
      name: "Notices",
      description: "",
      configuration: { records: [] },
    },
  });
  expect(source.ok(), await source.text()).toBe(true);
  const ticker = await page.request.post("/api/v1/widgets", {
    headers: { "X-CSRF-Token": csrf },
    data: {
      provider: "ticker",
      name: "Headline Ticker",
      description: "",
      configuration: {
        dataSourceId: (await source.json()).data.id,
        primaryField: "",
        secondaryField: "",
        leadingLabel: "News",
        separator: " • ",
        fieldSeparator: " — ",
        maxItems: 15,
        direction: "left",
        speed: "normal",
        emptyText: "No news",
        backgroundColor: "",
        foregroundColor: "",
      },
    },
  });
  expect(ticker.ok(), await ticker.text()).toBe(true);

  await page.goto(`/layouts/${hallwaySplit}`);
  await expect(page.locator(".layout-canvas")).toBeVisible();
  const before = await page
    .locator(".layout-canvas [data-tilecast-widget]")
    .count();
  await page.getByRole("button", { name: "Add to canvas" }).click();
  await page.getByText("Headline Ticker", { exact: true }).first().click();
  const added = page.locator(".layout-canvas [data-tilecast-widget]");
  await expect(added).toHaveCount(before + 1);
  // The manifest declares a 1920 x 200 strip, so the placement on this
  // 1920 x 1080 canvas is wide and shallow, not 40% of the canvas (768 x 432).
  await expect
    .poll(() =>
      added.evaluateAll((elements) =>
        elements
          .map((element) => ({
            width: (element as HTMLElement).offsetWidth,
            height: (element as HTMLElement).offsetHeight,
          }))
          .find((box) => box.width / box.height > 5),
      ),
    )
    .toEqual({ width: 1536, height: 160 });
});

test("a strip Widget's library thumbnail is still 960 x 540", async ({
  page,
}) => {
  const csrf = await csrfToken(page.request);
  const source = await page.request.post("/api/v1/data-sources", {
    headers: { "X-CSRF-Token": csrf },
    data: {
      provider: "announcements",
      name: "Notices",
      description: "",
      configuration: { records: [] },
    },
  });
  expect(source.ok(), await source.text()).toBe(true);
  const created = await page.request.post("/api/v1/widgets", {
    headers: { "X-CSRF-Token": csrf },
    data: {
      provider: "ticker",
      name: "Strip Ticker",
      description: "",
      configuration: {
        dataSourceId: (await source.json()).data.id,
        primaryField: "",
        secondaryField: "",
        leadingLabel: "News",
        separator: " • ",
        fieldSeparator: " — ",
        maxItems: 15,
        direction: "left",
        speed: "normal",
        emptyText: "No news",
        backgroundColor: "",
        foregroundColor: "",
      },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);

  // The library captures a missing thumbnail from the real component. The
  // Ticker renders at its 1920 x 200 strip and is fitted into the canonical
  // frame, so the stored image keeps the canonical size.
  await page.goto("/widgets");
  const card = page
    .getByRole("article")
    .filter({ hasText: "Strip Ticker" })
    .first();
  const image = card.locator("img");
  await expect(image).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() =>
      image.evaluate((element: HTMLImageElement) => ({
        width: element.naturalWidth,
        height: element.naturalHeight,
      })),
    )
    .toEqual({ width: 960, height: 540 });
});

test("rename a Widget through its details and find the name saved", async ({
  page,
}) => {
  const clockId = "de30000a-0000-4000-8000-000000000009";
  await openWidgetEditor(page, `/widgets/${clockId}`);
  await page.getByRole("button", { name: "Lobby Clock", exact: true }).click();
  const details = page.getByRole("dialog", { name: "Widget details" });
  await details.getByRole("textbox", { name: "Name" }).fill("Browser Clock");
  await details.getByRole("button", { name: "Apply", exact: true }).click();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/v1/widgets/${clockId}`) &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  const response = await saved;
  expect(response.ok(), await response.text()).toBe(true);
  await openWidgetEditor(page, `/widgets/${clockId}`);
  await expect(
    page.getByRole("button", { name: "Browser Clock", exact: true }),
  ).toBeVisible();
});

test("a Widget that declares a recommended frame opens at it", async ({
  page,
}) => {
  // The Ticker's manifest declares a 1920 x 200 strip. The Server serves it
  // in the catalog and Studio opens the preview at it; any other Widget
  // keeps the 960 x 540 default.
  await openWidgetEditor(page, "/widgets/new/ticker");
  await expect(
    page.getByRole("combobox", { name: "Preview frame" }),
  ).toContainText("Recommended · 1920 × 200");
  await expect
    .poll(() => widgetFrameSize(widgetMount(page)))
    .toEqual({ width: 1920, height: 200 });

  await choosePreviewFrame(page, "Landscape · 16:9");
  await expect
    .poll(() => widgetFrameSize(widgetMount(page)))
    .toEqual({ width: 960, height: 540 });
  // Looking at another frame is not an edit.
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(
    0,
  );

  const clockId = "de30000a-0000-4000-8000-000000000009";
  await openWidgetEditor(page, `/widgets/${clockId}`);
  await expect(
    page.getByRole("combobox", { name: "Preview frame" }),
  ).toContainText("Landscape · 16:9");
  await expect
    .poll(() => widgetFrameSize(widgetMount(page)))
    .toEqual({ width: 960, height: 540 });
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
  // Wait for the Server to accept the save. The button also disappears while
  // the request is in flight, so a reload right after it would cancel the save.
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/v1/settings" &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  expect((await saved).ok()).toBe(true);
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
