import { chromium, expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backend,
  colorImage,
  colorVideo,
  eventually,
  expectPixel,
  freshLimits,
  hex,
  imagePlaylist,
  launch,
  nudge,
  outbox,
  playbackOf,
  setLifecycle,
  setVisibility,
  Studio,
} from "./support";

/**
 * Proof of play, read from Tilecast's own Activity reports. These tests ask
 * the server what it recorded. They never inspect only what the browser
 * believes it sent.
 */
test.describe.configure({ mode: "serial" });
let studio: Studio;
test.beforeAll(async () => {
  await freshLimits();
  studio = await Studio.connect();
});
test.afterAll(async () => {
  await backend("start").catch(() => undefined);
  await studio.dispose();
});

const CENTER: [number, number] = [640, 360];
const RED = hex("FF0000");
const GREEN = hex("00FF00");

test("an image playlist is proof: a root presentation, an item per play, and expected boundaries", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const slot = await studio.createSlot("Proof images");
  const { playlist, assets } = await imagePlaylist(studio, "proof", [
    "FF0000",
    "00FF00",
  ]);
  await launch(page, slot);
  await studio.assign(slot.screenId, { playlistId: playlist });
  await expectPixel(page, CENTER, RED);
  await expectPixel(page, CENTER, GREEN, { timeout: 30_000 });
  await expectPixel(page, CENTER, RED, { timeout: 30_000 });
  await nudge(page);
  const sessions = await eventually(async () => {
    const found = playbackOf(await studio.proof(slot.screenId));
    return found.plays.filter((play) => play.endedAt).length >= 2
      ? found
      : undefined;
  }, "the server to record two finished plays");
  expect(sessions.roots).toHaveLength(1);
  expect(sessions.roots[0]).toMatchObject({
    presentationType: "playlist",
    presentationId: playlist,
    trigger: "direct",
  });
  const finished = sessions.plays.filter((play) => play.endedAt);
  expect(finished.length).toBeGreaterThanOrEqual(2);
  expect(new Set(finished.map((play) => play.contentType))).toEqual(
    new Set(["image"]),
  );
  for (const play of finished) {
    expect(play.sessionType).toBe("playlist_item");
    expect(play.terminalReason).toBe("expected_item_boundary");
    expect(play.expectedDurationMs).toBe(4000);
    // Measured against the monotonic clock, close to the authored duration.
    expect(play.actualDurationMs).toBeGreaterThan(3000);
    expect(play.actualDurationMs).toBeLessThan(6500);
  }
  expect(new Set(finished.map((play) => play.id)).size).toBe(finished.length);
  void assets;
});

test("a video is proof, and a manual skip ends the item as a skip", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const slot = await studio.createSlot("Proof video and skip");
  const video = await studio.uploadAsset(
    colorVideo("proof-video", "0000FF", 8),
    "video/mp4",
  );
  const first = await studio.uploadAsset(
    colorImage("skip-a", "FF0000"),
    "image/png",
  );
  const second = await studio.uploadAsset(
    colorImage("skip-b", "00FF00"),
    "image/png",
  );
  const playlist = await studio.playlist("proof-video", [
    { assetId: video, durationMs: 8000 },
    { assetId: first, durationMs: 60_000 },
    { assetId: second, durationMs: 60_000 },
  ]);
  await launch(page, slot);
  await studio.assign(slot.screenId, { playlistId: playlist });
  await expectPixel(page, CENTER, hex("0000FF"), { tolerance: 40 });
  // The video runs to its end. The first image then holds for a minute.
  await expectPixel(page, CENTER, RED, { timeout: 40_000 });
  const videoPlay = await eventually(async () => {
    await nudge(page);
    const dump = playbackOf(await studio.proof(slot.screenId));
    return dump.plays.find(
      (play) => play.contentType === "video" && play.endedAt,
    );
  }, "the video play to be recorded");
  expect(videoPlay.terminalReason).toBe("expected_item_boundary");
  expect(videoPlay.actualDurationMs).toBeGreaterThan(6000);

  // Skip the image through the typed command Studio sends.
  const queued = await studio.command(slot.screenId, "skip_current_item");
  await expectPixel(page, CENTER, GREEN, { timeout: 40_000 });
  await eventually(
    async () =>
      (await studio.commands(slot.screenId)).items.find(
        (command) => command.id === queued.id && command.state === "succeeded",
      ),
    "the skip command to succeed",
  );
  const skipped = await eventually(async () => {
    await nudge(page);
    return playbackOf(await studio.proof(slot.screenId)).plays.find(
      (play) => play.terminalReason === "manual_skip",
    );
  }, "the skipped play to be recorded");
  expect(skipped).toMatchObject({ result: "skipped", contentType: "image" });
  expect(skipped.actualDurationMs).toBeLessThan(40_000);
});

