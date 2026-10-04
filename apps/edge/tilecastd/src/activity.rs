//! Activity events (M8): proof of play and operational events through the
//! bounded durable outbox.
//!
//! The contract is `docs/activity-event-contract.md` (version 2), and the
//! semantics are the Electron Linux Player's, event for event
//! (`apps/player-linux/src/core/activity-sessions.ts` and the calls in
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

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use edge_protocol::ipc::presentation::{ItemKind, PresentationDocument};
use edge_server::AuthenticatedServer;
use edge_server::client::ServerError;
use edge_server::player_api::{ActivityBatchOutcome, MAX_ACTIVITY_BATCH, TelemetryOutcome};
use edge_state::StateDb;
use edge_state::repo::outbox::{self, OutboxKind};
use serde::Serialize;
use tokio::sync::mpsc;

pub use player_core::{
    ActivityClocks as Clocks, ActivityEvent as Event, ActivityItem as ItemInfo,
    ActivityPresentationContext as PresentationContext, ActivityPresented as Presented,
    ActivityRendererSignal as RendererSignal, ActivitySignal as Signal, ActivityTracker as Tracker,
    PersistedActivity as Persisted, activity_reason as reason,
};

use crate::daemon::DaemonContext;
use crate::presentation::{ActivationSource, PlaybackIdentity};

/// The Electron player's flush cadence.
pub const FLUSH_INTERVAL: Duration = Duration::from_secs(30);
/// Signals waiting for the activity task. A burst beyond this is counted
/// and reported as dropped, never allowed to block playback.
const SIGNAL_CAPACITY: usize = 1_024;
/// The server refuses telemetry older than a day; keep a margin.
const TELEMETRY_MAX_AGE: Duration = Duration::from_secs(23 * 3_600);
const FLUSH_ON_SHUTDOWN: Duration = Duration::from_secs(5);

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

/// The daemon's side of the activity task: non-blocking and bounded.
#[derive(Debug, Clone)]
pub struct Handle {
    tx: mpsc::Sender<Signal>,
    lost: Arc<AtomicU64>,
}

impl Handle {
    pub fn channel() -> (Self, mpsc::Receiver<Signal>) {
        let (tx, rx) = mpsc::channel(SIGNAL_CAPACITY);
        (Self { tx, lost: Arc::new(AtomicU64::new(0)) }, rx)
    }

