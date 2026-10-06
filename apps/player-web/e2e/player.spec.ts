import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

const origin = "https://localhost:18981";
let admin: APIRequestContext;
let csrf: string;
test.describe.configure({ mode: "serial" });
interface Launch {
  id: string;
  screenId: string;
  recoverySecret: string;
}
test.beforeAll(async () => {
  admin = await request.newContext({
    baseURL: origin,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { Origin: origin },
  });
  const setup = await admin.post("/api/v1/auth/setup", {
    data: {
      organizationName: "Browser qualification",
      ownerName: "Test owner",
      username: "browser-test",
      password: crypto.randomUUID() + crypto.randomUUID(),
    },
  });
  expect(setup.status()).toBe(201);
  csrf = (await setup.json()).data.csrfToken as string;
});
test.afterAll(async () => {
  await admin.dispose();
});

async function createSlot(): Promise<Launch> {
  const response = await admin.post("/api/v1/screens/browser", {
    headers: { "X-CSRF-Token": csrf },
    data: {
      name: "Browser qualification",
      roomName: "Test room",
      roomNumber: "1",
      description: "Ephemeral browser test",
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).data as Launch;
}
async function launch(page: Page, slot: Launch): Promise<void> {
  page.on("response", (response) => {
    if (response.status() === 422)
      void response
        .json()
        .then((body) => console.error("Validation:", body.error));
  });
  page.on("pageerror", (error) =>
    console.error("Browser Host error:", error.message),
  );
  page.on("console", (message) => {
    if (message.type() === "error")
      console.error("Browser console:", message.text());
  });
  await page.goto(`/player/${slot.id}#r=${slot.recoverySecret}`);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
  await expect(page.locator("tc-player")).toBeVisible();
  await expect(
    page.getByText("No content assigned", { exact: true }),
  ).toBeVisible();
}
async function session(page: Page, slotId: string) {
  return page.evaluate(async (slot) => {
    const response = await fetch("/api/v1/player/browser/session", {
      headers: { "X-Tilecast-Player-Slot": slot },
    });
    return { status: response.status, body: await response.json() };
  }, slotId);
}

test("managed recovery boots the exact Runtime, scrubs the fragment and isolates Player cookies", async ({
  page,
  context,
}) => {
  const slot = await createSlot();
  await launch(page, slot);
  const response = await session(page, slot.id);
  expect(response.status).toBe(200);
  expect(response.body.data.screenId).toBe(slot.screenId);
  expect(JSON.stringify(response.body)).not.toContain(slot.recoverySecret);
  const cookie = (await context.cookies()).find(
    (cookie) => cookie.name === `__Host-tilecast_player_${slot.id}`,
  );
  expect(cookie).toMatchObject({
    secure: true,
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
  });
  expect(await page.evaluate(() => document.cookie)).not.toContain(
    "tilecast_player",
  );
  expect(
    await page.evaluate(async () => (await fetch("/api/v1/screens")).status),
  ).toBe(401);
  const scripts = await page
    .locator("script[src]")
    .evaluateAll((scripts) =>
      scripts.map((script) => script.getAttribute("src")),
    );
  expect(
    scripts.some((src) =>
      /^\/player\/runtime\/[a-f0-9]{24}\/runtime.js$/.test(src ?? ""),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(async () => {
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
    }),
  ).not.toContain(slot.recoverySecret);
});

test("cookie deletion reauthenticates silently with the persisted CryptoKey", async ({
  page,
  context,
}) => {
  const slot = await createSlot();
  await launch(page, slot);
  const before = await session(page, slot.id);
  await context.clearCookies();
  await page.reload();
  await expect(
    page.getByText("No content assigned", { exact: true }),
  ).toBeVisible();
  const after = await session(page, slot.id);
  expect(after.status).toBe(200);
  expect(after.body.data.bindingId).toBe(before.body.data.bindingId);
  expect(after.body.data.epoch).toBe(before.body.data.epoch);
});

test("a second tab cannot operate an already running slot", async ({
  page,
  context,
}) => {
  const slot = await createSlot();
  await launch(page, slot);
  const other = await context.newPage();
  await other.goto(`/player/${slot.id}`);
  await expect(
    other.getByText(
      "This Browser Player is already running in another window.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("No content assigned", { exact: true }),
  ).toBeVisible();
});

test("plain /player shows the shared pairing surface and accepts existing Studio approval", async ({
  page,
}) => {
  await page.goto("/player");
  const pending = async () =>
    (await (await admin.get("/api/v1/screens/pairing/pending")).json()).data
      .items as { id: string; code: string; platform: string }[];
  await expect.poll(async () => (await pending()).length).toBeGreaterThan(0);
  const pairing = (await pending())[0]!;
  await expect(page.getByText(pairing.code, { exact: true })).toBeVisible();
  const approved = await admin.post(
    `/api/v1/screens/pairing/${pairing.id}/approve`,
    {
      headers: { "X-CSRF-Token": csrf },
      data: {
        name: "Paired browser",
        roomName: "",
        roomNumber: "",
        description: "",
      },
    },
  );
  expect(approved.status()).toBe(200);
  await expect(
    page.getByText("No content assigned", { exact: true }),
  ).toBeVisible();
});
