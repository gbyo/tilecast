/**
 * Playback session tracking for Activity Event Contract v2.
 *
 * Before v2 this player only reported terminal `content.completed` events with
 * no matching start, so the server had nothing to derive a proof-of-play
 * session from and the screen's playback was invisible in Studio. This tracker
 * mirrors the Android player: it opens a root presentation session, opens a
 * child session per item inside it, and closes each with the same stable
 * activity session ID and an explicit terminal reason.
 *
 * Durations are measured from the injected monotonic clock, so a wall-clock
 * correction cannot produce a negative or inflated interval.
 *
 * See docs/activity-event-contract.md.
 */

import type { ActivityEventInput } from "./activity";

export type TerminalReason =
  | "expected_item_boundary"
  | "completed_duration"
  | "schedule_transition"
  | "manifest_replacement"
  | "direct_assignment_change"
  | "takeover"
  | "player_restart"
  | "process_exit"
  | "heartbeat_gap"
  | "renderer_failure"
  | "decoder_failure"
  | "manual_skip"
  | "empty_content"
  | "recovery_action"
  | "bounded_timeout"
  | "external_presentation"
  | "unknown";

export interface PresentationContext {
  /** Stable identity of what is on screen; a change starts a new root session. */
  key: string;
  presentationType: string;
  presentationId: string;
  presentationRevision?: string;
  trigger?: string;
  scheduleId?: string;
  takeoverId?: string;
  manifestVersion?: number;
}

export interface ContentContext {
  contentId: string;
  contentType: string;
  playlistItemId?: string;
  layoutPlacementId?: string;
  expectedDurationMs?: number;
}

type Emit = (event: ActivityEventInput) => void;

interface OpenSession {
  id: string;
  startedMs: number;
}

export class PlaybackSessionTracker {
  private root: (OpenSession & { context: PresentationContext }) | null = null;
  private child: (OpenSession & { context: ContentContext }) | null = null;

  constructor(
    private readonly emit: Emit,
    private readonly now: () => number,
    private readonly uuid: () => string,
  ) {}

  /** The open root session ID, so a heartbeat can report what is playing. */
  get rootSessionId(): string | null {
    return this.root?.id ?? null;
  }

  /**
   * Opens a root session for what is now on screen. An unchanged presentation
   * is a no-op, so a re-evaluation that resolves to the same content does not
   * churn the session and break its measured duration.
   */
  startPresentation(
    context: PresentationContext,
    replacedReason: TerminalReason = "manifest_replacement",
  ): void {
    if (this.root?.context.key === context.key) {
      return;
    }
    this.stopPresentation(replacedReason);
    const session: OpenSession & { context: PresentationContext } = {
      id: this.uuid(),
      startedMs: this.now(),
      context,
    };
    this.root = session;
    this.emit({
      eventType: "presentation.started",
      category: "manifest",
      result: "playing",
      activitySessionId: session.id,
      sessionType: "presentation",
      presentationType: context.presentationType,
      presentationId: context.presentationId,
      presentationRevision: context.presentationRevision,
      trigger: context.trigger,
      scheduleId: context.scheduleId,
      takeoverId: context.takeoverId,
      manifestVersion: context.manifestVersion,
    });
  }

  /** Closes the root session, and any child still open inside it. */
  stopPresentation(
    reason: TerminalReason,
    result: "completed" | "partial" | "failed" = "partial",
  ): void {
    const session = this.root;
    if (!session) {
      return;
    }
    // A child cannot outlive its parent; it ends for the same reason.
    this.finishContent(result === "failed" ? "failed" : "partial", reason);
    this.root = null;
    this.emit({
      eventType:
        result === "failed" ? "presentation.failed" : "presentation.stopped",
      category: "manifest",
      severity: result === "failed" ? "error" : "info",
      result,
      activitySessionId: session.id,
      sessionType: "presentation",
      terminalReason: reason,
      durationMs: Math.max(0, this.now() - session.startedMs),
      presentationType: session.context.presentationType,
      presentationId: session.context.presentationId,
      presentationRevision: session.context.presentationRevision,
      trigger: session.context.trigger,
      scheduleId: session.context.scheduleId,
      takeoverId: session.context.takeoverId,
      manifestVersion: session.context.manifestVersion,
    });
  }

  /**
   * Opens a child session for the item now rendering, closing the previous one
   * at its expected boundary. Starting the same item twice — a single-item
   * playlist restarting — closes and reopens it, which is what actually
   * happened on screen.
   */
  startContent(context: ContentContext): void {
    this.finishContent("completed", "expected_item_boundary");
    const session: OpenSession & { context: ContentContext } = {
      id: this.uuid(),
      startedMs: this.now(),
      context,
    };
    this.child = session;
    this.emit({
      eventType: "content.started",
      category: "playback",
      result: "playing",
      activitySessionId: session.id,
      parentActivitySessionId: this.root?.id,
      sessionType: this.sessionTypeFor(context),
      contentType: context.contentType,
      contentId: context.contentId,
      playlistItemId: context.playlistItemId,
      layoutPlacementId: context.layoutPlacementId,
      expectedDurationMs: context.expectedDurationMs,
      presentationType: this.root?.context.presentationType,
      presentationId: this.root?.context.presentationId,
      trigger: this.root?.context.trigger,
      scheduleId: this.root?.context.scheduleId,
      takeoverId: this.root?.context.takeoverId,
      manifestVersion: this.root?.context.manifestVersion,
    });
  }

