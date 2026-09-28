import { expect, test } from "@playwright/test";
import { csrfToken, ids, resetDemo, screens } from "../support/demo";

test.beforeEach(async ({ page }) => {
  await resetDemo(page.request);
});

test("opens Studio already signed in, with the demo banner", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("demo-mode-banner")).toContainText("Demo mode");
  await expect(page.getByLabel("Password")).toHaveCount(0);
});

test("the fleet shows every seeded screen in its computed status", async ({
  page,
}) => {
  const byName = new Map(
    (await screens(page.request)).map((screen) => [screen.name, screen.status]),
  );
  expect(byName.size).toBe(13);
  expect(byName.get("Cafeteria East")).toBe("online");
  expect(byName.get("Library")).toBe("recent");
  expect(byName.get("Board Room")).toBe("stale");
  expect(byName.get("Stadium Concourse")).toBe("offline");
  expect(byName.get("Middle School Main Hallway")).toBe("disabled");

  await page.goto("/screens");
  for (const name of [
    "Cafeteria East",
    "Board Room",
    "Stadium Concourse",
    "Staff Lounge",
  ]) {
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  }
});

test("a seeded screen opens by its stable ID", async ({ page }) => {
  await page.goto(`/screens/${ids.cafeteriaEast}`);
  await expect(
    page.getByRole("heading", { name: "Cafeteria East" }).first(),
  ).toBeVisible();
});

test("the playlist library lists the seeded playlists", async ({ page }) => {
  await page.goto("/playlists");
  for (const name of [
    "Morning Announcements",
    "Lunch Rotation",
    "Athletics",
    "General Information",
    "Spring Musical",
  ]) {
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  }
});

test("a real mutation is visible in Studio and a reset undoes it", async ({
  page,
}) => {
  const renamed = "General Information (edited in test)";
  const response = await page.request.patch(
    `/api/v1/playlists/${ids.generalInformation}`,
    {
      headers: { "X-CSRF-Token": await csrfToken(page.request) },
      data: { name: renamed, description: "Changed by the E2E suite." },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto("/playlists");
  await expect(page.getByText(renamed, { exact: true }).first()).toBeVisible();

  await resetDemo(page.request);
  await page.goto("/playlists");
  await expect(
    page.getByText("General Information", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText(renamed, { exact: true })).toHaveCount(0);
});

test("mutations without the session CSRF token are refused", async ({
  page,
}) => {
  await csrfToken(page.request);
  const response = await page.request.post("/api/v1/demo/reset", {
    data: { scenario: "basic" },
  });
  expect(response.status()).toBe(403);
});
