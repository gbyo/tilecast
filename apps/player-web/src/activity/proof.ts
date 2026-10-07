import {
  applyRendererEvent,
  contentContextFor,
  playbackFailureEvent,
  presentationContextFor,
  replacementReasonFor,
  type PresentationContext,
  type SessionItem,
  type SessionSelection,
  type TerminalReason,
} from "@tilecast/player-activity";
import type { EvidenceKind } from "@tilecast/player-runtime/host-contract";
import type { ActivityRecorder } from "./recorder";

/** What an activation presents, in the terms the shared tracker needs. */
export interface ProofPresentation {
  selection: SessionSelection | null;
  manifestVersion: number | undefined;
  items: readonly SessionItem[];
}

interface Shadow {
  presentation: ProofPresentation;
  context: PresentationContext;
  replacedBecause: TerminalReason;
  /** The item the Runtime last said it is showing, whether or not it counts. */
  currentItemId: string | null;
}

/** A skip request holds this long for the Runtime to confirm the item ended. */
const SKIP_WINDOW_MS = 10_000;

/**
 * Maps the Runtime's evidence onto the shared playback-session tracker.
 *
 * The Runtime reports what it is showing; this class decides when that counts.
 * It keeps a shadow of the activation and the item on screen, and opens the
 * tracker's sessions only while `eligible()` is true. When the page is hidden,
 * frozen or waiting for a clock to be re-anchored, the sessions end with the
 * reason `unknown` (no evidence, not an interruption), and they reopen from the
 * shadow when the page can be trusted again. A heartbeat, a live Runtime or a
 * fired timer is never evidence: only the Runtime's own reports are.
 */
export class ProofOfPlay {
  private shadow: Shadow | null = null;
  private skipRequestedAt: number | null = null;

  constructor(
    private readonly recorder: ActivityRecorder,
    private readonly eligible: () => boolean,
    private readonly now: () => number,
  ) {}

  /** A new activation was sent to the Runtime. */
  activate(presentation: ProofPresentation): void {
    const context = presentationContextFor(
      presentation.selection,
      presentation.manifestVersion,
      presentation.items[0]?.id,
    );
    const replacedBecause = replacementReasonFor(presentation.selection);
    if (this.shadow && this.shadow.context.key !== context.key) {
      // The new content replaces the old now, for the reason that selected it.
      this.recorder.sessions.stopPresentation(replacedBecause);
    }
    const same = this.shadow?.context.key === context.key;
    this.shadow = {
      presentation,
      context,
      replacedBecause,
      // The Runtime starts the new activation over. Until it says which item
      // it shows, the item that was open stays open when the content is the same.
      currentItemId: same ? (this.shadow?.currentItemId ?? null) : null,
    };
    this.sync();
  }

  /** The screen no longer presents content: a status surface, rest or a discard. */
  deactivate(
    reason: TerminalReason,
    result: "partial" | "failed" = "partial",
  ): void {
    this.shadow = null;
    this.skipRequestedAt = null;
    this.recorder.sessions.stopPresentation(reason, result);
  }

  /** Ends the current play and begins another of the same content. */
  restart(reason: TerminalReason): void {
    this.recorder.sessions.stopPresentation(reason);
    if (this.shadow) this.shadow.currentItemId = null;
    this.sync();
  }

  /** An operator skipped the item; the next item boundary is a manual skip. */
  skipRequested(): void {
    this.skipRequestedAt = this.now();
  }

  /** Runtime evidence for the current activation. */
  evidence(kind: EvidenceKind, itemId: string | null): void {
    const shadow = this.shadow;
    if (!shadow) return;
    if (kind === "item-started") {
      if (
        itemId &&
        shadow.presentation.items.some((item) => item.id === itemId)
      ) {
        shadow.currentItemId = itemId;
      }
    } else if (kind === "item-transition" || kind === "widget-empty") {
      shadow.currentItemId = null;
    }
    if (!this.eligible()) return;
    this.sync();
    if (kind === "item-transition" && this.skipPending()) {
      this.recorder.sessions.finishContent("skipped", "manual_skip");
      this.skipRequestedAt = null;
      return;
    }
    applyRendererEvent(
      this.recorder.sessions,
      kind,
      itemId,
      shadow.presentation.items,
    );
  }

  /** A playback failure is recorded as a failure even when it is not a play. */
  failure(itemId: string | null, message: string): void {
    const shadow = this.shadow;
    if (!shadow) return;
    this.recorder.sessions.finishContent("failed", "renderer_failure", {
      code: "renderer_failure",
      message,
    });
    this.recorder.record(
      playbackFailureEvent(
        itemId,
        message,
        shadow.presentation.manifestVersion,
      ),
    );
  }

  /** Reconciles the tracker with the shadow whenever eligibility may have changed. */
  sync(): void {
    const shadow = this.shadow;
    const tracker = this.recorder.sessions;
    if (!shadow || !this.eligible()) {
      if (tracker.rootSessionId) tracker.stopPresentation("unknown");
      return;
    }
    if (!tracker.rootSessionId) {
      tracker.startPresentation(shadow.context, shadow.replacedBecause);
    }
    if (shadow.currentItemId) {
      tracker.startContent(
        contentContextFor(shadow.presentation.items, shadow.currentItemId),
      );
    }
  }

  /** Closes everything because this page is going away. */
  shutdown(reason: TerminalReason = "process_exit"): void {
    this.shadow = null;
    this.recorder.sessions.shutdown(reason);
  }

  private skipPending(): boolean {
    return (
      this.skipRequestedAt !== null &&
      this.now() - this.skipRequestedAt <= SKIP_WINDOW_MS
    );
  }
}
