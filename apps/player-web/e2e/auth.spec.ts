import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  Studio,
  freshLimits,
  launch,
  sessionOf,
  sha256Hex,
  type Launch,
} from "./support";

let studio: Studio;
// Challenge, renewal and sign-in share one rate limit that real clients must
// respect, so each test starts the server with empty limits.
test.beforeEach(async () => {
  await freshLimits();
  studio = await Studio.connect();
});
test.afterEach(async () => {
  await studio.dispose();
});

const requests = (page: Page) => {
  const seen: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/v1/player/browser/"))
      seen.push(`${request.method()} ${url.pathname.split("/").pop()}`);
  });
  return seen;
};

async function disconnected(page: Page): Promise<void> {
  await expect(
    page.getByText("Browser Player disconnected", { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
}

test("managed recovery binds once, boots the exact Runtime and isolates Player cookies", async ({
  page,
  context,
}) => {
  const slot = await studio.createSlot();
  await launch(page, slot);
  const response = await sessionOf(page, slot.id);
  expect(response.status).toBe(200);
  expect(response.body.data.screenId).toBe(slot.screenId);
  expect(JSON.stringify(response.body)).not.toContain(slot.recoverySecret);
  const cookie = (await context.cookies()).find(
    (value) => value.name === `__Host-tilecast_player_${slot.id}`,
  );
  expect(cookie).toMatchObject({
    secure: true,
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
  });
  // JavaScript can read no session material, and the Studio API refuses it.
  expect(await page.evaluate(() => document.cookie)).not.toContain(
    "tilecast_player",
  );
  expect(
    await page.evaluate(async () => (await fetch("/api/v1/screens")).status),
  ).toBe(401);
  const scripts = await page
    .locator("script[src]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("src")));
  expect(
    scripts.some((src) =>
      /^\/player\/runtime\/[a-f0-9]{24}\/runtime.js$/.test(src ?? ""),
    ),
  ).toBe(true);
  // The Runtime the Host loaded is byte-for-byte the one the package builds
  // for every other host, not a test substitute.
  const runtimeScript = scripts.find((src) => /runtime\.js$/.test(src ?? ""))!;
  const served = Buffer.from(
    await (await page.request.get(runtimeScript)).body(),
  );
  const built = readFileSync(
    new URL(
      "../../../packages/player-runtime/dist/runtime/runtime.js",
      import.meta.url,
    ),
  );
  expect(sha256Hex(served)).toBe(sha256Hex(built));
  // The recovery secret never reaches storage, history or the address bar.
  const persisted = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("tilecast-browser-player-v1");
      request.onsuccess = () => resolve(request.result);
    });
    const entries = await new Promise<unknown[]>((resolve) => {
      const request = db
        .transaction("identity")
        .objectStore("identity")
        .getAll();
      request.onsuccess = () => resolve(request.result);
    });
    db.close();
    return JSON.stringify(entries);
  });
  expect(persisted).not.toContain(slot.recoverySecret);
  expect(page.url()).not.toContain(slot.recoverySecret);
  // The Player has its own restrictive policy, distinct from Studio's.
  const player = await page.request.get("/player/");
  const studioPage = await page.request.get("/");
  const playerPolicy = player.headers()["content-security-policy"] ?? "";
  expect(playerPolicy).toContain("script-src 'self'");
  expect(playerPolicy).toContain("form-action 'none'");
  expect(playerPolicy).not.toBe(
    studioPage.headers()["content-security-policy"],
  );
});

test("a saved session cookie is reused without a new exchange", async ({
  page,
}) => {
  const slot = await studio.createSlot();
  await launch(page, slot);
  const before = await sessionOf(page, slot.id);
  const seen = requests(page);
  await page.goto(`/player/${slot.id}`);
  await expect(
    page.getByText("No content assigned", { exact: true }),
  ).toBeVisible();
  const after = await sessionOf(page, slot.id);
  expect(after.body.data.bindingId).toBe(before.body.data.bindingId);
  expect(after.body.data.epoch).toBe(before.body.data.epoch);
  expect(seen).toContain("GET session");
  expect(
    seen.filter((entry) => /recover|challenge|renew|enroll/.test(entry)),
  ).toEqual([]);
});

