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
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;

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

pub mod reason {
    pub const EXPECTED_ITEM_BOUNDARY: &str = "expected_item_boundary";
    pub const SCHEDULE_TRANSITION: &str = "schedule_transition";
    pub const MANIFEST_REPLACEMENT: &str = "manifest_replacement";
    pub const DIRECT_ASSIGNMENT_CHANGE: &str = "direct_assignment_change";
    pub const TAKEOVER: &str = "takeover";
    pub const PLAYER_RESTART: &str = "player_restart";
    pub const PROCESS_EXIT: &str = "process_exit";
    pub const RENDERER_FAILURE: &str = "renderer_failure";
    pub const EMPTY_CONTENT: &str = "empty_content";
    pub const RECOVERY_ACTION: &str = "recovery_action";
}

/// One Activity event, without the envelope the outbox adds.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub severity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_activity_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presentation_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presentation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presentation_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playlist_item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout_placement_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub takeover_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest_version: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

fn text(value: &str, limit: usize) -> String {
    value.chars().filter(|c| !c.is_control()).take(limit).collect()
}

impl Event {
    pub fn new(event_type: &str, category: &str) -> Self {
        Self { event_type: event_type.to_owned(), category: Some(category.to_owned()), ..Self::default() }
    }

    fn with(mut self, change: impl FnOnce(&mut Self)) -> Self {
        change(&mut self);
        self
    }

    /// Bounded to the server's limits (`activity_ingest.go`), so no event
    /// can be refused for its length.
    fn bounded(mut self) -> Self {
        let clip = |value: &mut Option<String>, limit: usize| {
            if let Some(v) = value.as_mut() {
                *v = text(v, limit);
            }
        };
        clip(&mut self.presentation_type, 48);
        clip(&mut self.presentation_id, 128);
        clip(&mut self.presentation_revision, 128);
        clip(&mut self.content_type, 48);
        clip(&mut self.content_id, 128);
        clip(&mut self.playlist_item_id, 128);
        clip(&mut self.layout_placement_id, 128);
        clip(&mut self.activity_session_id, 160);
        clip(&mut self.parent_activity_session_id, 160);
        clip(&mut self.failure_code, 96);
        clip(&mut self.failure_message, 240);
        clip(&mut self.trigger, 96);
        clip(&mut self.schedule_id, 128);
        clip(&mut self.takeover_id, 128);
        self
    }
}

/// What is on screen, for the root session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationContext {
    /// A change starts a new root session (`source:presentationId:version`).
    pub key: String,
    pub presentation_type: String,
    pub presentation_id: String,
    pub trigger: Option<String>,
    pub schedule_id: Option<String>,
    pub takeover_id: Option<String>,
    pub manifest_version: Option<i64>,
}

/// An item of the presentation, for its child session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemInfo {
    pub id: String,
    pub kind: String,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContentContext {
    content_id: String,
    content_type: String,
    playlist_item_id: Option<String>,
    expected_duration_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Open<C> {
    id: String,
    started_mono_ms: i64,
    started_wall_ms: i64,
    context: C,
}

/// A clock and identifier source, so the tracker is deterministic in tests.
pub trait Clocks: Send + Sync {
    fn mono_ms(&self) -> i64;
    fn wall_ms(&self) -> i64;
    fn uuid(&self) -> String;
}

/// The Electron player's `PlaybackSessionTracker`.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tracker {
    root: Option<Open<PresentationContext>>,
    child: Option<Open<ContentContext>>,
    items: Vec<ItemInfo>,
}

impl Tracker {
    pub fn is_empty(&self) -> bool {
        self.root.is_none() && self.child.is_none()
    }

    fn start_presentation(
        &mut self,
        context: PresentationContext,
        replaced: &str,
        clocks: &dyn Clocks,
        out: &mut Vec<Event>,
    ) {
        if self.root.as_ref().is_some_and(|root| root.context.key == context.key) {
            return;
        }
        self.stop_presentation(replaced, "partial", clocks, out);
        let root =
            Open { id: clocks.uuid(), started_mono_ms: clocks.mono_ms(), started_wall_ms: clocks.wall_ms(), context };
        let c = &root.context;
        out.push(Event::new("presentation.started", "manifest").with(|e| {
            e.result = Some("playing".into());
            e.activity_session_id = Some(root.id.clone());
            e.session_type = Some("presentation".into());
            e.presentation_type = Some(c.presentation_type.clone());
            e.presentation_id = Some(c.presentation_id.clone());
            e.trigger = c.trigger.clone();
            e.schedule_id = c.schedule_id.clone();
            e.takeover_id = c.takeover_id.clone();
            e.manifest_version = c.manifest_version;
        }));
        self.root = Some(root);
    }