test("a Layout is one presentation with one play, and a takeover ends it for the takeover's reason", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const slot = await studio.createSlot("Proof layout and takeover");
  const background = await studio.uploadAsset(
    colorImage("layout-bg", "0000FF"),
    "image/png",
  );
  const layout = await studio.layout(
    "Proof layout",
    { width: 1280, height: 720, backgroundColor: "#000000" },
    [
      {
        id: "full",
        type: "asset",
        assetId: background,
        x: 0,
        y: 0,
        width: 1280,
        height: 720,
        layer: 0,
        opacity: 1,
        visible: true,
      },
    ],
  );
  const emergency = await imagePlaylist(
    studio,
    "takeover-proof",
    ["FF0000"],
    30,
  );
  await launch(page, slot);
  await studio.assign(slot.screenId, { layoutId: layout });
  await expectPixel(page, CENTER, hex("0000FF"), { tolerance: 40 });
  const layoutRoot = await eventually(async () => {
    await nudge(page);
    return playbackOf(await studio.proof(slot.screenId)).roots.find(
      (root) => root.presentationType === "layout",
    );
  }, "the Layout presentation to be recorded");
  expect(layoutRoot.presentationId).toBe(layout);

  const takeover = await studio.takeover(slot.screenId, emergency.playlist);
  await expectPixel(page, CENTER, RED, { timeout: 40_000 });
  const ended = await eventually(async () => {
    await nudge(page);
    const { roots } = playbackOf(await studio.proof(slot.screenId));
    const old = roots.find((root) => root.presentationType === "layout");
    return old?.endedAt && roots.some((root) => root.takeoverId === takeover.id)
      ? { old, roots }
      : undefined;
  }, "the takeover to replace the Layout in the report");
  expect(ended.old.terminalReason).toBe("takeover");
  const takeoverRoot = ended.roots.find(
    (root) => root.takeoverId === takeover.id,
  )!;
  expect(takeoverRoot).toMatchObject({
    trigger: "takeover",
    presentationType: "playlist",
  });

  // Ending the takeover returns to the Layout and closes the takeover's session.
  await studio.call(
    "post",
    `/api/v1/takeovers/${takeover.id}/cancel`,
    {},
    [200, 204],
  );
  await expectPixel(page, CENTER, hex("0000FF"), {
    tolerance: 40,
    timeout: 40_000,
  });
  const closed = await eventually(async () => {
    await nudge(page);
    return playbackOf(await studio.proof(slot.screenId)).roots.find(
      (root) => root.takeoverId === takeover.id && root.endedAt,
    );
  }, "the takeover presentation to end");
  expect(closed.terminalReason).toBeTruthy();
});