  /** Closes the open child session. Does nothing when none is open. */
  finishContent(
    result: "completed" | "partial" | "failed" | "skipped",
    reason: TerminalReason,
    failure?: { code?: string; message?: string },
  ): void {
    const session = this.child;
    if (!session) {
      return;
    }
    this.child = null;
    this.emit({
      eventType:
        result === "failed"
          ? "content.failed"
          : result === "skipped"
            ? "content.skipped"
            : "content.completed",
      category: "playback",
      severity: result === "failed" ? "error" : "info",
      result: result === "partial" ? "partial" : result,
      activitySessionId: session.id,
      sessionType: this.sessionTypeFor(session.context),
      terminalReason: reason,
      durationMs: Math.max(0, this.now() - session.startedMs),
      contentType: session.context.contentType,
      contentId: session.context.contentId,
      playlistItemId: session.context.playlistItemId,
      layoutPlacementId: session.context.layoutPlacementId,
      expectedDurationMs: session.context.expectedDurationMs,
      presentationType: this.root?.context.presentationType,
      presentationId: this.root?.context.presentationId,
      manifestVersion: this.root?.context.manifestVersion,
      failureCode: failure?.code,
      failureMessage: failure?.message,
    });
  }

  /**
   * Closes everything still open because the process is going away. Callers
   * flush immediately afterwards; anything unsent is retried after restart, so
   * playback is not silently lost to a bounded-timeout guess on the server.
   */
  shutdown(reason: TerminalReason = "process_exit"): void {
    this.stopPresentation(reason);
  }

  private sessionTypeFor(context: ContentContext) {
    if (context.layoutPlacementId) return "layout_placement" as const;
    if (context.playlistItemId) return "playlist_item" as const;
    return "content" as const;
  }
}

/**
 * The player's mapping from what it presents to session boundaries. It is
 * exported so the cross-player parity test
 * (`packages/api-schema/activity/player-parity.json`) runs this exact code,
 * and Tilecast Edge's tracker must produce the same events for the same
 * scenario.
 */
export interface SessionSelection {
  source?: string | null;
  playlistId?: string | null;
  layoutId?: string | null;
  scheduleId?: string | null;
  takeoverId?: string | null;
}

export interface SessionItem {
  id: string;
  kind?: string;
  durationMs?: number | null;
}

/** The root session identity: a change starts a new root session. */
export function presentationContextFor(
  selection: SessionSelection | null,
  manifestVersion: number | undefined,
  firstItemId: string | undefined,
): PresentationContext {
  const presentationId =
    selection?.layoutId ?? selection?.playlistId ?? firstItemId ?? "";
  return {
    key: `${selection?.source ?? ""}:${presentationId}:${manifestVersion ?? ""}`,
    presentationType: selection?.layoutId ? "layout" : "playlist",
    presentationId,
    trigger: selection?.source ?? undefined,
    scheduleId: selection?.scheduleId ?? undefined,
    takeoverId: selection?.takeoverId ?? undefined,
    manifestVersion,
  };
}

/** Why the outgoing presentation is replaced, from what selected the new one. */
export function replacementReasonFor(
  selection: SessionSelection | null,
): TerminalReason {
  if (selection?.takeoverId) return "takeover";
  if (selection?.scheduleId) return "schedule_transition";
  if (selection?.source === "direct") return "direct_assignment_change";
  return "manifest_replacement";
}

/** How a non-playing state ends the root session. */
export function stopForState(state: string): {
  reason: TerminalReason;
  result: "partial" | "failed";
} {
  return state === "safe-mode"
    ? { reason: "recovery_action", result: "failed" }
    : { reason: "schedule_transition", result: "partial" };
}

/** Describes the item now rendering, so its session carries its identity. */
export function contentContextFor(
  items: readonly SessionItem[],
  itemId: string,
): ContentContext {
  const item = items.find((candidate) => candidate.id === itemId);
  return {
    contentId: itemId,
    contentType: item?.kind ?? "media",
    playlistItemId: itemId,
    expectedDurationMs: item?.durationMs ?? undefined,
  };
}

/** The session boundary a renderer progress signal marks, if any. */
export function applyRendererEvent(
  sessions: PlaybackSessionTracker,
  kind: string,
  itemId: string | null,
  items: readonly SessionItem[],
): void {
  if (kind === "item-started") {
    if (itemId) sessions.startContent(contentContextFor(items, itemId));
  } else if (kind === "widget-empty") {
    sessions.finishContent("skipped", "empty_content");
  } else if (kind === "item-transition") {
    sessions.finishContent("completed", "expected_item_boundary");
  }
}

/** A playback error ends the item and is also reported on its own. */
export function playbackFailureEvent(
  itemId: string | null,
  message: string,
  manifestVersion: number | undefined,
): ActivityEventInput {
  return {
    eventType: "renderer.failure",
    category: "playback",
    severity: "error",
    result: "failed",
    contentId: itemId ?? undefined,
    failureCode: "renderer_failure",
    failureMessage: message,
    manifestVersion,
  };
}