    fn stop_presentation(&mut self, reason: &str, result: &str, clocks: &dyn Clocks, out: &mut Vec<Event>) {
        let Some(root) = self.root.clone() else { return };
        // A child cannot outlive its parent; it ends for the same reason.
        self.finish_content(if result == "failed" { "failed" } else { "partial" }, reason, None, clocks, out);
        self.root = None;
        let failed = result == "failed";
        let c = &root.context;
        out.push(Event::new(if failed { "presentation.failed" } else { "presentation.stopped" }, "manifest").with(
            |e| {
                e.severity = Some(if failed { "error" } else { "info" }.into());
                e.result = Some(result.into());
                e.activity_session_id = Some(root.id.clone());
                e.session_type = Some("presentation".into());
                e.terminal_reason = Some(reason.into());
                e.duration_ms = Some((clocks.mono_ms() - root.started_mono_ms).max(0));
                e.presentation_type = Some(c.presentation_type.clone());
                e.presentation_id = Some(c.presentation_id.clone());
                e.trigger = c.trigger.clone();
                e.schedule_id = c.schedule_id.clone();
                e.takeover_id = c.takeover_id.clone();
                e.manifest_version = c.manifest_version;
            },
        ));
    }

    fn start_content(&mut self, item_id: &str, clocks: &dyn Clocks, out: &mut Vec<Event>) {
        self.finish_content("completed", reason::EXPECTED_ITEM_BOUNDARY, None, clocks, out);
        let item = self.items.iter().find(|item| item.id == item_id);
        let context = ContentContext {
            content_id: item_id.to_owned(),
            content_type: item.map_or_else(|| "media".to_owned(), |item| item.kind.clone()),
            playlist_item_id: Some(item_id.to_owned()),
            expected_duration_ms: item.and_then(|item| item.duration_ms),
        };
        let child =
            Open { id: clocks.uuid(), started_mono_ms: clocks.mono_ms(), started_wall_ms: clocks.wall_ms(), context };
        let root = self.root.as_ref().map(|root| &root.context);
        let c = &child.context;
        out.push(Event::new("content.started", "playback").with(|e| {
            e.result = Some("playing".into());
            e.activity_session_id = Some(child.id.clone());
            e.parent_activity_session_id = self.root.as_ref().map(|root| root.id.clone());
            e.session_type = Some(session_type(c).into());
            e.content_type = Some(c.content_type.clone());
            e.content_id = Some(c.content_id.clone());
            e.playlist_item_id = c.playlist_item_id.clone();
            e.expected_duration_ms = c.expected_duration_ms;
            e.presentation_type = root.map(|r| r.presentation_type.clone());
            e.presentation_id = root.map(|r| r.presentation_id.clone());
            e.trigger = root.and_then(|r| r.trigger.clone());
            e.schedule_id = root.and_then(|r| r.schedule_id.clone());
            e.takeover_id = root.and_then(|r| r.takeover_id.clone());
            e.manifest_version = root.and_then(|r| r.manifest_version);
        }));
        self.child = Some(child);
    }

    fn finish_content(
        &mut self,
        result: &str,
        reason: &str,
        failure: Option<(&str, &str)>,
        clocks: &dyn Clocks,
        out: &mut Vec<Event>,
    ) {
        let Some(child) = self.child.take() else { return };
        let event_type = match result {
            "failed" => "content.failed",
            "skipped" => "content.skipped",
            _ => "content.completed",
        };
        let root = self.root.as_ref().map(|root| &root.context);
        let c = &child.context;
        out.push(Event::new(event_type, "playback").with(|e| {
            e.severity = Some(if result == "failed" { "error" } else { "info" }.into());
            e.result = Some(result.into());
            e.activity_session_id = Some(child.id.clone());
            e.session_type = Some(session_type(c).into());
            e.terminal_reason = Some(reason.into());
            e.duration_ms = Some((clocks.mono_ms() - child.started_mono_ms).max(0));
            e.content_type = Some(c.content_type.clone());
            e.content_id = Some(c.content_id.clone());
            e.playlist_item_id = c.playlist_item_id.clone();
            e.expected_duration_ms = c.expected_duration_ms;
            e.presentation_type = root.map(|r| r.presentation_type.clone());
            e.presentation_id = root.map(|r| r.presentation_id.clone());
            e.manifest_version = root.and_then(|r| r.manifest_version);
            e.failure_code = failure.map(|(code, _)| code.to_owned());
            e.failure_message = failure.map(|(_, message)| message.to_owned());
        }));
    }

