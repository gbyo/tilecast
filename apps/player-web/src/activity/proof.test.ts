import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  stopForState,
  type SessionItem,
  type SessionSelection,
} from "@tilecast/player-activity";
import type { EvidenceKind } from "@tilecast/player-runtime/host-contract";
import { describe, expect, it } from "vitest";
import { ProofOfPlay } from "./proof";
import { recorderHarness } from "../test-support/recorder-harness";

const FILE = resolve(
  __dirname,
  "../../../../packages/api-schema/activity/player-parity.json",
);

/** The fields the cross-player parity compares, in a stable order. */
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

function normalize(
  records: Record<string, unknown>[],
): Record<string, unknown>[] {
  const sessions = new Map<string, string>();
  const session = (id: string) => {
    if (!sessions.has(id)) sessions.set(id, `S${sessions.size + 1}`);
    return sessions.get(id);
  };
  return records.map((record) => {
    const out: Record<string, unknown> = {};
    for (const field of FIELDS) {
      const value = record[field];
      if (value === undefined || value === null) continue;
      out[field] =
        field === "activitySessionId" || field === "parentActivitySessionId"
          ? session(String(value))
          : value;
    }
    return out;
  });
}

async function harness(eligible: () => boolean = () => true) {
  const h = await recorderHarness();
  const proof = new ProofOfPlay(h.recorder, eligible, () => h.clock.mono);
  return { ...h, proof };
}

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

describe("Browser Player Activity matches the cross-player contract", () => {
  const document = JSON.parse(readFileSync(FILE, "utf8")) as {
    scenarios: {
      name: string;
      steps: Step[];
      expected: Record<string, unknown>[];
    }[];
  };
  for (const scenario of document.scenarios) {
    it(scenario.name, async () => {
      const h = await harness();
      for (const step of scenario.steps) {
        if (step.present) {
          if (step.present.state === "playing") {
            h.proof.activate({
              selection: step.present.selection ?? null,
              manifestVersion: step.present.manifestVersion,
              items: step.present.items ?? [],
            });
          } else {
            const stop = stopForState(step.present.state);
            h.proof.deactivate(stop.reason, stop.result);
          }
        }
        if (step.renderer)
          h.proof.evidence(
            step.renderer.kind as EvidenceKind,
            step.renderer.itemId,
          );
        if (step.error) h.proof.failure(step.error.itemId, step.error.message);
        if (step.advanceMs) h.advance(step.advanceMs);
        if (step.shutdown) h.proof.shutdown("process_exit");
      }
      expect(normalize(await h.records())).toEqual(scenario.expected);
    });
  }
});

const items: SessionItem[] = [
  { id: "item-a", kind: "image", durationMs: 5_000 },
  { id: "item-b", kind: "video", durationMs: null },
];
const playlist = {
  selection: {
    source: "schedule",
    playlistId: "playlist-1",
    scheduleId: "schedule-1",
  },
  manifestVersion: 7,
  items,
};
const types = (records: Record<string, unknown>[]) =>
  records.map(
    (record) => `${record["eventType"]}:${record["terminalReason"] ?? ""}`,
  );

