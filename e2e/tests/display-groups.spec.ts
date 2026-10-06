import { expect, test, type Page } from "@playwright/test";
import { ids, resetDemo } from "../support/demo";

// Display Groups against the real Demo Mode server: the index in both
// layouts, the detail workspace, Add screens as a Sheet and a Drawer, the
// Playback combobox, Mirror and Span, and the unsaved-work prompts.
const group = `/groups/${ids.cafeteriaDisplays}`;

test.beforeEach(async ({ page }) => {
  await resetDemo(page.request);
});

async function groupMode(page: Page) {
  const response = await page.request.get(
    `/api/v1/screen-groups/${ids.cafeteriaDisplays}`,
  );
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { data: { displayMode: string } }).data
    .displayMode;
}

test.describe("desktop", () => {
  test("the index compares groups in a table and searches on the server", async ({
    page,
  }) => {
    await page.goto("/groups");
    await expect(
      page.getByRole("heading", { level: 1, name: "Display Groups" }),
    ).toBeAttached();
    const headers = page.getByRole("columnheader");
    await expect(headers).toHaveText([
      "Display Group",
      "Screens",
      "Mode",
      "Fallback",
      "Actions",
    ]);
    await expect(
      page.getByRole("row", { name: /Cafeteria Displays/ }),
    ).toContainText("all online");
    await expect(page.getByText(/need(s)? attention/).first()).toBeVisible();

    const search = page.getByRole("searchbox", {
      name: "Search Display Groups",
    });
    await search.fill("cafeteria");
    await expect(page).toHaveURL(/q=cafeteria/);
    await expect(page.getByRole("row")).toHaveCount(2);
    await search.fill("zzzz");
    await expect(
      page.getByText("No Display Groups match “zzzz”"),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Clear search", exact: true })
      .click();
    await expect(page.getByRole("row").nth(1)).toBeVisible();
  });

  test("creating a group continues to its empty Screens tab", async ({
    page,
  }) => {
    await page.goto("/groups");
    await page.getByRole("button", { name: "Create group" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Name" }).fill("Gym Wall");
    await dialog
      .getByRole("textbox", { name: "Description" })
      .fill("Court TVs");
    await dialog.getByRole("button", { name: "Create group" }).click();
    await expect(page).toHaveURL(/\/groups\/[0-9a-f-]+\?tab=members/);
    await expect(page.getByRole("heading", { name: "Gym Wall" })).toBeVisible();
    await expect(page.getByText("No screens in this group")).toBeVisible();
  });

  test("the detail workspace shows Overview and the Screens table", async ({
    page,
  }) => {
    await page.goto(group);
    await expect(
      page.getByRole("heading", { name: "Cafeteria Displays" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Show now" })).toBeVisible();
    await expect(page.getByRole("button", { name: "AirPlay" })).toBeVisible();
    await expect(page.getByRole("tab")).toHaveText([
      "Overview",
      "Screens",
      "Playback",
      "Display",
      "Player policy",
    ]);
    const overview = page.getByRole("tabpanel");
    await expect(overview.getByRole("listitem")).toHaveCount(3);

    await page.getByRole("tab", { name: "Screens" }).click();
    await expect(page).toHaveURL(/tab=members/);
    await expect(
      page.getByRole("link", { name: "Cafeteria East" }),
    ).toBeVisible();
    await expect(page.getByRole("columnheader")).toHaveText([
      "Screen",
      "Location",
      "Status",
      "Actions",
    ]);
  });

  test("Add screens opens a Sheet that explains screens owned by another group", async ({
    page,
  }) => {
    await page.goto(`${group}?tab=members`);
    await page.getByRole("button", { name: "Add screens" }).first().click();
    const sheet = page.getByRole("dialog", { name: "Add screens" });
    await expect(sheet).toBeVisible();
    await expect(
      sheet.getByRole("checkbox", { name: "Select Staff Lounge" }),
    ).toBeVisible();
    await expect(
      sheet.getByText("Already in another Display Group"),
    ).toBeVisible();
    await expect(
      sheet.getByRole("checkbox", { name: "Select Gym Lobby" }),
    ).toHaveAttribute("aria-disabled", "true");
    await expect(
      sheet.getByRole("link", { name: "View group" }).first(),
    ).toBeVisible();

    await sheet.getByText("Staff Lounge").click();
    await sheet.getByRole("button", { name: "Add 1 screen" }).click();
    await expect(sheet).toBeHidden();
    await expect(
      page.getByRole("link", { name: "Staff Lounge" }),
    ).toBeVisible();
  });

  test("Playback offers a grouped searchable fallback picker", async ({
    page,
  }) => {
    await page.goto(`${group}?tab=content`);
    const save = page.getByRole("button", { name: "Save changes" });
    await expect(save).toBeDisabled();
    await page.getByRole("combobox", { name: "Presentation" }).click();
    await expect(
      page.getByRole("listbox").getByText("Playlists", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("option", { name: "No fallback presentation" }),
    ).toBeVisible();
    await page.getByRole("option", { name: "General Information" }).click();
    await expect(save).toBeEnabled();
  });

  test("Display shows Mirror, then a Span draft that only saves on request", async ({
    page,
  }) => {
    await page.goto(`${group}?tab=display`);
    await expect(page.getByRole("radio", { name: /Mirror/ })).toBeChecked();
    await expect(page.getByRole("button", { name: "Power off" })).toBeVisible();

    await page.getByRole("radio", { name: /Span/ }).click();
    await expect(page.getByLabel("Canvas width")).toHaveValue("3840");
    await expect(
      page.getByText("This wall has not been saved yet."),
    ).toBeVisible();
    expect(await groupMode(page)).toBe("mirror");

    await page.getByRole("button", { name: "Save wall" }).click();
    await expect(
      page.getByText("This wall has not been saved yet."),
    ).toBeHidden();
    expect(await groupMode(page)).toBe("span");
  });

  test("unsaved Span edits prompt before leaving the tab", async ({ page }) => {
    await page.goto(`${group}?tab=display`);
    await page.getByRole("radio", { name: /Span/ }).click();
    await page.getByRole("button", { name: "Save wall" }).click();
    await expect(
      page.getByText("This wall has not been saved yet."),
    ).toBeHidden();

    const width = page.getByLabel("Canvas width");
    await width.fill("5000");
    await page.getByRole("tab", { name: "Screens" }).click();
    const prompt = page.getByRole("dialog", {
      name: "Discard unsaved wall changes?",
    });
    await expect(prompt).toBeVisible();
    await prompt.getByRole("button", { name: "Keep editing" }).click();
    await expect(page).toHaveURL(/tab=display/);
    await expect(width).toHaveValue("5000");

    await page.getByRole("tab", { name: "Screens" }).click();
    await page.getByRole("button", { name: "Discard changes" }).click();
    await expect(page).toHaveURL(/tab=members/);
    await page.getByRole("tab", { name: "Display" }).click();
    await expect(page.getByLabel("Canvas width")).toHaveValue("3840");
  });

  test("an unsaved Player policy edit prompts before leaving the tab", async ({
    page,
  }) => {
    await page.goto(`${group}?tab=policy`);
    await page
      .getByRole("tabpanel")
      .getByText("Playback", { exact: true })
      .click();
    await page
      .getByRole("tabpanel")
      .getByRole("switch", { name: "Override" })
      .first()
      .click();
    await expect(
      page.getByRole("tab", { name: /Player policy.*Unsaved/ }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "Overview" }).click();
    await expect(
      page.getByRole("dialog", { name: "Discard unsaved group settings?" }),
    ).toBeVisible();
  });

  test("a group that does not exist says so", async ({ page }) => {
    await page.goto("/groups/de300004-0000-4000-8000-0000000000ff");
    await expect(
      page.getByRole("heading", { name: "Display Group not found" }),
    ).toBeVisible();
  });
});

test.describe("compact", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("the index lists groups as rows, not a table", async ({ page }) => {
    await page.goto("/groups");
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Cafeteria Displays" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Actions for Cafeteria Displays" }),
    ).toBeVisible();
  });

  test("Add screens opens a Drawer", async ({ page }) => {
    await page.goto(`${group}?tab=members`);
    await page.getByRole("button", { name: "Add screens" }).first().click();
    const drawer = page.getByRole("dialog", { name: "Add screens" });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("checkbox", { name: "Select Staff Lounge" }).click();
    await expect(
      drawer.getByRole("button", { name: "Add 1 screen" }),
    ).toBeVisible();
  });
});
