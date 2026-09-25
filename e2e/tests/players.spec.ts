import { expect, test } from "@playwright/test";
import { csrfToken, ids, player, resetDemo } from "../support/demo";

// These tests watch the simulated players, which speak the real player
// protocol, react to changes made through the dashboard API.

test.beforeEach(async ({ page }) => {
  await resetDemo(page.request);
});

test("an assignment change reaches the online player's manifest", async ({
  page,
}) => {
  const before = await player(page.request, ids.staffLounge);
  expect(before.connected).toBe(true);

  const response = await page.request.put(
    `/api/v1/screens/${ids.staffLounge}/playlist-assignment`,
    {
      headers: { "X-CSRF-Token": await csrfToken(page.request) },
      data: { playlistId: ids.morningAnnouncements },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);

  // The server invalidates the manifest and notifies the socket; the player
  // downloads the new manifest and reports its version.
  await expect
    .poll(
      async () => (await player(page.request, ids.staffLounge)).manifestVersion,
    )
    .toBeGreaterThan(before.manifestVersion);

  await page.goto(`/screens/${ids.staffLounge}`);
  await expect(page.getByText("Morning Announcements").first()).toBeVisible();
});

test("an Identify command is delivered, acknowledged, and completed", async ({
  page,
}) => {
  const created = await page.request.post(
    `/api/v1/screens/${ids.cafeteriaEast}/commands`,
    {
      headers: { "X-CSRF-Token": await csrfToken(page.request) },
      data: { type: "identify_screen", payload: { durationSeconds: 30 } },
    },
  );
  expect(created.status(), await created.text()).toBe(202);
  const command = (await created.json()).data.id as string;

  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/api/v1/screens/${ids.cafeteriaEast}/commands`,
      );
      const items = (await response.json()).data.items as {
        id: string;
        state: string;
        resultCode?: string;
      }[];
      const found = items.find((item) => item.id === command);
      return found && `${found.state}:${found.resultCode}`;
    })
    .toBe("succeeded:screen_identified");
  expect((await player(page.request, ids.cafeteriaEast)).lastCommand).toBe(
    "identify_screen",
  );
});