    /// Sessions a daemon left open when it stopped uncleanly, closed at the
    /// last time it was known alive.
    fn close_after_restart(&mut self, alive_at_wall_ms: i64) -> Vec<(i64, Event)> {
        let mut out = vec![];
        let root = self.root.take();
        if let Some(child) = self.child.take() {
            let c = &child.context;
            out.push((
                alive_at_wall_ms,
                Event::new("content.completed", "playback").with(|e| {
                    e.severity = Some("info".into());
                    e.result = Some("partial".into());
                    e.activity_session_id = Some(child.id.clone());
                    e.session_type = Some(session_type(c).into());
                    e.terminal_reason = Some(reason::PLAYER_RESTART.into());
                    e.duration_ms = Some((alive_at_wall_ms - child.started_wall_ms).max(0));
                    e.content_type = Some(c.content_type.clone());
                    e.content_id = Some(c.content_id.clone());
                    e.playlist_item_id = c.playlist_item_id.clone();
                    e.expected_duration_ms = c.expected_duration_ms;
                    e.presentation_type = root.as_ref().map(|r| r.context.presentation_type.clone());
                    e.presentation_id = root.as_ref().map(|r| r.context.presentation_id.clone());
                    e.manifest_version = root.as_ref().and_then(|r| r.context.manifest_version);
                }),
            ));
        }
        if let Some(root) = root {
            let c = &root.context;
            out.push((
                alive_at_wall_ms,
                Event::new("presentation.stopped", "manifest").with(|e| {
                    e.severity = Some("info".into());
                    e.result = Some("partial".into());
                    e.activity_session_id = Some(root.id.clone());
                    e.session_type = Some("presentation".into());
                    e.terminal_reason = Some(reason::PLAYER_RESTART.into());
                    e.duration_ms = Some((alive_at_wall_ms - root.started_wall_ms).max(0));
                    e.presentation_type = Some(c.presentation_type.clone());
                    e.presentation_id = Some(c.presentation_id.clone());
                    e.trigger = c.trigger.clone();
                    e.schedule_id = c.schedule_id.clone();
                    e.takeover_id = c.takeover_id.clone();
                    e.manifest_version = c.manifest_version;
                }),
            ));
        }
        out
    }

    /// Applies one daemon signal, returning the events it produces.
    pub fn apply(&mut self, signal: &Signal, clocks: &dyn Clocks) -> Vec<Event> {
        let mut out = vec![];
        match signal {
            Signal::Presented(Presented::Playing { context, replaced, items }) => {
                self.items = items.clone();
                self.start_presentation(context.clone(), replaced, clocks, &mut out);
            }
            Signal::Presented(Presented::Stopped { reason, failed }) => {
                self.items.clear();
                self.stop_presentation(reason, if *failed { "failed" } else { "partial" }, clocks, &mut out);
            }
            Signal::Renderer { kind: RendererSignal::ItemStarted, item_id } => {
                if let Some(item_id) = item_id {
                    self.start_content(item_id, clocks, &mut out);
                }
            }
            Signal::Renderer { kind: RendererSignal::WidgetEmpty, .. } => {
                self.finish_content("skipped", reason::EMPTY_CONTENT, None, clocks, &mut out);
            }
            Signal::Renderer { kind: RendererSignal::ItemTransition, .. } => {
                self.finish_content("completed", reason::EXPECTED_ITEM_BOUNDARY, None, clocks, &mut out);
            }
            Signal::PlaybackError { item_id, message } => {
                self.finish_content(
                    "failed",
                    reason::RENDERER_FAILURE,
                    Some(("renderer_failure", message)),
                    clocks,
                    &mut out,
                );
                let manifest_version = self.root.as_ref().and_then(|root| root.context.manifest_version);
                out.push(Event::new("renderer.failure", "playback").with(|e| {
                    e.severity = Some("error".into());
                    e.result = Some("failed".into());
                    e.content_id = item_id.clone();
                    e.failure_code = Some("renderer_failure".into());
                    e.failure_message = Some(message.clone());
                    e.manifest_version = manifest_version;
                }));
            }
            Signal::Event(event) => out.push((**event).clone()),
            Signal::Shutdown => self.stop_presentation(reason::PROCESS_EXIT, "partial", clocks, &mut out),
        }
        out
    }
}

