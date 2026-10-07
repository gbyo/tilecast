import { PlayerAPIError, type PlayerAPI } from "../api";
import { BATCH_LIMIT, type ActivityOutbox, type OutboxEntry } from "./outbox";

export interface ActivityAcknowledgement {
  accepted: number;
  duplicates: number;
  highestSequence: number;
  acknowledgedEventIds: string[];
}

export type FlushResult =
  | { state: "empty" }
  | { state: "blocked" }
  | { state: "deferred"; error: unknown }
  | { state: "sent"; remaining: number };

const rejected = (error: unknown) =>
  error instanceof PlayerAPIError && [400, 422].includes(error.status);

/**
 * Sends queued events oldest first. `allowed` is asked before every request,
 * so the queue is held while the Host is unconfirmed and resumes on its own.
 * A failure leaves the queue as it was. Only the server's acknowledgement, or
 * its refusal of an event no retry could fix, removes one.
 */
export async function flushActivity(
  api: PlayerAPI,
  outbox: ActivityOutbox,
  allowed: () => boolean,
): Promise<FlushResult> {
  let sent = false;
  for (;;) {
    if (!allowed()) return { state: "blocked" };
    const entries = await outbox.batch(BATCH_LIMIT);
    if (entries.length === 0)
      return sent ? { state: "sent", remaining: 0 } : { state: "empty" };
    try {
      const acknowledgement = await api.request<ActivityAcknowledgement>(
        "/api/v1/player/activity-events",
        { events: entries.map((entry) => entry.record) },
      );
      await settle(outbox, entries, acknowledgement);
      sent = true;
    } catch (error) {
      if (rejected(error)) {
        // One event the server refuses must not hold the queue forever. Find
        // it by sending the batch one event at a time.
        if (await isolateRefusals(api, outbox, entries, allowed)) {
          sent = true;
          continue;
        }
        return { state: "blocked" };
      }
      return { state: "deferred", error };
    }
  }
}

async function settle(
  outbox: ActivityOutbox,
  entries: readonly OutboxEntry[],
  acknowledgement: ActivityAcknowledgement | undefined,
): Promise<void> {
  const acknowledged = new Set(
    acknowledgement?.acknowledgedEventIds ??
      entries.map((entry) => String(entry.record["id"])),
  );
  await outbox.remove(
    entries.filter((entry) => acknowledged.has(String(entry.record["id"]))),
  );
  // The server's high-water mark heals a counter that was lost locally.
  if (acknowledgement?.highestSequence)
    await outbox.healSequence(acknowledgement.highestSequence);
}

async function isolateRefusals(
  api: PlayerAPI,
  outbox: ActivityOutbox,
  entries: readonly OutboxEntry[],
  allowed: () => boolean,
): Promise<boolean> {
  let progressed = false;
  for (const entry of entries) {
    if (!allowed()) return progressed;
    try {
      const acknowledgement = await api.request<ActivityAcknowledgement>(
        "/api/v1/player/activity-events",
        { events: [entry.record] },
      );
      await settle(outbox, [entry], acknowledgement);
      progressed = true;
    } catch (error) {
      if (!rejected(error)) return progressed;
      await outbox.remove([entry]);
      progressed = true;
    }
  }
  return progressed;
}