test("deleting the cookie renews silently with the device key and the server's exact message", async ({
  page,
  context,
}) => {
  const slot = await studio.createSlot();
  await launch(page, slot);
  const before = await sessionOf(page, slot.id);
  await context.clearCookies();
  const seen = requests(page);
  const challenged = page.waitForResponse((response) =>
    response.url().endsWith("/browser/challenge"),
  );
  await page.reload();
  const challenge = (await (await challenged).json()).data as {
    nonce: string;
    message: string;
  };
  // The server issued the signing text; the Chromium key signed exactly it.
  expect(challenge.message).toBe(
    `tilecast-browser-player-v1:${slot.id}:${before.body.data.bindingId}:${challenge.nonce}`,
  );
  await expect(
    page.getByText("No content assigned", { exact: true }),
  ).toBeVisible();
  const after = await sessionOf(page, slot.id);
  expect(after.status).toBe(200);
  expect(after.body.data.bindingId).toBe(before.body.data.bindingId);
  expect(after.body.data.epoch).toBe(before.body.data.epoch);
  expect(seen).toEqual(
    expect.arrayContaining(["POST challenge", "POST renew"]),
  );
  expect(seen).not.toContain("POST recover");
});

test("a replaced binding cannot renew or adopt the replacing browser's session", async ({
  page,
  browser,
}) => {
  const slot = await studio.createSlot();
  await launch(page, slot);
  const original = await sessionOf(page, slot.id);
  const regenerated = await studio.call<Launch>(
    "put",
    `/api/v1/screens/${slot.screenId}/browser/recovery`,
    { enabled: true },
  );
  // Another machine opens the regenerated launch link and becomes the owner.
  const other: BrowserContext = await browser.newContext({
    ignoreHTTPSErrors: true,
  });
  const second = await other.newPage();
  await launch(second, { ...slot, recoverySecret: regenerated.recoverySecret });
  const replacement = await sessionOf(second, slot.id);
  expect(replacement.body.data.epoch).toBe(original.body.data.epoch + 1);
  // The first machine's session is gone, its device key no longer renews, and
  // it never adopts the replacing machine's session.
  await page.reload();
  await disconnected(page);
  expect((await sessionOf(page, slot.id)).status).toBe(401);
  const challenge = await page.evaluate(
    async ([slotId, bindingId]) =>
      (
        await fetch("/api/v1/player/browser/challenge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slotId, bindingId }),
        })
      ).status,
    [slot.id, original.body.data.bindingId],
  );
  expect(challenge).toBe(401);
  // The replacing machine is unaffected.
  expect((await sessionOf(second, slot.id)).status).toBe(200);
  await other.close();
});

test("a revoked pairing cannot be revived by its key, cookie or launch link", async ({
  page,
  browser,
}) => {
  const slot = await studio.createSlot();
  await launch(page, slot);
  const original = await sessionOf(page, slot.id);
  await studio.revoke(slot.screenId);
  // The open page sees the withdrawal and shows the disconnected surface.
  await page.reload();
  await disconnected(page);
  expect((await sessionOf(page, slot.id)).status).toBe(401);
  const challenge = await page.evaluate(
    async ([slotId, bindingId]) =>
      (
        await fetch("/api/v1/player/browser/challenge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slotId, bindingId }),
        })
      ).status,
    [slot.id, original.body.data.bindingId],
  );
  expect(challenge).toBe(401);
  // The original managed launch link, opened on a clean browser, goes nowhere.
  const clean = await (
    await browser.newContext({ ignoreHTTPSErrors: true })
  ).newPage();
  await clean.goto(`/player/${slot.id}#r=${slot.recoverySecret}`);
  await disconnected(clean);
  expect((await sessionOf(clean, slot.id)).status).toBe(401);
});
