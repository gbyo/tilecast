import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ActivityEventInput } from "./activity";
import {
  applyRendererEvent,
  PlaybackSessionTracker,
} from "./activity-sessions";

/**
 * The contract fixtures are shared with the Go server tests and the Kotlin
 * player tests, so a change to the vocabulary fails all three at once.
 */
const fixtures = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../../../packages/api-schema/activity/contract-v2-fixtures.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
) as {
  version: number;
  canonicalEventTypes: Record<string, string>;
  terminalReasons: Record<string, { expected: boolean | null }>;
  scenarios: {
    name: string;
    legacyAliasPlayers: string[];
    expected: { sessions: { activitySessionId: string }[] };
    emissions: { linux: Record<string, unknown>[] };
  }[];
};

/** A tracker with a pinned clock and predictable IDs. */
function tracker() {
  const events: ActivityEventInput[] = [];
  let clock = 1_000;
  let counter = 0;
  return {
    events,
    advance: (ms: number) => {
      clock += ms;
    },
    subject: new PlaybackSessionTracker(
      (event) => events.push(event),
      () => clock,
      () => `session-${++counter}`,
    ),
  };
}

describe("playback session tracking", () => {
  it("opens a root session and a child session inside it", () => {
    const { events, subject, advance } = tracker();

    subject.startPresentation({
      key: "playlist-a",
      presentationType: "playlist",
      presentationId: "playlist-a",
      trigger: "schedule",
      scheduleId: "schedule-a",
    });
    subject.startContent({
      contentId: "item-1",
      contentType: "video",
      playlistItemId: "item-1",
      expectedDurationMs: 30_000,
    });
    advance(30_000);
    subject.finishContent("completed", "completed_duration");
    advance(30_000);
    subject.stopPresentation("schedule_transition", "completed");

    expect(events.map((event) => event.eventType)).toEqual([
      "presentation.started",
      "content.started",
      "content.completed",
      "presentation.stopped",
    ]);
    const [root, childStart, childEnd, rootEnd] = events;
    // The end event must repeat the start's session ID, or the server has
    // nothing to close and the playback never becomes proof of play.
    expect(childEnd?.activitySessionId).toBe(childStart?.activitySessionId);
    expect(rootEnd?.activitySessionId).toBe(root?.activitySessionId);
    expect(childStart?.parentActivitySessionId).toBe(root?.activitySessionId);
    expect(childStart?.expectedDurationMs).toBe(30_000);
    expect(childEnd?.durationMs).toBe(30_000);
    expect(rootEnd?.durationMs).toBe(60_000);
    expect(rootEnd?.terminalReason).toBe("schedule_transition");
  });

  it("classifies the session type from the identifiers it carries", () => {
    const { events, subject } = tracker();
    subject.startContent({
      contentId: "zone-item",
      contentType: "widget",
      layoutPlacementId: "placement-1",
    });
    expect(events[0]?.sessionType).toBe("layout_placement");
  });

  it("ends the open child when its presentation is replaced", () => {
    const { events, subject, advance } = tracker();
    subject.startPresentation({
      key: "playlist-a",
      presentationType: "playlist",
      presentationId: "playlist-a",
    });
    subject.startContent({ contentId: "item-1", contentType: "image" });
    advance(5_000);
    subject.startPresentation({
      key: "playlist-b",
      presentationType: "playlist",
      presentationId: "playlist-b",
    });

    // A child may not outlive its parent, and both close for the same reason.
    expect(events.map((event) => event.eventType)).toEqual([
      "presentation.started",
      "content.started",
      "content.completed",
      "presentation.stopped",
      "presentation.started",
    ]);
    expect(events[2]?.terminalReason).toBe("manifest_replacement");
    expect(events[3]?.terminalReason).toBe("manifest_replacement");
  });

  it("does not restart the session when the same presentation re-resolves", () => {
    const { events, subject } = tracker();
    const context = {
      key: "playlist-a",
      presentationType: "playlist",
      presentationId: "playlist-a",
    };
    subject.startPresentation(context);
    subject.startPresentation(context);

    // Restarting here would truncate the measured duration of content that
    // never left the screen.
    expect(events).toHaveLength(1);
  });

  it("reports a renderer failure with an unexpected terminal reason", () => {
    const { events, subject, advance } = tracker();
    subject.startPresentation({
      key: "playlist-a",
      presentationType: "playlist",
      presentationId: "playlist-a",
    });
    subject.startContent({ contentId: "item-1", contentType: "video" });
    advance(12_000);
    subject.finishContent("failed", "renderer_failure", {
      code: "renderer_failure",
      message: "decode error",
    });

    const failure = events.at(-1);
    expect(failure?.eventType).toBe("content.failed");
    expect(failure?.result).toBe("failed");
    expect(failure?.terminalReason).toBe("renderer_failure");
    expect(fixtures.terminalReasons["renderer_failure"]?.expected).toBe(false);
  });

  it("closes everything still open at shutdown", () => {
    const { events, subject } = tracker();
    subject.startPresentation({
      key: "playlist-a",
      presentationType: "playlist",
      presentationId: "playlist-a",
    });
    subject.startContent({ contentId: "item-1", contentType: "image" });
    subject.shutdown();

    // Left open, these would be closed by the server's bounded timeout hours
    // later and reported as an interruption that never happened.
    expect(events.map((event) => event.terminalReason)).toEqual([
      undefined,
      undefined,
      "process_exit",
      "process_exit",
    ]);
  });
});

