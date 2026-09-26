/**
 * Cross-player Activity parity. The scenarios in
 * packages/api-schema/activity/player-parity.json run through this player's
 * session tracker and mapping, and must produce exactly the `expected`
 * events. Tilecast Edge runs the same file and must produce the same events,
 * which is how the two players are held to one proof-of-play semantics.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActivityEventInput } from "./activity";
import {
  PlaybackSessionTracker,
  applyRendererEvent,
  playbackFailureEvent,
  presentationContextFor,
  replacementReasonFor,
  stopForState,
  type SessionItem,
  type SessionSelection,
} from "./activity-sessions";

const FILE = resolve(
  __dirname,
  "../../../../packages/api-schema/activity/player-parity.json",
);

interface Step {
  present?: {
    state: string;
    selection?: SessionSelection;
    manifestVersion?: number;
    items?: SessionItem[];
  };
  renderer?: { kind: string; itemId: string | null };
  error?: { itemId: string | null; message: string };
  advanceMs?: number;
  shutdown?: boolean;
}

interface Scenario {
  name: string;
  steps: Step[];
  expected: Record<string, unknown>[];
}

/** The fields the parity compares, in a stable order. */
const FIELDS = [
  "eventType",
  "category",
  "severity",
  "result",
  "activitySessionId",
  "parentActivitySessionId",
  "sessionType",
  "terminalReason",
  "durationMs",
  "expectedDurationMs",
  "presentationType",
  "presentationId",
  "contentType",
  "contentId",
  "playlistItemId",
  "trigger",
  "scheduleId",
  "takeoverId",
  "manifestVersion",
  "failureCode",
  "failureMessage",
] as const;

function normalize(events: ActivityEventInput[]): Record<string, unknown>[] {
  const sessions = new Map<string, string>();
  const session = (id: string) => {
    if (!sessions.has(id)) sessions.set(id, `S${sessions.size + 1}`);
    return sessions.get(id);
  };
  return events.map((event) => {
    const out: Record<string, unknown> = {};
    for (const field of FIELDS) {
      const value = (event as Record<string, unknown>)[field];
      if (value === undefined || value === null) continue;
      out[field] =
        field === "activitySessionId" || field === "parentActivitySessionId"
          ? session(String(value))
          : value;
    }
    // The reporter's defaults, which it applies to every recorded event.
    out.category ??= "playback";
    out.severity ??= "info";
    return out;
  });
}

function run(scenario: Scenario): Record<string, unknown>[] {
  const events: ActivityEventInput[] = [];
  let now = 0;
  let next = 0;
  const sessions = new PlaybackSessionTracker(
    (event) => events.push(event),
    () => now,
    () => `uuid-${++next}`,
  );
  let items: SessionItem[] = [];
  let manifestVersion: number | undefined;
  for (const step of scenario.steps) {
    if (step.present) {
      if (step.present.state === "playing") {
        items = step.present.items ?? [];
        manifestVersion = step.present.manifestVersion;
        const selection = step.present.selection ?? null;
        sessions.startPresentation(
          presentationContextFor(selection, manifestVersion, items[0]?.id),
          replacementReasonFor(selection),
        );
      } else {
        items = [];
        const stop = stopForState(step.present.state);
        sessions.stopPresentation(stop.reason, stop.result);
      }
    }
    if (step.renderer) {
      applyRendererEvent(
        sessions,
        step.renderer.kind,
        step.renderer.itemId,
        items,
      );
    }
    if (step.error) {
      sessions.finishContent("failed", "renderer_failure", {
        code: "renderer_failure",
        message: step.error.message,
      });
      events.push(
        playbackFailureEvent(
          step.error.itemId,
          step.error.message,
          manifestVersion,
        ),
      );
    }
    if (step.advanceMs) now += step.advanceMs;
    if (step.shutdown) sessions.shutdown("process_exit");
  }
  return normalize(events);
}

describe("cross-player Activity parity", () => {
  const document = JSON.parse(readFileSync(FILE, "utf8")) as {
    scenarios: Scenario[];
  };

  if (process.env.TILECAST_PARITY_WRITE === "1") {
    for (const scenario of document.scenarios) {
      scenario.expected = run(scenario);
    }
    writeFileSync(FILE, `${JSON.stringify(document, null, 2)}\n`);
  }

  for (const scenario of document.scenarios) {
    it(scenario.name, () => {
      expect(scenario.expected.length).toBeGreaterThan(0);
      expect(run(scenario)).toEqual(scenario.expected);
    });
  }
});
