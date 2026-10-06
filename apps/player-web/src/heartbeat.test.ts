import { expect, it } from "vitest";
import { heartbeatPayload } from "./heartbeat";

const support = {
  presentationSchemas: [1, 2, 3],
  declarativeCapabilities: { "content.text": 1 },
  widgetComponents: { "widget.tilecast.clock": 2 },
};

it("reports the Runtime's capability names exactly as the contract defines them", () => {
  const payload = heartbeatPayload({
    screenWidth: 1280,
    screenHeight: 720,
    hostVersion: "0.1.0",
    uptimeSeconds: 12.7,
    playing: true,
    support,
  });
  expect(payload.playerFamily).toBe("browser");
  expect(payload.nativePresentationCapabilities).toEqual({
    "content.text": 1,
    "widget.tilecast.clock": 2,
  });
  expect(payload.presentationSchemaVersions).toEqual([1, 2, 3]);
  expect(payload.uptimeSeconds).toBe(12);
});

it("repeats the server's selection and omits what it does not know", () => {
  const playlistId = "11111111-1111-4111-8111-111111111111";
  const payload = heartbeatPayload({
    screenWidth: 0,
    screenHeight: 0,
    hostVersion: "0.1.0",
    uptimeSeconds: 1,
    playing: false,
    support,
    currentItemId: "not-a-uuid",
    selection: {
      source: "schedule",
      contentType: "playlist",
      contentId: playlistId,
      selectionId: null,
      playlistId,
      layoutId: null,
      scheduleId: null,
      takeoverId: null,
      nextTransitionAt: "2026-10-01T12:00:00.000Z",
    },
  });
  expect(payload).toMatchObject({
    screenWidth: 1,
    screenHeight: 1,
    playbackState: "idle",
    selectionSource: "schedule",
    currentPlaylistId: playlistId,
    nextTransitionAt: "2026-10-01T12:00:00.000Z",
  });
  expect(payload).not.toHaveProperty("currentItemId");
  expect(payload).not.toHaveProperty("activeManifestVersion");
});
