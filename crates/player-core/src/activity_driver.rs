//! Durable native Activity reporting and restart closure. Host projections remain opaque.
use crate::{
    ActivityClocks as Clocks, ActivityEvent as Event, ActivitySignal as Signal, ActivityTracker as Tracker,
    Dependencies, PersistedActivity as Persisted,
};
use player_client::{
    AuthenticatedServer,
    client::ServerError,
    player_api::{ActivityBatchOutcome, MAX_ACTIVITY_BATCH, TelemetryOutcome},
};
use player_state::{
    StateDb,
    repo::outbox::{self, OutboxKind},
};
use player_types::Timestamp;
use serde::Serialize;
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Notify, mpsc, watch};
use tokio_util::sync::CancellationToken;
/// The Electron player's flush cadence.
pub const FLUSH_INTERVAL: Duration = Duration::from_secs(30);
/// Signals waiting for the activity task. A burst beyond this is counted
/// and reported as dropped, never allowed to block playback.
const SIGNAL_CAPACITY: usize = 1_024;
/// The server refuses telemetry older than a day; keep a margin.
const TELEMETRY_MAX_AGE: Duration = Duration::from_secs(23 * 3_600);
const FLUSH_ON_SHUTDOWN: Duration = Duration::from_secs(5);

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
    Timestamp::from_unix_millis(wall_ms)
        .and_then(|t| serde_json::to_value(t).ok())
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".into())
}

/// Inputs from native host composition. Core owns signal capacity and all
/// persistence, upload, overflow, restart, and shutdown ordering.
pub struct ActivityServices<'a> {
    pub clocks: &'a dyn Clocks,
    pub timezone: &'a str,
    pub handle: &'a Handle,
    pub signals: mpsc::Receiver<Signal>,
    pub server: watch::Receiver<Option<AuthenticatedServer>>,
    pub report_wake: &'a Notify,
    pub server_wake: &'a Notify,
    pub shutdown: &'a CancellationToken,
}

impl std::fmt::Debug for ActivityServices<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("ActivityServices").finish_non_exhaustive()
    }
}