fn session_type(context: &ContentContext) -> &'static str {
    if context.playlist_item_id.is_some() { "playlist_item" } else { "content" }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RendererSignal {
    ItemStarted,
    ItemTransition,
    WidgetEmpty,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Presented {
    Playing { context: PresentationContext, replaced: &'static str, items: Vec<ItemInfo> },
    Stopped { reason: &'static str, failed: bool },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Signal {
    Presented(Presented),
    Renderer { kind: RendererSignal, item_id: Option<String> },
    PlaybackError { item_id: Option<String>, message: String },
    Event(Box<Event>),
    Shutdown,
}

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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Persisted {
    tracker: Tracker,
    alive_at_wall_ms: i64,
}

/// The player's time zone, as the Electron player reports it.
pub fn player_timezone() -> String {
    jiff::tz::TimeZone::system().iana_name().map(|name| text(name, 80)).unwrap_or_else(|| "UTC".into())
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

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::atomic::{AtomicI64, AtomicU32};

    use super::*;

    pub(crate) struct FakeClocks {
        pub mono: AtomicI64,
        next: AtomicU32,
    }

    impl FakeClocks {
        pub(crate) fn new() -> Self {
            Self { mono: AtomicI64::new(0), next: AtomicU32::new(0) }
        }
    }

    impl Clocks for FakeClocks {
        fn mono_ms(&self) -> i64 {
            self.mono.load(Ordering::SeqCst)
        }

        fn wall_ms(&self) -> i64 {
            1_800_000_000_000 + self.mono_ms()
        }

        fn uuid(&self) -> String {
            format!("session-{}", self.next.fetch_add(1, Ordering::SeqCst) + 1)
        }
    }

    #[test]
    fn a_crash_leaves_sessions_the_next_start_closes_at_the_last_alive_time() {
        let clocks = FakeClocks::new();
        let mut tracker = Tracker::default();
        let context = PresentationContext {
            key: "direct:p:1".into(),
            presentation_type: "playlist".into(),
            presentation_id: "p".into(),
            trigger: Some("direct".into()),
            schedule_id: None,
            takeover_id: None,
            manifest_version: Some(1),
        };
        let items = vec![ItemInfo { id: "a".into(), kind: "image".into(), duration_ms: Some(4_000) }];
        tracker.apply(
            &Signal::Presented(Presented::Playing { context, replaced: "manifest_replacement", items }),
            &clocks,
        );
        tracker.apply(&Signal::Renderer { kind: RendererSignal::ItemStarted, item_id: Some("a".into()) }, &clocks);
        let stored =
            serde_json::to_string(&Persisted { tracker: tracker.clone(), alive_at_wall_ms: 1_800_000_009_000 })
                .unwrap();
        let Persisted { mut tracker, alive_at_wall_ms } = serde_json::from_str(&stored).unwrap();
        let closed = tracker.close_after_restart(alive_at_wall_ms);
        let reasons: Vec<_> = closed.iter().map(|(_, e)| (e.event_type.as_str(), e.duration_ms)).collect();
        assert_eq!(reasons, vec![("content.completed", Some(9_000)), ("presentation.stopped", Some(9_000))]);
        assert!(closed.iter().all(|(_, e)| e.terminal_reason.as_deref() == Some("player_restart")));
        assert!(tracker.is_empty());
    }

    #[test]
    fn events_are_bounded_to_the_server_limits() {
        let event = Event::new("content.failed", "playback")
            .with(|e| e.failure_message = Some(format!("{}\u{7}", "x".repeat(400))))
            .bounded();
        assert_eq!(event.failure_message.map(|m| m.len()), Some(240));
    }
}