    pub fn send(&self, signal: Signal) {
        if self.tx.try_send(signal).is_err() {
            self.lost.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn record(&self, event: Event) {
        self.send(Signal::Event(Box::new(event)));
    }
}

/// The envelope the server needs around each event.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Envelope<'a> {
    id: &'a str,
    sequence: i64,
    occurred_at: String,
    elapsed_realtime_ms: i64,
    player_timezone: &'a str,
    #[serde(flatten)]
    event: &'a Event,
}

fn rfc3339(wall_ms: i64) -> String {
    edge_protocol::Timestamp::from_unix_millis(wall_ms)
        .and_then(|t| serde_json::to_value(t).ok())
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".into())
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

async fn enqueue(db: &StateDb, clocks: &dyn Clocks, timezone: &str, events: Vec<(i64, Event)>) {
    for (wall_ms, event) in events {
        let mut event = event.bounded();
        // The Electron reporter's default on every recorded event.
        event.severity.get_or_insert_with(|| "info".to_owned());
        let id = clocks.uuid();
        let (timezone, mono) = (timezone.to_owned(), clocks.mono_ms());
        let Some(now) = edge_protocol::Timestamp::from_unix_millis(wall_ms) else { continue };
        let result = db
            .run(move |c| {
                outbox::enqueue_activity(c, &id, now, |sequence| {
                    serde_json::to_string(&Envelope {
                        id: &id,
                        sequence,
                        occurred_at: rfc3339(wall_ms),
                        elapsed_realtime_ms: mono,
                        player_timezone: &timezone,
                        event: &event,
                    })
                    .unwrap_or_default()
                })
            })
            .await;
        if let Err(error) = result {
            tracing::warn!(component = "activity", event = "enqueue_failed", reason = error.reason_code());
        }
    }
}

async fn persist(db: &StateDb, tracker: &Tracker, alive_at_wall_ms: i64) {
    let value = (!tracker.is_empty())
        .then(|| serde_json::to_string(&Persisted { tracker: tracker.clone(), alive_at_wall_ms }).ok())
        .flatten();
    let _ = db.run(move |c| outbox::set_open_sessions(c, value.as_deref())).await;
}

/// Sends what the outbox holds, oldest first. Stops at the first transport
/// failure and leaves the rest for the next pass.
pub async fn flush(
    db: &StateDb,
    server: &AuthenticatedServer,
    now: edge_protocol::Timestamp,
) -> Result<(), ServerError> {
    loop {
        let rows = db
            .run(|c| outbox::pending(c, OutboxKind::ActivityEvent, MAX_ACTIVITY_BATCH))
            .await
            .map_err(|_| ServerError::Decode)?;
        if rows.is_empty() {
            break;
        }
        let bodies: Vec<&str> = rows.iter().map(|row| row.body.as_str()).collect();
        match server.post_activity_events(&bodies).await? {
            ActivityBatchOutcome::Taken { .. } => {
                // Accepted and duplicates alike: the server holds them.
                let ids: Vec<i64> = rows.iter().map(|row| row.id).collect();
                let _ = db.run(move |c| outbox::delivered(c, &ids)).await;
            }
            ActivityBatchOutcome::InvalidEvent(index) => {
                let Some(row) = rows.get(index) else { break };
                tracing::warn!(component = "activity", event = "event_refused", sequence_row = row.id);
                let id = row.id;
                let _ = db.run(move |c| outbox::rejected(c, id)).await;
            }
            ActivityBatchOutcome::Refused if rows.len() > 1 => {
                // The server did not name the event: send one at a time.
                for row in rows {
                    match server.post_activity_events(&[row.body.as_str()]).await? {
                        ActivityBatchOutcome::Taken { .. } => {
                            let _ = db.run(move |c| outbox::delivered(c, &[row.id])).await;
                        }
                        _ => {
                            let _ = db.run(move |c| outbox::rejected(c, row.id)).await;
                        }
                    }
                }
            }
            ActivityBatchOutcome::Refused => {
                let id = rows[0].id;
                let _ = db.run(move |c| outbox::rejected(c, id)).await;
            }
        }
    }
    let cutoff = edge_protocol::Timestamp::from_unix_millis(
        now.unix_millis().saturating_sub(TELEMETRY_MAX_AGE.as_millis() as i64),
    )
    .unwrap_or(now);
    let _ = db.run(move |c| outbox::expire_telemetry(c, cutoff)).await;
    loop {
        let rows =
            db.run(|c| outbox::pending(c, OutboxKind::TelemetrySample, 30)).await.map_err(|_| ServerError::Decode)?;
        if rows.is_empty() {
            break;
        }
        for row in rows {
            let outcome = server.post_telemetry(&row.body).await?;
            let id = row.id;
            let _ = match outcome {
                TelemetryOutcome::Accepted => db.run(move |c| outbox::delivered(c, &[id])).await,
                TelemetryOutcome::Refused => db.run(move |c| outbox::rejected(c, id)).await,
            };
        }
    }
    Ok(())
}

/// The activity task: turns daemon signals into outbox rows and flushes the
/// outbox to the server.
pub async fn run(context: Arc<DaemonContext>, mut signals: mpsc::Receiver<Signal>) {
    let Some(db) = context.db().cloned() else { return };
    let clocks = TaskClocks { started: Instant::now(), clock: context.clock.clone() };
    let timezone = player_timezone();
    let mut tracker = Tracker::default();

    // Sessions an unclean stop left open.
    if let Ok(Some(stored)) = db.run(|c| outbox::open_sessions(c)).await {
        if let Ok(Persisted { mut tracker, alive_at_wall_ms }) = serde_json::from_str::<Persisted>(&stored) {
            let closed = tracker.close_after_restart(alive_at_wall_ms);
            tracing::info!(component = "activity", event = "sessions_closed_after_restart", count = closed.len());
            enqueue(&db, &clocks, &timezone, closed).await;
        }
        let _ = db.run(|c| outbox::set_open_sessions(c, None)).await;
    }

    let mut server = context.command_server.subscribe();
    let mut ticker = tokio::time::interval(FLUSH_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut lost_reported = 0u64;
    loop {
        let flush_now = tokio::select! {
            () = context.shutdown.cancelled() => break,
            signal = signals.recv() => {
                let Some(signal) = signal else { break };
                let urgent = matches!(&signal, Signal::Event(event)
                    if event.category.as_deref() == Some("reliability"));
                let wall = clocks.wall_ms();
                let events = tracker.apply(&signal, &clocks);
                if !events.is_empty() {
                    enqueue(&db, &clocks, &timezone, events.into_iter().map(|e| (wall, e)).collect()).await;
                    persist(&db, &tracker, wall).await;
                }
                // Reliability events are flushed at once, so Studio sees an
                // outage even if the action that follows restarts the process.
                urgent
            }
            _ = ticker.tick() => {
                persist(&db, &tracker, clocks.wall_ms()).await;
                true
            }
            () = context.report_wake.notified() => true,
            changed = server.changed() => {
                if changed.is_err() {
                    break;
                }
                true
            }
        };
        if flush_now {
            report_overflow(&db, &clocks, &timezone, &context, &mut lost_reported).await;
            let current = server.borrow().clone();
            if let Some(api) = current
                && let Err(error) = flush(&db, &api, context.now()).await
            {
                tracing::debug!(component = "activity", event = "flush_deferred", reason = error.reason_code());
                if error == ServerError::CredentialRejected {
                    context.server_wake.notify_one();
                }
            }
        }
    }

    // A clean stop closes what is on screen and flushes once, bounded.
    let wall = clocks.wall_ms();
    let closing = tracker.apply(&Signal::Shutdown, &clocks);
    enqueue(&db, &clocks, &timezone, closing.into_iter().map(|e| (wall, e)).collect()).await;
    let _ = db.run(|c| outbox::set_open_sessions(c, None)).await;
    let current = server.borrow().clone();
    if let Some(api) = current {
        let _ = tokio::time::timeout(FLUSH_ON_SHUTDOWN, flush(&db, &api, context.now())).await;
    }
}

/// Reports activity events that the outbox or the signal queue dropped.
async fn report_overflow(
    db: &StateDb,
    clocks: &dyn Clocks,
    timezone: &str,
    context: &DaemonContext,
    lost_reported: &mut u64,
) {
    let lost = context.activity.lost.load(Ordering::Relaxed);
    let signals = lost.saturating_sub(*lost_reported);
    *lost_reported = lost;
    let dropped = db.run(outbox::take_unreported_drops).await.unwrap_or(0);
    if dropped + signals == 0 {
        return;
    }
    tracing::warn!(component = "activity", event = "outbox_overflow", dropped, signals);
    let event = Event::new("outbox.overflow", "system").with(|e| {
        e.severity = Some("warning".into());
        e.result = Some("unknown".into());
        e.metadata = Some(serde_json::json!({ "droppedEvents": dropped + signals }));
    });
    enqueue(db, clocks, timezone, vec![(clocks.wall_ms(), event)]).await;
}
