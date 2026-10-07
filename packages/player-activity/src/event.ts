/**
 * The Activity event a Player records, and the one function that turns it into
 * the stored record. Every host builds its record here so the envelope cannot
 * drift between Players. See docs/activity-event-contract.md.
 */

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

/** The host-supplied facts that complete an event into a record. */
export interface ActivityRecordContext {
  id: string;
  sequence: number;
  /** The wall clock, in epoch milliseconds. */
  nowMs: number;
  /** When this reporting run began, on the same clock as `nowMs`. */
  startMs: number;
  timezone: string;
}

const ENVELOPE_DEFAULTS = ["eventType", "category", "severity"];

/**
 * The record the server ingests. Defaults, the failure message bound and the
 * monotonic `elapsedRealtimeMs` are applied once, here.
 */
export function buildActivityRecord(
  input: ActivityEventInput,
  context: ActivityRecordContext,
): Record<string, unknown> {
  const event: Record<string, unknown> = {
    id: context.id,
    sequence: context.sequence,
    eventType: input.eventType,
    category: input.category ?? "playback",
    severity: input.severity ?? "info",
    occurredAt: new Date(context.nowMs).toISOString(),
    elapsedRealtimeMs: Math.max(0, context.nowMs - context.startMs),
    playerTimezone: context.timezone,
  };
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && !ENVELOPE_DEFAULTS.includes(key)) {
      event[key] =
        key === "failureMessage" ? String(value).slice(0, 240) : value;
    }
  }
  return event;
}