describe("degenerate playback", () => {
  const root = {
    key: "direct:playlist-a:1",
    presentationType: "playlist",
    presentationId: "playlist-a",
  };

  it("ignores a second start for the item already open", () => {
    const { events, subject, advance } = tracker();
    subject.startPresentation(root);
    const item = {
      contentId: "item-1",
      contentType: "image",
      playlistItemId: "item-1",
    };
    subject.startContent(item);
    advance(5);
    // The renderer remounting the same item is not a second play.
    subject.startContent(item);
    advance(30_000);
    subject.finishContent("completed", "expected_item_boundary");

    const types = events.map((event) => event.eventType);
    expect(types.filter((type) => type === "content.started")).toHaveLength(1);
    expect(types.filter((type) => type === "content.completed")).toHaveLength(
      1,
    );
    expect(
      events.find((event) => event.eventType === "content.completed")
        ?.durationMs,
    ).toBe(30_005);
  });

  it("still records a single-item playlist looping", () => {
    const { events, subject, advance } = tracker();
    subject.startPresentation(root);
    const item = {
      contentId: "item-1",
      contentType: "image",
      playlistItemId: "item-1",
    };
    subject.startContent(item);
    advance(10_000);
    // A loop reports the boundary before the next lap starts.
    subject.finishContent("completed", "expected_item_boundary");
    subject.startContent(item);
    advance(10_000);
    subject.finishContent("completed", "expected_item_boundary");

    expect(
      events.filter((event) => event.eventType === "content.started"),
    ).toHaveLength(2);
    expect(
      events.filter((event) => event.eventType === "content.completed"),
    ).toHaveLength(2);
  });

  it("does not open a second session for a different zone of the same item", () => {
    const { events, subject } = tracker();
    subject.startPresentation(root);
    subject.startContent({
      contentId: "m",
      contentType: "image",
      layoutPlacementId: "zone-1",
    });
    subject.startContent({
      contentId: "m",
      contentType: "image",
      layoutPlacementId: "zone-2",
    });
    expect(
      events.filter((event) => event.eventType === "content.started"),
    ).toHaveLength(2);
  });

  it("records no play for a start the player is not presenting", () => {
    const { events, subject } = tracker();
    subject.startPresentation(root);
    const presented = [{ id: "item-a", kind: "image", durationMs: 4_000 }];
    applyRendererEvent(subject, "item-started", "item-ghost", presented);
    applyRendererEvent(subject, "item-started", "item-a", presented);
    const started = events.filter((e) => e.eventType === "content.started");
    expect(started).toHaveLength(1);
    // The guess ("media") is never reported for an item the player has lost.
    expect(started[0]?.contentType).toBe("image");
  });

  it("omits an expected duration of zero", () => {
    const { events, subject } = tracker();
    subject.startPresentation(root);
    subject.startContent({
      contentId: "item-1",
      contentType: "image",
      playlistItemId: "item-1",
      expectedDurationMs: 0,
    });
    subject.finishContent("completed", "expected_item_boundary");
    for (const event of events.filter((e) =>
      e.eventType.startsWith("content"),
    )) {
      expect(event.expectedDurationMs).toBeUndefined();
    }
  });

  it("keeps the root session when only the manifest version moves", () => {
    const { events, subject } = tracker();
    subject.startPresentation({ ...root, manifestVersion: 1 });
    subject.noteManifestVersion(2);
    // The same content re-evaluated under the new version is the same root.
    subject.startPresentation({
      ...root,
      key: "direct:playlist-a:2",
      manifestVersion: 2,
    });
    expect(
      events.filter((event) => event.eventType === "presentation.started"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.eventType === "presentation.stopped"),
    ).toHaveLength(0);
  });
});

describe("contract v2 conformance", () => {
  it("emits the canonical event names, not this player's v1 spellings", () => {
    const { events, subject } = tracker();
    subject.startPresentation({
      key: "playlist-a",
      presentationType: "playlist",
      presentationId: "playlist-a",
    });
    subject.startContent({ contentId: "item-1", contentType: "image" });
    subject.finishContent("completed", "completed_duration");
    subject.stopPresentation("schedule_transition");

    for (const event of events) {
      const canonical =
        fixtures.canonicalEventTypes[event.eventType] ?? event.eventType;
      expect(event.eventType).toBe(canonical);
    }
  });

  it("uses canonical names in every non-legacy fixture column", () => {
    // Scenarios listing this player under legacyAliasPlayers emit v1 names on
    // purpose, to prove the server still accepts them. Everywhere else a v1
    // alias would be a regression: this player has moved to contract v2.
    const current = fixtures.scenarios.filter(
      (scenario) => !scenario.legacyAliasPlayers.includes("linux"),
    );
    expect(current.length).toBeGreaterThan(0);
    for (const scenario of current) {
      for (const emission of scenario.emissions.linux) {
        const eventType = emission["eventType"] as string;
        expect(
          fixtures.canonicalEventTypes[eventType] ?? eventType,
          `${scenario.name}: ${eventType} is a v1 alias`,
        ).toBe(eventType);
      }
    }
  });

  it("uses the fixture terminal-reason vocabulary", () => {
    const { events, subject } = tracker();
    subject.startPresentation({
      key: "playlist-a",
      presentationType: "playlist",
      presentationId: "playlist-a",
    });
    subject.stopPresentation("schedule_transition");
    for (const event of events) {
      if (!event.terminalReason) continue;
      expect(Object.keys(fixtures.terminalReasons)).toContain(
        event.terminalReason,
      );
    }
  });
});
