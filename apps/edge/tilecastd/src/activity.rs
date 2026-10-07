//! Activity events (M8): proof of play and operational events through the
//! bounded durable outbox.
//!
//! The contract is `docs/activity-event-contract.md` (version 2), and the
//! semantics are the Electron Linux Player's, event for event
//! (`packages/player-activity/src/sessions.ts` and the calls in
//! `player.ts`):
//!
//! * a root `presentation` session opens when a playing presentation starts,
//!   keyed by selection source, presentation and manifest version, and closes
//!   with the reason the next selection establishes;
//! * a child session opens on the renderer's `item-started` and closes on
//!   `item-transition` (`expected_item_boundary`), `widget-empty`
//!   (`empty_content`), a playback error (`renderer_failure`) or the root's
//!   end;
//! * a rest, disabled or idle surface ends the root with
//!   `schedule_transition`, safe mode with `recovery_action`;
//! * connection, renderer-failure and self-heal events are reported as the
//!   Electron player reports them.
//!
//! `packages/api-schema/activity/player-parity.json` pins these semantics:
//! the Electron tracker and this one must turn the same scenario into the
//! same event stream.
//!
//! Edge adds two things the Electron player does not do. Sessions open when
//! the daemon stops uncleanly are closed at the next start with
//! `player_restart`, at the last time the daemon was known alive, instead of
//! being left to the server's bounded timeout. Events dropped because the
//! outbox was full are reported in an `outbox.overflow` event.
//!
//! Every event is written to the outbox before anything is sent, so a
//! restart or an outage never loses one: the outbox keeps at most 500 rows
//! and drops the oldest first, counting them.

use edge_protocol::ipc::presentation::{ItemKind, PresentationDocument};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::mpsc;

pub use player_core::{ACTIVITY_FLUSH_INTERVAL as FLUSH_INTERVAL, ActivityHandle as Handle};

pub use player_core::{
    ActivityClocks as Clocks, ActivityEvent as Event, ActivityItem as ItemInfo,
    ActivityPresentationContext as PresentationContext, ActivityPresented as Presented,
    ActivityRendererSignal as RendererSignal, ActivitySignal as Signal, ActivityTracker as Tracker,
    PersistedActivity as Persisted, activity_reason as reason,
};

use crate::daemon::DaemonContext;
use crate::presentation::{ActivationSource, PlaybackIdentity};

fn item_kind(kind: ItemKind) -> &'static str {
    match kind {
        ItemKind::Image => "image",
        ItemKind::Video => "video",
        ItemKind::Website => "website",
        ItemKind::Widget => "widget",
        ItemKind::Layout => "layout",
        ItemKind::Youtube => "youtube",
    }
}

/// What an activation means for the root session: the Electron player's
/// `evaluatePresentation`, `openPresentationSession` and
/// `replacementReason`.
pub fn presented(
    source: ActivationSource,
    identity: Option<&PlaybackIdentity>,
    document: &PresentationDocument,
) -> Option<Presented> {
    match (source, document) {
        // Development fixtures are not player activity.
        (ActivationSource::Fixture, _) => None,
        (ActivationSource::SafeMode, _) => Some(Presented::Stopped { reason: reason::RECOVERY_ACTION, failed: true }),
        (ActivationSource::ServerManifest, PresentationDocument::Playing { items, .. }) if !items.is_empty() => {
            let identity = identity?;
            let presentation_id = identity
                .layout_id
                .or(identity.playlist_id)
                .map(|id| id.to_string())
                .unwrap_or_else(|| items[0].id.as_str().to_owned());
            let source = identity.selection_source;
            let replaced = if identity.takeover_id.is_some() {
                reason::TAKEOVER
            } else if identity.schedule_id.is_some() {
                reason::SCHEDULE_TRANSITION
            } else if source == "direct" {
                reason::DIRECT_ASSIGNMENT_CHANGE
            } else {
                reason::MANIFEST_REPLACEMENT
            };
            Some(Presented::Playing {
                context: PresentationContext {
                    key: format!("{source}:{presentation_id}:{}", identity.manifest_version),
                    presentation_type: if identity.layout_id.is_some() { "layout" } else { "playlist" }.into(),
                    presentation_id,
                    trigger: Some(source.to_owned()),
                    schedule_id: identity.schedule_id.map(|id| id.to_string()),
                    takeover_id: identity.takeover_id.map(|id| id.to_string()),
                    manifest_version: Some(identity.manifest_version),
                },
                replaced,
                items: items
                    .iter()
                    .map(|item| ItemInfo {
                        id: item.id.as_str().to_owned(),
                        kind: item_kind(item.kind).to_owned(),
                        duration_ms: item.duration_ms,
                    })
                    .collect(),
            })
        }
        _ => Some(Presented::Stopped { reason: reason::SCHEDULE_TRANSITION, failed: false }),
    }
}

struct TaskClocks {
    started: Instant,
    clock: edge_protocol::time::SharedClock,
}

impl Clocks for TaskClocks {
    fn mono_ms(&self) -> i64 {
        self.started.elapsed().as_millis() as i64
    }

    fn wall_ms(&self) -> i64 {
        self.clock.now().unix_millis()
    }

    fn uuid(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
}

/// The player's time zone, as the Electron player reports it.
pub fn player_timezone() -> String {
    jiff::tz::TimeZone::system()
        .iana_name()
        .map(|name| name.chars().filter(|c| !c.is_control()).take(80).collect())
        .unwrap_or_else(|| "UTC".into())
}

/// Connect host observations and semantic renderer signals to Core reporting.
pub async fn run(context: Arc<DaemonContext>, signals: mpsc::Receiver<Signal>) {
    let Some(core) = context.core.as_ref() else { return };
    let clocks = TaskClocks { started: Instant::now(), clock: context.clock.clone() };
    let timezone = player_timezone();
    core.run_activity(player_core::ActivityServices {
        clocks: &clocks,
        timezone: &timezone,
        handle: &context.activity,
        signals,
        server: context.command_server.subscribe(),
        report_wake: &context.report_wake,
        server_wake: &context.server_wake,
        shutdown: &context.shutdown,
    })
    .await;
}