describe("proof of play in the browser", () => {
  it("opens a presentation and an item session and closes them at a boundary", async () => {
    const h = await harness();
    h.proof.activate(playlist);
    h.proof.evidence("item-started", "item-a");
    h.advance(5_000);
    h.proof.evidence("item-transition", "item-a");
    h.proof.evidence("item-started", "item-b");
    expect(types(await h.records())).toEqual([
      "presentation.started:",
      "content.started:",
      "content.completed:expected_item_boundary",
      "content.started:",
    ]);
  });

  it("records a manual skip as a skip, once, for the item that was on screen", async () => {
    const h = await harness();
    h.proof.activate(playlist);
    h.proof.evidence("item-started", "item-a");
    h.advance(1_500);
    h.proof.skipRequested();
    h.proof.evidence("item-transition", "item-a");
    h.proof.evidence("item-started", "item-b");
    const records = await h.records();
    const skipped = records.find(
      (record) => record["eventType"] === "content.skipped",
    )!;
    expect(skipped).toMatchObject({
      terminalReason: "manual_skip",
      result: "skipped",
      durationMs: 1_500,
    });
    expect(types(records)).not.toContain(
      "content.completed:expected_item_boundary",
    );
  });

  it("does not turn a later boundary into a skip after the request expired", async () => {
    const h = await harness();
    h.proof.activate(playlist);
    h.proof.evidence("item-started", "item-a");
    h.proof.skipRequested();
    h.advance(60_000);
    h.proof.evidence("item-transition", "item-a");
    expect(types(await h.records())).toContain(
      "content.completed:expected_item_boundary",
    );
  });

  it("counts nothing while the page is hidden and resumes from what the Runtime showed", async () => {
    let visible = true;
    const h = await harness(() => visible);
    h.proof.activate(playlist);
    h.proof.evidence("item-started", "item-a");
    visible = false;
    h.proof.sync();
    // The Runtime keeps advancing in a hidden page. None of it is a play.
    h.advance(10_000);
    h.proof.evidence("item-transition", "item-a");
    h.proof.evidence("item-started", "item-b");
    h.advance(20_000);
    expect(types(await h.records())).toEqual([
      "presentation.started:",
      "content.started:",
      "content.completed:unknown",
      "presentation.stopped:unknown",
    ]);
    visible = true;
    h.proof.sync();
    const records = await h.records();
    const resumed = records.slice(4);
    expect(types(resumed)).toEqual([
      "presentation.started:",
      "content.started:",
    ]);
    expect(resumed[1]).toMatchObject({ contentId: "item-b" });
    // A new root session, not the old one reopened.
    expect(resumed[0]!["activitySessionId"]).not.toBe(
      records[0]!["activitySessionId"],
    );
  });

  it("opens no session in a page that has never been eligible", async () => {
    const h = await harness(() => false);
    h.proof.activate(playlist);
    h.proof.evidence("item-started", "item-a");
    expect(await h.records()).toEqual([]);
  });

  it("ends the old presentation for the reason the new one was selected", async () => {
    const h = await harness();
    h.proof.activate(playlist);
    h.proof.evidence("item-started", "item-a");
    h.advance(2_000);
    h.proof.activate({
      selection: {
        source: "takeover",
        playlistId: "playlist-2",
        takeoverId: "takeover-1",
      },
      manifestVersion: 7,
      items: [{ id: "item-t", kind: "image", durationMs: 5_000 }],
    });
    const records = await h.records();
    const stopped = records.find(
      (record) => record["eventType"] === "presentation.stopped",
    )!;
    expect(stopped["terminalReason"]).toBe("takeover");
    expect(records.at(-1)).toMatchObject({
      eventType: "presentation.started",
      takeoverId: "takeover-1",
      trigger: "takeover",
    });
  });

  it("keeps the same presentation session for an activation of the same content", async () => {
    const h = await harness();
    h.proof.activate(playlist);
    h.proof.evidence("item-started", "item-a");
    h.proof.activate(playlist);
    h.proof.evidence("item-started", "item-a");
    expect(types(await h.records())).toEqual([
      "presentation.started:",
      "content.started:",
    ]);
  });

  it("restarts a play for a reload without changing the content", async () => {
    const h = await harness();
    h.proof.activate(playlist);
    h.proof.evidence("item-started", "item-a");
    h.advance(1_000);
    h.proof.restart("recovery_action");
    h.proof.evidence("item-started", "item-a");
    expect(types(await h.records())).toEqual([
      "presentation.started:",
      "content.started:",
      "content.completed:recovery_action",
      "presentation.stopped:recovery_action",
      "presentation.started:",
      "content.started:",
    ]);
  });

  it("records a failure even when no item session is open", async () => {
    const h = await harness();
    h.proof.activate(playlist);
    h.proof.failure("item-a", "decoder failed");
    const records = await h.records();
    expect(records.at(-1)).toMatchObject({
      eventType: "renderer.failure",
      failureCode: "renderer_failure",
      manifestVersion: 7,
    });
  });

  it("never records evidence for an item the activation does not present", async () => {
    const h = await harness();
    h.proof.activate(playlist);
    h.proof.evidence("item-started", "not-in-this-playlist");
    expect(types(await h.records())).toEqual(["presentation.started:"]);
  });

  it("ends everything with the page", async () => {
    const h = await harness();
    h.proof.activate(playlist);
    h.proof.evidence("item-started", "item-a");
    h.proof.shutdown("player_restart");
    expect(types(await h.records()).slice(-2)).toEqual([
      "content.completed:player_restart",
      "presentation.stopped:player_restart",
    ]);
  });
});
