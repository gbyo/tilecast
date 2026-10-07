import { expect, test } from "@playwright/test";
import { Studio, freshLimits, launch, sessionOf, storage } from "./support";

let studio: Studio;
test.beforeAll(async () => {
  await freshLimits();
  studio = await Studio.connect();
});
test.afterAll(async () => {
  await studio.dispose();
});

test("a managed Browser Player installs and reopens as its own Screen", async ({
  page,
  context,
}) => {
  const slot = await studio.createSlot();
  await launch(page, slot);
  const href = await page
    .locator("link[rel=manifest]")
    .first()
    .getAttribute("href");
  expect(href).toBe(`/player/${slot.id}/manifest.webmanifest`);
  const manifest = await (await page.request.get(href!)).json();
  const route = `/player/${slot.id}/`;
  expect(manifest).toMatchObject({
    id: route,
    start_url: route,
    scope: route,
    display: "fullscreen",
  });
  // A recovery capability is never part of an installed identity.
  expect(JSON.stringify(manifest)).not.toContain(slot.recoverySecret);
  expect(manifest.start_url).not.toMatch(/[#?]/);

  // Launching the installed start URL later has no secret. It returns to the
  // same Screen with the saved session, then with the saved device key.
  const before = await sessionOf(page, slot.id);
  // Navigation returns while the Host is still starting, so wait for its first
  // completed reconciliation before the next step.
  const reopen = async () => {
    const reconciled = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/player/heartbeat") && response.ok(),
    );
    await page.goto(manifest.start_url);
    await reconciled;
  };
  await reopen();
  expect((await sessionOf(page, slot.id)).body.data.screenId).toBe(
    slot.screenId,
  );
  await context.clearCookies();
  await reopen();
  const after = await sessionOf(page, slot.id);
  expect(after.body.data.bindingId).toBe(before.body.data.bindingId);

  // Another slot has its own identity, and the generic Player keeps its own.
  const other = await studio.createSlot("Another Browser");
  expect(
    (
      await (
        await page.request.get(`/player/${other.id}/manifest.webmanifest`)
      ).json()
    ).id,
  ).toBe(`/player/${other.id}/`);
  await page.goto("/player/");
  expect(
    await page.locator("link[rel=manifest]").first().getAttribute("href"),
  ).toBe("/player/manifest.webmanifest");
  const generic = await (
    await page.request.get("/player/manifest.webmanifest")
  ).json();
  expect(generic).toMatchObject({ id: "/player", start_url: "/player/" });
});

test("plain /player shows the shared pairing surface and accepts existing Studio approval", async ({
  page,
}) => {
  await page.goto("/player");
  const code = await page.locator(".code").first().getAttribute("aria-label");
  expect(code).toMatch(/^[A-Z0-9]{6}$/);
  const pending = await studio.call<{ id: string }>(
    "post",
    "/api/v1/screens/pairing/resolve",
    { code },
  );
  await studio.call("post", `/api/v1/screens/pairing/${pending.id}/approve`, {
    name: "Paired browser",
    roomName: "",
    roomNumber: "",
    description: "",
  });
  await expect(
    page.getByText("No content assigned", { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  // Pairing enrolls a browser session, never a bearer credential in storage.
  expect(await page.evaluate(() => document.cookie)).not.toContain(
    "tilecast_player",
  );
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage })),
  ).not.toContain("tc_device_");
  const stored = await storage(page);
  expect(stored.identity).not.toContain("tc_device_");
  expect(stored.identity).not.toContain("pollSecret");
});