test("a brief outage loses nothing: plays are queued durably and flushed once, across a reload", async () => {
  test.setTimeout(240_000);
  const slot = await studio.createSlot("Proof outage");
  const { playlist } = await imagePlaylist(
    studio,
    "outage",
    ["FF0000", "00FF00"],
    4,
  );
  const userData = mkdtempSync(join(tmpdir(), "tilecast-activity-profile-"));
  const open = () =>
    chromium.launchPersistentContext(userData, {
      ignoreHTTPSErrors: true,
      args: ["--ignore-certificate-errors"],
      viewport: { width: 1280, height: 720 },
      baseURL: "https://localhost:18981",
    });
  try {
    let context = await open();
    let page = context.pages()[0] ?? (await context.newPage());
    await launch(page, slot);
    await studio.assign(slot.screenId, { playlistId: playlist });
    await expectPixel(page, CENTER, RED);
    const before = await eventually(async () => {
      await nudge(page);
      return playbackOf(await studio.proof(slot.screenId)).plays.length > 0;
    }, "playback to be proven online");
    expect(before).toBe(true);

    // The server goes away. Playback continues from the verified activation.
    await backend("stop");
    await expectPixel(page, CENTER, GREEN, { timeout: 30_000 });
    await expectPixel(page, CENTER, RED, { timeout: 30_000 });
    const queued = await eventually(
      async () => {
        const entries = await outbox(page);
        return entries.filter(
          (entry) => entry.eventType === "content.completed",
        ).length >= 2
          ? entries
          : undefined;
      },
      "finished plays to be queued while the server is down",
      30_000,
    );
    // The queue is durable: it survives closing the browser entirely.
    const queuedIds = queued.map((entry) => entry.id);
    await context.close();
    context = await open();
    page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`/player/${slot.id}`);
    await expectPixel(page, CENTER, RED, { timeout: 60_000 });
    const afterReload = await outbox(page);
    expect(afterReload.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(queuedIds),
    );

    // Nothing was uploaded while the server was unreachable. It flushes after.
    await backend("start");
    await nudge(page);
    await eventually(
      async () => (await outbox(page)).length === 0,
      "the queue to drain",
      60_000,
    );
    const proof = playbackOf(await studio.proof(slot.screenId));
    // Every play recorded during the outage reached the server, once.
    expect(
      proof.plays.filter((play) => play.endedAt).length,
    ).toBeGreaterThanOrEqual(4);
    expect(new Set(proof.plays.map((play) => play.id)).size).toBe(
      proof.plays.length,
    );
    // The session that was open when the browser closed was ended, not left open.
    expect(
      proof.roots.filter((root) => !root.endedAt).length,
    ).toBeLessThanOrEqual(1);
    await context.close();
  } finally {
    await backend("start").catch(() => undefined);
    rmSync(userData, { recursive: true, force: true });
  }
});

test("a hidden or frozen page is not proof, and an incident says so", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const slot = await studio.createSlot("Proof hidden");
  const { playlist } = await imagePlaylist(
    studio,
    "hidden",
    ["FF0000", "00FF00"],
    4,
  );
  await launch(page, slot);
  await studio.assign(slot.screenId, { playlistId: playlist });
  await expectPixel(page, CENTER, RED);
  await eventually(async () => {
    await nudge(page);
    return playbackOf(await studio.proof(slot.screenId)).roots.length === 1;
  }, "playback to be proven");

  await setVisibility(page, "hidden");
  const hiddenAt = Date.now();
  const closedRoot = await eventually(async () => {
    await nudge(page);
    return playbackOf(await studio.proof(slot.screenId)).roots.find(
      (root) => root.endedAt,
    );
  }, "the root session to end when the page is hidden");
  // No evidence is not an interruption: the reason is `unknown`.
  expect(closedRoot.terminalReason).toBe("unknown");
  const reliability = await eventually(async () => {
    const value = await studio.reliability(slot.screenId);
    return value["foregroundState"] === "background" ? value : undefined;
  }, "the server to learn the page is in the background");
  expect(
    (reliability["browser"] as Record<string, unknown>)["browserName"],
  ).toBeTruthy();
  const incident = await eventually(
    async () =>
      (await studio.incidents(slot.screenId)).items.find(
        (item) =>
          item.incidentType === "playback" && item.status !== "resolved",
      ),
    "a playback incident for the hidden page",
  );
  expect(incident.title).toContain("not on screen");

  // Nothing that plays while hidden is recorded as a play.
  await page.waitForTimeout(9_000);
  await nudge(page);
  const hiddenPlays = playbackOf(
    await studio.proof(slot.screenId),
  ).plays.filter((play) => Date.parse(play.startedAt) > hiddenAt);
  expect(hiddenPlays).toEqual([]);

  // Visible again: a new presentation begins and the incident resolves.
  await setVisibility(page, "visible");
  await eventually(async () => {
    await nudge(page);
    const { roots } = playbackOf(await studio.proof(slot.screenId));
    return roots.length >= 2 && roots.some((root) => !root.endedAt);
  }, "a new presentation session after the page is visible");
  const resolved = await eventually(async () => {
    const value = await studio.reliability(slot.screenId);
    return value["foregroundState"] === "foreground";
  }, "the server to see the foreground again");
  expect(resolved).toBe(true);

  // Freezing is the browser's own lifecycle state. A frozen page runs nothing.
  await setLifecycle(page, "frozen");
  await page.waitForTimeout(1_500);
  await setLifecycle(page, "active");
  await eventually(async () => {
    await nudge(page);
    const value = await studio.reliability(slot.screenId);
    return value["foregroundState"] === "foreground";
  }, "the page to be reconciled after it resumes");
});