async fn enqueue(db: &StateDb, clocks: &dyn Clocks, timezone: &str, events: Vec<(i64, Event)>) {
    for (wall_ms, event) in events {
        let mut event = event.bounded();
        // The Electron reporter's default on every recorded event.
        event.severity.get_or_insert_with(|| "info".to_owned());
        let id = clocks.uuid();
        let (timezone, mono) = (timezone.to_owned(), clocks.mono_ms());
        let Some(now) = Timestamp::from_unix_millis(wall_ms) else { continue };
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
async fn flush(db: &StateDb, server: &AuthenticatedServer, now: Timestamp) -> Result<(), ServerError> {
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
    let cutoff = Timestamp::from_unix_millis(now.unix_millis().saturating_sub(TELEMETRY_MAX_AGE.as_millis() as i64))
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
pub(crate) async fn drive_activity(dependencies: Dependencies, services: ActivityServices<'_>) {
    let db = dependencies.state;
    let clocks = services.clocks;
    let timezone = services.timezone;
    let mut signals = services.signals;
    let mut tracker = Tracker::default();

    // Sessions an unclean stop left open.
    if let Ok(Some(stored)) = db.run(|c| outbox::open_sessions(c)).await {
        if let Ok(Persisted { mut tracker, alive_at_wall_ms }) = serde_json::from_str::<Persisted>(&stored) {
            let closed = tracker.close_after_restart(alive_at_wall_ms);
            tracing::info!(component = "activity", event = "sessions_closed_after_restart", count = closed.len());
            enqueue(&db, clocks, timezone, closed).await;
        }
        let _ = db.run(|c| outbox::set_open_sessions(c, None)).await;
    }

    let mut server = services.server;
    let mut ticker = tokio::time::interval(FLUSH_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut lost_reported = 0u64;
    loop {
        let flush_now = tokio::select! {
            () = services.shutdown.cancelled() => break,
            signal = signals.recv() => {
                let Some(signal) = signal else { break };
                let urgent = matches!(&signal, Signal::Event(event)
                    if event.category.as_deref() == Some("reliability"));
                let wall = clocks.wall_ms();
                let events = tracker.apply(&signal, clocks);
                if !events.is_empty() {
                    enqueue(&db, clocks, timezone, events.into_iter().map(|e| (wall, e)).collect()).await;
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
            () = services.report_wake.notified() => true,
            changed = server.changed() => {
                if changed.is_err() {
                    break;
                }
                true
            }
        };
        if flush_now {
            report_overflow(&db, clocks, timezone, services.handle, &mut lost_reported).await;
            let current = server.borrow().clone();
            if let Some(api) = current
                && let Err(error) = flush(&db, &api, dependencies.clock.now()).await
            {
                tracing::debug!(component = "activity", event = "flush_deferred", reason = error.reason_code());
                if error == ServerError::CredentialRejected {
                    services.server_wake.notify_one();
                }
            }
        }
    }

    // A clean stop closes what is on screen and flushes once, bounded.
    let wall = clocks.wall_ms();
    let closing = tracker.apply(&Signal::Shutdown, clocks);
    enqueue(&db, clocks, timezone, closing.into_iter().map(|e| (wall, e)).collect()).await;
    let _ = db.run(|c| outbox::set_open_sessions(c, None)).await;
    let current = server.borrow().clone();
    if let Some(api) = current {
        let _ = tokio::time::timeout(FLUSH_ON_SHUTDOWN, flush(&db, &api, dependencies.clock.now())).await;
    }
}

/// Reports activity events that the outbox or the signal queue dropped.
async fn report_overflow(db: &StateDb, clocks: &dyn Clocks, timezone: &str, handle: &Handle, lost_reported: &mut u64) {
    let lost = handle.lost.load(Ordering::Relaxed);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ActivityItem, ActivityPresentationContext, ActivityPresented};
    use serde_json::json;

    struct Clock {
        next_id: AtomicU64,
        wall_ms: i64,
        mono_ms: i64,
    }
    impl Clock {
        fn new(wall_ms: i64, mono_ms: i64) -> Self {
            Self { next_id: AtomicU64::new(0), wall_ms, mono_ms }
        }
    }
    impl Clocks for Clock {
        fn mono_ms(&self) -> i64 {
            self.mono_ms
        }
        fn wall_ms(&self) -> i64 {
            self.wall_ms
        }
        fn uuid(&self) -> String {
            uuid::Uuid::from_u128(self.next_id.fetch_add(1, Ordering::Relaxed) as u128 + 1).to_string()
        }
    }

    fn database() -> (tempfile::TempDir, StateDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = StateDb::open(dir.path().join("state.db"), player_state::OpenOptions::default()).unwrap();
        (dir, db)
    }

    #[tokio::test]
    async fn durable_envelope_preserves_sequence_time_and_default_severity() {
        let (_dir, db) = database();
        let clocks = Clock::new(2000, 42);
        enqueue(&db, &clocks, "UTC", vec![(1000, Event::new("connection.restored", "connectivity"))]).await;
        let rows = db.run(|c| outbox::pending(c, OutboxKind::ActivityEvent, 10)).await.unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&rows[0].body).unwrap(),
            json!({
                "id":"00000000-0000-0000-0000-000000000001", "sequence":1,
                "occurredAt":"1970-01-01T00:00:01Z", "elapsedRealtimeMs":42,"playerTimezone":"UTC",
                "eventType":"connection.restored", "category":"connectivity", "severity":"info"
            })
        );
    }

    #[tokio::test]
    async fn bounded_signal_overflow_is_reported_once_without_blocking_playback() {
        let (_dir, db) = database();
        let clocks = Clock::new(2000, 42);
        let (handle, _receiver) = Handle::channel();
        for _ in 0..=SIGNAL_CAPACITY {
            handle.record(Event::new("connection.lost", "connectivity"));
        }
        let mut reported = 0;
        report_overflow(&db, &clocks, "UTC", &handle, &mut reported).await;
        report_overflow(&db, &clocks, "UTC", &handle, &mut reported).await;
        let rows = db.run(|c| outbox::pending(c, OutboxKind::ActivityEvent, 10)).await.unwrap();
        assert_eq!(rows.len(), 1);
        let event: serde_json::Value = serde_json::from_str(&rows[0].body).unwrap();
        assert_eq!(event["eventType"], "outbox.overflow");
        assert_eq!(event["metadata"]["droppedEvents"], 1);
    }

    #[tokio::test]
    async fn offline_restart_closes_persisted_sessions_at_last_alive_time() {
        let (_dir, db) = database();
        let clocks = Clock::new(2000, 42);
        let before_restart = Clock::new(0, 0);
        let mut tracker = Tracker::default();
        tracker.apply(
            &Signal::Presented(ActivityPresented::Playing {
                context: ActivityPresentationContext {
                    key: "direct:playlist:1".into(),
                    presentation_type: "playlist".into(),
                    presentation_id: "playlist".into(),
                    trigger: Some("direct".into()),
                    schedule_id: None,
                    takeover_id: None,
                    manifest_version: Some(1),
                },
                replaced: crate::activity_reason::MANIFEST_REPLACEMENT,
                items: vec![ActivityItem { id: "item".into(), kind: "image".into(), duration_ms: Some(10000) }],
            }),
            &before_restart,
        );
        persist(&db, &tracker, 1000).await;
        let (handle, signals) = Handle::channel();
        let (_sender, server) = watch::channel(None);
        let wake = Notify::new();
        let server_wake = Notify::new();
        let shutdown = CancellationToken::new();
        shutdown.cancel();
        drive_activity(
            Dependencies {
                state: db.clone(),
                clock: player_types::time::ManualClock::new(Timestamp::from_unix_millis(2000).unwrap()),
            },
            ActivityServices {
                clocks: &clocks,
                timezone: "UTC",
                handle: &handle,
                signals,
                server,
                report_wake: &wake,
                server_wake: &server_wake,
                shutdown: &shutdown,
            },
        )
        .await;
        assert!(db.run(|connection| outbox::open_sessions(connection)).await.unwrap().is_none());
        let rows = db.run(|c| outbox::pending(c, OutboxKind::ActivityEvent, 10)).await.unwrap();
        assert_eq!(rows.len(), 1);
        let event: serde_json::Value = serde_json::from_str(&rows[0].body).unwrap();
        assert_eq!(event["terminalReason"], "player_restart");
        assert_eq!(event["occurredAt"], "1970-01-01T00:00:01Z");
    }
}
