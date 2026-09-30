/**
 * Player activity-event reporting.
 *
 * The player emits append-only activity events — playback started/completed/
 * failed, connectivity lost/recovered, self-heal attempts, safe-mode — that
 * Studio derives its per-screen operational view and proof-of-play from. A
 * monotonic per-device sequence is persisted so ordering survives restarts,
 * and events are batched and flushed on a timer (and at connect) so a brief
 * outage never loses history: unsent events stay buffered and are retried.
 *
 * The event id needs to be stable per event for server-side idempotency but
 * Date.now()/random are unavailable in some contexts; the caller supplies the
 * clock and a uuid factory.
 */

import type { ApiClient } from "./api";
import { ApiError } from "./api";
import { logger } from "./log";
import type { StateStore } from "./storage";

const log = logger("activity");

const SEQUENCE_FILE = "activity-sequence.json";
const MAX_BUFFER = 500;
const MAX_BATCH = 200;
export const ACTIVITY_FLUSH_INTERVAL_MS = 30_000;

export type ActivitySeverity =
  "debug" | "info" | "warning" | "error" | "critical";

export type ActivityResult =
  | "playing"
  | "completed"
  | "partial"
  | "skipped"
  | "failed"
  | "unknown"
  | "recovered"
  | "success";

export type ActivitySessionType =
  "presentation" | "content" | "layout_placement" | "playlist_item";

export interface ActivityEventInput {
  eventType: string;
  category?: string;
  severity?: ActivitySeverity;
  presentationType?: string;
  presentationId?: string;
  presentationRevision?: string;
  contentType?: string;
  contentId?: string;
  playlistItemId?: string;
  layoutPlacementId?: string;
  /** Stable for the life of one session; the end event repeats the start's. */
  activitySessionId?: string;
  parentActivitySessionId?: string;
  sessionType?: ActivitySessionType;
  /** Why the session ended. Required on end events under contract v2. */
  terminalReason?: string;
  result?: ActivityResult;
  durationMs?: number;
  expectedDurationMs?: number;
  failureCode?: string;
  failureMessage?: string;
  trigger?: string;
  scheduleId?: string;
  takeoverId?: string;
  manifestVersion?: number;
  metadata?: Record<string, unknown>;
}

interface StoredSequence {
  next: number;
  buffered: Record<string, unknown>[];
}

export class ActivityReporter {
  private next = 1;
  private buffer: Record<string, unknown>[] = [];
  private loaded = false;
  private timer: NodeJS.Timeout | null = null;
  private operation: Promise<void> = Promise.resolve();
  private stopping = false;
  private readonly startMs: number;

  constructor(
    private readonly store: StateStore,
    private readonly client: ApiClient,
    private readonly now: () => number,
    private readonly uuid: () => string,
    private readonly timezone: string,
  ) {
    this.startMs = now();
  }

  async start(): Promise<void> {
    if (!this.loaded) {
      const stored = await this.store.readJson<StoredSequence>(SEQUENCE_FILE);
      this.next = stored?.next ?? 1;
      this.buffer = stored?.buffered ?? [];
      this.loaded = true;
    }
    if (this.timer === null) {
      this.timer = setInterval(
        () => void this.flush(),
        ACTIVITY_FLUSH_INTERVAL_MS,
      );
      this.timer.unref?.();
    }
  }

  async stop(): Promise<void> {
    // Queue a shutdown marker behind every record/flush already submitted. This
    // prevents a concurrent record from being dropped merely because shutdown
    // began before its promise reached the writer.
    await this.enqueue(async () => {
      this.stopping = true;
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    });
    // Shutdown is a real durability boundary. Complete the final persistence
    // and upload operation before returning.
    await this.flush();
  }

  /** Record an event; persisted immediately, sent on the next flush. */
  async record(input: ActivityEventInput): Promise<void> {
    await this.enqueue(async () => {
      if (this.stopping) {
        return;
      }
      const event: Record<string, unknown> = {
        id: this.uuid(),
        sequence: this.next++,
        eventType: input.eventType,
        category: input.category ?? "playback",
        severity: input.severity ?? "info",
        occurredAt: new Date(this.now()).toISOString(),
        elapsedRealtimeMs: Math.max(0, this.now() - this.startMs),
        playerTimezone: this.timezone,
      };
      for (const [key, value] of Object.entries(input)) {
        if (
          value !== undefined &&
          !["eventType", "category", "severity"].includes(key)
        ) {
          event[key] =
            key === "failureMessage" ? String(value).slice(0, 240) : value;
        }
      }
      this.buffer.push(event);
      if (this.buffer.length > MAX_BUFFER) {
        // Drop the oldest to stay bounded; note it so the gap is visible.
        const dropped = this.buffer.length - MAX_BUFFER;
        this.buffer.splice(0, dropped);
        log.warn("activity buffer overflow; dropped oldest events", {
          dropped,
        });
      }
      await this.persist();
    });
  }

  /** Flush buffered events; keeps them on failure so nothing is lost. */
  async flush(): Promise<void> {
    await this.enqueue(async () => {
      while (this.buffer.length > 0) {
        const batch = this.buffer.slice(0, MAX_BATCH);
        let acknowledgement:
          | {
              highestSequence: number;
              acknowledgedEventIds: string[];
            }
          | undefined;
        try {
          acknowledgement = await this.client.postActivityEvents(batch);
        } catch (err) {
          if (err instanceof ApiError && err.credentialRejected) {
            // Nothing to do here; the runtime handles re-pairing. Keep the
            // buffer for after re-enrollment.
            return;
          }
          // Network/5xx: keep the buffer and retry on the next flush.
          log.debug("activity flush deferred", { error: String(err) });
          return;
        }
        // The server may rebase a genuinely new event when the Player's
        // persisted counter was lost. Heal the local counter from that
        // authoritative high-water mark before creating the next event.
        const acknowledged = new Set(
          acknowledgement?.acknowledgedEventIds ??
            batch.map((event) => String(event.id ?? "")),
        );
        const batchHighWater = batch.reduce(
          (highest, event) =>
            Math.max(highest, Number(event.sequence ?? 0) || 0),
          0,
        );
        this.next = Math.max(
          this.next,
          (acknowledgement?.highestSequence ?? batchHighWater) + 1,
        );
        this.buffer = this.buffer.filter(
          (event) => !acknowledged.has(String(event.id ?? "")),
        );
        await this.persist();
      }
    });
  }

  /** Serialize record, flush, and shutdown so snapshots cannot race. */
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.operation.then(operation, operation);
    this.operation = next.catch(() => undefined);
    return next;
  }

  private async persist(): Promise<void> {
    await this.store.writeJson(SEQUENCE_FILE, {
      next: this.next,
      buffered: this.buffer,
    });
  }
}
